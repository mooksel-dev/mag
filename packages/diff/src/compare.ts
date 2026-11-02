// Plan ↔ fact (T-57.4, T-58): the changes a step's plan diagrams draw against those its fact diagram draws, which
// changed files the fact shows, and whether each line of the fact rests on the PR's files. Done by mag, not by an LLM.
import { walkArch, type ArchNode, type Diagram } from '@mag/core'
import { diagramChanges } from './plan.ts'
import { LEVELS, isSignificant, significance } from './significance.ts'
import { moduleResolver, planVocabulary } from './vocabulary.ts'
import type { Change, CompareItem, CompareStatus, Comparison, Coverage, FileChange, Grounding, Level } from './types.ts'

const highest = (levels: (Level | undefined)[]): Level => LEVELS.find((l) => levels.includes(l)) ?? 'medium'

const ORDER: CompareStatus[] = ['differs', 'missing', 'unplanned', 'match']

/** Each module of the trees (the architecture, a diagram that adds modules to it) with itself and its inner modules. */
function innerModules(...trees: { id: string; uses: unknown[]; children?: unknown[] }[][]): (id: string) => Set<string> {
  const inner = new Map<string, Set<string>>()
  for (const tree of trees)
    walkArch(tree as ArchNode[], (n, ancestors) => {
      if (!inner.has(n.id)) inner.set(n.id, new Set([n.id]))
      for (const a of ancestors) inner.get(a.id)!.add(n.id)
    })
  return (id) => inner.get(id) ?? new Set([id])
}

const modulesOf = (d: Diagram) => (d.type === 'component' ? d.modules : [])

/** What a change is, without its module: `line`, `-> to`, `-> to#call`. */
const tail = (c: Change) => (c.kind === 'module' ? '' : c.kind === 'element' ? `#${c.name}` : c.kind === 'edge' ? ` -> ${c.name}` : ` -> ${c.key.split(' -> ')[1]}`)

/**
 * The plan's changes (diagramChanges of the step's plan diagrams) against the fact's (of its fact diagram), over the
 * project's `architecture`. The fact is a revision of the plan (Decision 9), so changes match by key; a plan change on
 * a module also matches the same change drawn on one of its inner modules. Levels are the higher of the two.
 */
export function compare(plan: Change[], fact: Change[], architecture: ArchNode[]): Comparison {
  const innerOf = innerModules(architecture)
  const used = new Set<Change>()
  const items: CompareItem[] = []
  const item = (status: CompareStatus, p: Change | undefined, f: Change | undefined, note?: string) => {
    if (f) used.add(f)
    items.push({ status, ...(p && { plan: p }), ...(f && { fact: f }), level: highest([p && (p.level ?? significance(p, [])), f && (f.level ?? significance(f, []))]), ...(note && { note }) })
  }
  const same = (a?: string, b?: string) => (a ?? '').replace(/\s+/g, '') === (b ?? '').replace(/\s+/g, '')
  for (const p of plan) {
    const f =
      fact.find((c) => !used.has(c) && c.key === p.key) ??
      fact.find((c) => !used.has(c) && c.kind === p.kind && c.module !== p.module && innerOf(p.module).has(c.module) && tail(c) === tail(p))
    if (!f) item('missing', p, undefined)
    else if (f.diff !== p.diff || (p.part && f.part && p.part !== f.part)) item('differs', p, f, `planned ${mark(p)}, done ${mark(f)}`)
    else if (!same(p.after, f.after) || !same(p.before, f.before)) item('differs', p, f, `planned ${p.after ?? p.before}, done ${f.after ?? f.before}`)
    else item('match', p, f)
  }
  for (const f of fact) if (!used.has(f) && f.level !== 'noise') item('unplanned', undefined, f)
  items.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  return { items }
}

/**
 * The changed files a path a fact gives stands for: `<repo>:<path>` that file of that repo; a plain path every file
 * of the PR with that path (at head, or at base when renamed), so it is ambiguous when two repositories change it.
 */
function fileRefs(files: FileChange[]): (ref: string) => FileChange[] {
  const repos = new Set(files.map((f) => f.repo))
  return (ref) => {
    const at = ref.indexOf(':')
    const repo = at > 0 ? ref.slice(0, at) : ''
    const path = repos.has(repo) ? ref.slice(at + 1) : ref
    return files.filter((f) => (path === f.path || path === f.oldPath) && (!repos.has(repo) || f.repo === repo))
  }
}

/**
 * Which changed code files a fact diagram shows (Decisions 2, 11): a file is shown only when a changed line, use or
 * call of the diagram gives it in `files`; a module marked changed without such lines shows none. A plain path two
 * repositories change shows neither: it takes `<repo>:<path>` (Decision 13).
 */
export function coverage(files: FileChange[], fact: Diagram): Coverage {
  const refs = fileRefs(files)
  const shown = new Set(diagramChanges(fact).flatMap((c) => (c.files ?? []).map(refs).filter((hit) => hit.length === 1).flat()))
  const code = files.filter((f) => f.kind === 'code')
  return { shown: code.filter((f) => shown.has(f)), unshown: code.filter((f) => !shown.has(f)) }
}

/**
 * Whether each changed line, dependency and call of a fact diagram rests on the PR (Decision 9): it gives `files`,
 * each one a file the PR changes (`path`, or `<repo>:<path>` when two repositories change that path, Decision 13),
 * owned by the line's module or one inside it. A file no module owns may stand behind any line. Module marks are not
 * lines: they are neither grounded nor show files.
 */
export function grounding(fact: Diagram, files: FileChange[], architecture: ArchNode[]): Grounding {
  const innerOf = innerModules(architecture, modulesOf(fact))
  // A module the fact adds with a path owns its files too.
  const ownerOf = moduleResolver(planVocabulary(architecture, [fact]))
  const refs = fileRefs(files)
  const out: Grounding = { grounded: [], unverified: [] }
  for (const c of diagramChanges(fact)) {
    if (c.kind === 'module') continue
    const given = c.files ?? []
    if (!given.length) {
      out.unverified.push({ change: c, reason: 'no-files', files: [] })
      continue
    }
    const outside = given.filter((p) => !refs(p).length)
    if (outside.length) {
      out.unverified.push({ change: c, reason: 'not-in-pr', files: outside })
      continue
    }
    const ambiguous = given.filter((p) => refs(p).length > 1)
    if (ambiguous.length) {
      out.unverified.push({ change: c, reason: 'ambiguous', files: ambiguous })
      continue
    }
    const elsewhere = given.filter((p) => {
      const owner = ownerOf(refs(p)[0].path)
      return owner && !innerOf(c.module).has(owner)
    })
    if (elsewhere.length) out.unverified.push({ change: c, reason: 'other-module', files: elsewhere })
    else out.grounded.push(c)
  }
  return out
}

/**
 * Why the review may not say merge (Decision 5): a changed code file the fact does not show, a line of the fact that
 * does not rest on the PR, or a significant difference between plan and fact. [] when nothing stands in the way.
 */
export function mergeBlockers(comparison: Comparison, cover: Coverage | null, ground: Grounding | null): string[] {
  const where = (f: FileChange) => (f.repo ? `${f.repo}:${f.path}` : f.path)
  return [
    ...(cover && ground ? [] : ['there is no fact diagram of the PRs yet']),
    ...(cover?.unshown ?? []).map((f) => `${where(f)} (${f.module ?? 'no module'}) is changed, the fact diagram does not show it`),
    ...(ground?.unverified ?? []).map((u) => `${describe(u.change)}: ${UNVERIFIED[u.reason]}${u.files.length ? ` (${u.files.join(', ')})` : ''}`),
    ...comparison.items.filter((i) => i.status !== 'match' && isSignificant(i)).map((i) => `${i.level}: ${describe((i.plan ?? i.fact)!)} ${BLOCKS[i.status]}`),
  ]
}

const UNVERIFIED = {
  'no-files': 'gives no files of the PR',
  'not-in-pr': 'gives files the PR does not change',
  ambiguous: 'gives a path several repositories change: write <repo>:<path>',
  'other-module': 'gives files of another module',
}
const BLOCKS: Record<CompareStatus, string> = { differs: 'is done otherwise than planned', missing: 'is planned, not on the fact', unplanned: 'is on the fact, not on the plan', match: '' }

const mark = (c: Change) => (c.diff === 'mod' && c.part ? `mod (${c.part})` : c.diff === 'move' && c.from ? `move from ${c.from}` : c.diff)

/** One change in a few words: what and where. */
export function describe(c: Change): string {
  if (c.kind === 'module') return `module ${c.key}`
  if (c.kind === 'edge') return `dependency ${c.module} -> ${c.name}`
  if (c.kind === 'call') return `call ${c.key}`
  return `${c.module} ${c.after ?? c.before ?? c.name}`
}

/** The comparison and the threshold as the reviewer reads them. */
export function formatComparison(comparison: Comparison, blockers: string[]): string {
  const lines = [
    blockers.length
      ? `Threshold: merge is NOT allowed (verdict look at most), because:\n${blockers.map((b) => `  - ${b}`).join('\n')}`
      : 'Threshold: merge is allowed (every changed code file is shown, every line of the fact rests on the PR, plan and fact agree on what matters).',
  ]
  const label: Record<CompareStatus, string> = {
    differs: 'Done otherwise than planned',
    missing: 'Planned, not on the fact',
    unplanned: 'On the fact, not on the plan',
    match: 'Done as planned',
  }
  for (const s of ORDER) {
    const of = comparison.items.filter((i) => i.status === s)
    if (!of.length) continue
    lines.push('', `${label[s]} (${of.length}):`)
    if (s === 'match') {
      lines.push(`  ${of.map((i) => describe(i.plan!)).join('; ')}`)
      continue
    }
    for (const i of of) {
      const c = (i.plan ?? i.fact)!
      lines.push(`  - [${i.level}] ${mark(c)} ${describe(c)}${i.note ? `; ${i.note}` : ''}`)
    }
  }
  return lines.join('\n')
}
