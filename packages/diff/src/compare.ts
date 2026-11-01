// Plan ↔ fact (T-57.4): the changes a plan diagram planned against the changes a PR made, and what of a PR a diagram
// shows. Done by mag over the vocabulary, not by an LLM: no deterministic change can be argued away.
import { walkArch, type ArchNode, type Diagram } from '@mag/core'
import { names, planChanges } from './plan.ts'
import { LEVELS, isSignificant, significance } from './significance.ts'
import { vocabularyOf } from './vocabulary.ts'
import type { Change, ChangeSet, CompareItem, CompareStatus, Comparison, Coverage, Level } from './types.ts'

const IDENT = /^[A-Za-z_$][\w$]*$/

/** The module of code no module owns, as a fact diagram draws it. */
export const UNOWNED = 'unowned'

/** The diagram id of an outside package `ext:<package>`. */
export const extId = (target: string) => `ext-${target.replace(/^ext:/, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')}`

/** A member of `owner` added or removed with it: `Owner.member` in the same file, with the same mark. */
export const isMemberOf = (m: Change, owner: Change) =>
  m.kind === 'element' && owner.kind === 'element' && (owner.diff === 'add' || owner.diff === 'del') && m.diff === owner.diff && m.path === owner.path && m.name!.startsWith(`${owner.name}.`)

const highest = (levels: (Level | undefined)[]): Level => LEVELS.find((l) => levels.includes(l)) ?? 'medium'

const ORDER: CompareStatus[] = ['differs', 'missing', 'unplanned', 'unchecked', 'match']

/**
 * The plan's changes (planChanges of the step's plan diagrams) against the fact (changes of its PRs), over the
 * project's `architecture`: a plan module stands for its inner modules too. Elements match by ref, else by name in the
 * module; dependencies by their modules; a planned del line and add line of one method are one signature change.
 * Test changes are left out; so are noise changes from unplanned. A plan change without a level gets mag's default.
 */
export function compare(plan: Change[], fact: ChangeSet | ChangeSet[], architecture: ArchNode[]): Comparison {
  const facts = (Array.isArray(fact) ? fact : [fact]).flatMap((cs) => cs.changes).filter((c) => !c.test)
  const inner = new Map<string, Set<string>>()
  walkArch(architecture, (n, ancestors) => {
    inner.set(n.id, new Set([n.id]))
    for (const a of ancestors) inner.get(a.id)!.add(n.id)
  })
  const innerOf = (id: string) => inner.get(id) ?? new Set([id])
  const moduleOf = (c: Change) => c.module ?? UNOWNED
  const within = (m: string, of: string) => innerOf(of).has(m) || (m.startsWith('ext:') && extId(m) === of)
  const coded = new Set([...vocabularyOf(architecture).modules.map((m) => m.id), ...facts.map(moduleOf), ...plan.filter((c) => c.kind === 'module' && c.path).map((c) => c.key)])
  const hasCode = (id: string) => [...innerOf(id)].some((m) => coded.has(m))

  const used = new Set<Change>()
  const items: CompareItem[] = []
  const item = (status: CompareStatus, p: Change | undefined, f: Change[], note?: string) => {
    for (const c of f) used.add(c)
    items.push({ status, ...(p && { plan: p }), fact: f, level: highest([p && (p.level ?? significance(p, [])), ...f.map((c) => c.level)]), ...(note && { note }) })
  }

  // A del line and an add line of one method: one signature change.
  const elements: Change[] = []
  const planned = plan.filter((c) => c.kind === 'element')
  for (const c of planned) {
    const pair = planned.find((o) => o !== c && o.module === c.module && o.name === c.name && o.diff !== c.diff && [o.diff, c.diff].every((d) => d === 'add' || d === 'del'))
    if (!pair) elements.push(c)
    else if (c.diff === 'add') elements.push({ ...c, diff: 'mod', part: 'signature', before: pair.before })
  }
  for (const p of elements) {
    const module = p.module!
    if (!IDENT.test(p.name ?? '') || !hasCode(module)) {
      item('unchecked', p, [])
      continue
    }
    const hits = facts.filter((f) => f.kind === 'element' && !used.has(f) && (f.key === p.key || (within(moduleOf(f), module) && names({ name: f.name! }).includes(p.name!))))
    if (!hits.length) {
      item('missing', p, [])
      continue
    }
    const fits = (f: Change) =>
      p.diff === 'add' ? f.diff === 'add' || f.diff === 'move'
      : p.diff === 'del' ? f.diff === 'del' || f.diff === 'move'
      : p.diff === 'move' ? f.diff === 'move'
      : f.diff === 'mod' && !(p.part === 'signature' && f.part === 'body')
    if (hits.some(fits)) item('match', p, hits)
    else {
      const f = hits[0]
      const how = f.diff === 'mod' ? `mod (${f.part})` : f.diff
      item('differs', p, hits, `planned ${p.diff}${p.part ? ` (${p.part})` : ''}, the code: ${how}`)
    }
  }

  for (const p of plan.filter((c) => c.kind === 'edge')) {
    const [from, to] = [p.module!, p.name!]
    const overlap = [...innerOf(from)].some((m) => innerOf(to).has(m))
    if (p.diff === 'mod' || overlap || !hasCode(from) || !(hasCode(to) || to.startsWith('ext-'))) {
      item('unchecked', p, [])
      continue
    }
    const hits = facts.filter((f) => f.kind === 'edge' && !used.has(f) && within(moduleOf(f), from) && within(f.name!, to))
    if (!hits.length) item('missing', p, [])
    else if (hits.some((f) => f.diff === p.diff)) item('match', p, hits)
    else item('differs', p, hits, `planned ${p.diff}, the code: ${hits[0].diff}`)
  }

  for (const p of plan.filter((c) => c.kind === 'module' && (c.diff === 'add' || c.diff === 'del'))) {
    if (!hasCode(p.key)) {
      item('unchecked', p, [])
      continue
    }
    const hits = facts.filter((f) => f.kind === 'file' && !used.has(f) && within(moduleOf(f), p.key) && f.diff === p.diff)
    item(hits.length ? 'match' : 'missing', p, hits)
  }

  // A planned new or removed class or interface brings its members the plan did not name.
  for (const i of items)
    for (const owner of [...i.fact]) {
      const members = facts.filter((m) => !used.has(m) && isMemberOf(m, owner))
      for (const m of members) used.add(m)
      i.fact.push(...members)
    }

  // The fact nothing planned. A file speaks for itself only when no element of it changed; the members of a new or
  // removed class or interface go with it.
  const withElements = new Set(facts.filter((f) => f.kind === 'element').map((f) => f.path))
  const rest = facts.filter((f) => !used.has(f) && f.level !== 'noise' && !(f.kind === 'file' && withElements.has(f.path)))
  for (const f of rest) {
    if (used.has(f)) continue
    const members = f.kind === 'element' ? rest.filter((m) => !used.has(m) && isMemberOf(m, f)) : []
    item('unplanned', undefined, [f, ...members])
  }

  items.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  return { items }
}

/** What of the fact `diagrams` show: the marked changes of their Component diagrams, matched as compare does. */
export function coverage(fact: ChangeSet | ChangeSet[], diagrams: Diagram[], architecture: ArchNode[]): Coverage {
  const plan = diagrams.flatMap((d) => planChanges(d, [], architecture).changes)
  const { items } = compare(plan, fact, architecture)
  const shown = items.filter((i) => i.status === 'match' || i.status === 'differs').flatMap((i) => i.fact)
  const unshown = items.filter((i) => i.status === 'unplanned').flatMap((i) => i.fact)
  return { shown, unshown }
}

/**
 * Why the review may not say merge (Decision 6): a significant change the plan does not show, or changed code no
 * adapter reads. [] when nothing stands in the way.
 */
export function mergeBlockers(comparison: Comparison, facts: ChangeSet[]): string[] {
  const unshown = comparison.items.filter((i) => i.status === 'unplanned' && i.fact.some(isSignificant))
  return [
    ...unshown.map((i) => `${i.level}: ${describe(i.fact[0])} is not on the plan`),
    ...facts.filter((cs) => !cs.deterministic).map((cs) => `${cs.repo}: no adapter reads ${cs.unparsed.join(', ')}`),
  ]
}

const where = (c: Change) => {
  const h = c.hunks[0]
  if (c.path && c.line) return ` (${c.path}:${c.line})`
  if (h) return ` (${h.path}:${h.newLines ? h.newStart : h.oldStart})`
  return c.path ? ` (${c.path})` : ''
}

/** One change in a few words: what and where. */
export function describe(c: Change): string {
  const module = c.module ?? '(no module)'
  if (c.kind === 'edge') return `dependency ${module} -> ${c.name}`
  if (c.kind === 'module') return `module ${c.key}`
  if (c.kind === 'file') return `file ${c.path}${c.from ? ` (from ${c.from})` : ''}`
  return `${module} ${c.decl ? `${c.decl} ` : ''}${c.name}${c.exported === false ? ' (internal)' : ''}${where(c)}`
}

const factMark = (c: Change) => (c.diff === 'mod' && c.part ? `mod (${c.part})` : c.diff === 'move' ? `move from ${c.from}` : c.diff)

/** The comparison and the threshold as the reviewer reads them. */
export function formatComparison(comparison: Comparison, blockers: string[]): string {
  const lines = [
    blockers.length
      ? `Threshold: merge is NOT allowed (verdict look at most), because:\n${blockers.map((b) => `  - ${b}`).join('\n')}`
      : 'Threshold: merge is allowed (every significant change is on the plan, all changed code is read by an adapter).',
  ]
  const label: Record<CompareStatus, string> = {
    differs: 'Done otherwise than planned',
    missing: 'Planned, not in the code',
    unplanned: 'In the code, not on the plan',
    unchecked: 'Planned where the code cannot tell (check by reading)',
    match: 'Done as planned',
  }
  for (const s of ORDER) {
    const of = comparison.items.filter((i) => i.status === s)
    if (!of.length) continue
    lines.push('', `${label[s]} (${of.length}):`)
    if (s === 'match') {
      lines.push(`  ${of.map((i) => describe(i.plan!).split(' (')[0]).join('; ')}`)
      continue
    }
    for (const i of of) {
      const what = i.plan ? `${factMark(i.plan)} ${describe(i.plan)}` : `${factMark(i.fact[0])} ${describe(i.fact[0])}`
      const fact = i.plan && i.fact.length ? `; the code: ${i.fact.map((f) => `${factMark(f)} ${describe(f)}`).join(', ')}` : ''
      lines.push(`  - [${i.level}] ${what}${fact}`)
    }
  }
  return lines.join('\n')
}
