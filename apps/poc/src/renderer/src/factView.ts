// Plan ↔ fact as Diff shows it (T-57.5, T-58; at plan level since plan-fact-porivniannia-na-rivni.1): what a change is
// in a few words, which files it rests on, and a step's fact in one line.
import type { Change, CompareStatus, FileChange, HunkRef } from '@mag/diff/types'
import { deviationsLine, type StepFact } from '@mag/core'
import type { FactView } from '../../preload/api'

export type FactItem = FactView['items'][number]

/** The order Diff lists a comparison in; match last, folded to one line. */
export const STATUSES: CompareStatus[] = ['differs', 'missing', 'unplanned', 'match']

export const STATUS_ICON: Record<CompareStatus, string> = { differs: '≠', missing: '∅', unplanned: '+', match: '✓' }

export const STATUS_LABEL: Record<CompareStatus, string> = {
  differs: 'otherwise',
  missing: 'missing',
  unplanned: 'unplanned',
  match: 'as planned',
}

/** A change's mark: add, del, mod (signature | body), move from <module>. */
export function mark(c: Change): string {
  if (c.diff === 'mod' && c.part) return `mod (${c.part})`
  if (c.diff === 'move' && c.from) return `move from ${c.from}`
  return c.diff
}

/** What a change is: a module, a dependency, a call, an entity, a field, or a line of a module as drawn. */
export function what(c: Change): string {
  if (c.kind === 'module') return `module ${c.key}`
  if (c.kind === 'entity') return `entity ${c.name}`
  if (c.kind === 'field') return `${c.entityName ?? c.entity}.${c.after ?? c.before ?? c.name}`
  if (c.kind === 'edge') return `${c.module} → ${c.name}`
  if (c.kind === 'call') return `${c.module} → ${c.key.split(' -> ')[1]}`
  return `${c.module} ${c.after ?? c.before ?? c.name}`
}

/** The changed files of the view a change rests on: its `files` as paths or `<repo>:<path>`, in the order given. */
export function filesOf(c: Change, files: FileChange[]): FileChange[] {
  return (c.files ?? []).flatMap((p) => files.filter((f) => f.path === p || `${f.repo}:${f.path}` === p || f.oldPath === p).slice(0, 1))
}

/** A step's deviations from its plan by its recorded counts: done otherwise, missing, off the plan. */
export const deviations = (counts: StepFact['counts']) => counts.differs + counts.missing + counts.unplanned

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * A step's recorded fact in one line, as the collapsed panel says it: 'As planned · +67 additions · 13 outside the
 * plan', or 'N deviations (M backed by the doc)', with what the inventory leaves out. Deviations never block
 * (review-v3-concise-design-first.3); an open step adds ': the fact is not complete' while the inventory has gaps.
 * A fact of an older compare (no deviations) counts them by status.
 */
export function summary(fact: Pick<StepFact, 'counts' | 'blockers' | 'deviations'>, merged: boolean): string {
  const c = fact.counts
  const parts = [fact.deviations ? (fact.deviations.length ? capital(deviationsLine(fact.deviations)) : 'As planned') : deviations(c) ? plural(deviations(c), 'deviation') : 'As planned']
  if (c.additions) parts.push(`+${plural(c.additions, 'addition')}`)
  if (c.outside) parts.push(`${c.outside} outside the plan`)
  if (c.unaccounted) parts.push(`in no unit ${c.unaccounted}`)
  if (c.ungrounded) parts.push(`ungrounded ${c.ungrounded}`)
  return `${parts.join(' · ')}${!merged && fact.blockers.length ? ': the fact is not complete' : ''}`
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Plan ↔ fact as the review window says it (review-v3-concise-design-first.3): one line, never a blocker. */
export function planFactLine(view: Pick<FactView, 'deviations'> | null | undefined, fact: Pick<StepFact, 'deviations'> | null | undefined): string {
  const list = view?.deviations ?? fact?.deviations
  return list ? `Plan ↔ fact: ${deviationsLine(list)}; it never blocks merge.` : 'Plan ↔ fact: not compared yet.'
}

/** A stable key for a file of a repository. */
export const fileKey = (f: Pick<FileChange, 'repo' | 'path'>) => `${f.repo}\0${f.path}`

/** The hunks of a file as stepHunk takes them. */
export const hunksOf = (f: FileChange): HunkRef[] => f.hunks.map((h) => ({ path: f.path, ...h }))
