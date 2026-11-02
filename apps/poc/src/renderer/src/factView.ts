// Plan ↔ fact as Diff shows it (T-57.5, T-58): what a change is in a few words, which files it rests on, whether it is
// verified, and what folds away.
import type { Change, CompareStatus, FileChange, HunkRef, Level } from '@mag/diff/types'
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

/** Levels that fold unless the user asks for all. */
export const isFolded = (level: Level | undefined) => level === 'low' || level === 'noise'

/** critical and high: what the threshold and the reviewer care about (SIGNIFICANT in @mag/diff). */
export const isSignificant = (level: Level | undefined) => level === 'critical' || level === 'high'

/** A change's mark: add, del, mod (signature | body), move from <module>. */
export function mark(c: Change): string {
  if (c.diff === 'mod' && c.part) return `mod (${c.part})`
  if (c.diff === 'move' && c.from) return `move from ${c.from}`
  return c.diff
}

/** What a change is: a module, a dependency, a call, or a line of a module as drawn. */
export function what(c: Change): string {
  if (c.kind === 'module') return `module ${c.key}`
  if (c.kind === 'edge') return `${c.module} → ${c.name}`
  if (c.kind === 'call') return `${c.module} → ${c.key.split(' -> ')[1]}`
  return `${c.module} ${c.after ?? c.before ?? c.name}`
}

/** The changed files of the view a change rests on: its `files` as paths or `<repo>:<path>`, in the order given. */
export function filesOf(c: Change, files: FileChange[]): FileChange[] {
  return (c.files ?? []).flatMap((p) => files.filter((f) => f.path === p || `${f.repo}:${f.path}` === p || f.oldPath === p).slice(0, 1))
}

/** Why a change of the fact is not verified, in a few words; null when it rests on the PR or is not the fact's. */
export function unverified(c: Change, view: Pick<FactView, 'unverified'>): string | null {
  const u = view.unverified.find((x) => x.change.key === c.key && x.change.diff === c.diff)
  if (!u) return null
  const files = u.files.join(', ')
  if (u.reason === 'no-files') return 'unverified: no files'
  if (u.reason === 'not-in-pr') return `unverified: not in the PR (${files})`
  if (u.reason === 'ambiguous') return `unverified: in several repos, give <repo>:<path> (${files})`
  return `unverified: another module's (${files})`
}

/** The rows Diff lists: changes to look at by status and level; low / noise and matches counted apart. */
export function rows(items: FactItem[], all: boolean): { shown: FactItem[]; matches: FactItem[]; folded: number } {
  const open = items.filter((i) => i.status !== 'match')
  const shown = all ? open : open.filter((i) => !isFolded(i.level))
  return { shown, matches: items.filter((i) => i.status === 'match'), folded: open.length - shown.length }
}

/** Counts per status, in Diff's order, without the empty ones. */
export function statusCounts(items: FactItem[]): { status: CompareStatus; count: number }[] {
  return STATUSES.map((status) => ({ status, count: items.filter((i) => i.status === status).length })).filter((c) => c.count > 0)
}

/** A stable key for a file of a repository. */
export const fileKey = (f: Pick<FileChange, 'repo' | 'path'>) => `${f.repo}\0${f.path}`

/** The hunks of a file as stepHunk takes them. */
export const hunksOf = (f: FileChange): HunkRef[] => f.hunks.map((h) => ({ path: f.path, ...h }))
