// Plan ↔ fact (T-57.4, T-58): the changes a step's plan diagrams draw against those of its fact, generated from the
// change inventory (diff-iak-inventar-zmin-ai.1). Done by mag, not by an LLM.
import { walkArch, type ArchNode } from '@mag/core'
import { LEVELS, isSignificant, significance } from './significance.ts'
import type { Change, CompareItem, CompareStatus, Comparison, Level } from './types.ts'

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

/** What a change is, without its module: `line`, `-> to`, `-> to#call`. */
const tail = (c: Change) => (c.kind === 'module' ? '' : c.kind === 'element' ? `#${c.name}` : c.kind === 'edge' ? ` -> ${c.name}` : ` -> ${c.key.split(' -> ')[1]}`)

/**
 * The plan's changes (diagramChanges of the step's plan diagrams) against the fact's (of its fact diagram), over the
 * project's `architecture`. Changes match by key; a plan change on a module also matches the same change on one of its
 * inner modules. The fact's lines are generated from the inventory, so their text is not the plan's: the same mark is
 * a match, and a signature that reads otherwise is its note. Levels are the higher of the two.
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
    else if (!same(p.after, f.after) || !same(p.before, f.before)) item('match', p, f, `planned ${p.after ?? p.before}, done ${f.after ?? f.before}`)
    else item('match', p, f)
  }
  for (const f of fact) if (!used.has(f) && f.level !== 'noise') item('unplanned', undefined, f)
  items.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  return { items }
}

/**
 * Why the review may not say merge (Decision 5): what the fact itself blocks on (no inventory yet, its check against
 * the hunks: diff-iak-inventar-zmin-ai.1), then a significant difference between plan and fact. [] when nothing does.
 */
export function mergeBlockers(comparison: Comparison, fact: string[]): string[] {
  return [...fact, ...comparison.items.filter((i) => i.status !== 'match' && isSignificant(i)).map((i) => `${i.level}: ${describe((i.plan ?? i.fact)!)} ${BLOCKS[i.status]}`)]
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
      : 'Threshold: merge is allowed (the inventory accounts for every block of changed code and rests on its hunks, plan and fact agree on what matters).',
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
