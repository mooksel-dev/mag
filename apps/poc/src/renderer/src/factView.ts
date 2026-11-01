// Plan ↔ fact as Diff shows it (T-57.5): what a change is in a few words, where its code is, and what folds away.
import type { Change, CompareStatus, HunkRef, Level } from '@mag/diff/types'
import type { FactView } from '../../preload/api'

export type FactItem = FactView['items'][number]

/** The order Diff lists a comparison in; match last, folded to one line. */
export const STATUSES: CompareStatus[] = ['differs', 'missing', 'unplanned', 'unchecked', 'match']

export const STATUS_ICON: Record<CompareStatus, string> = { differs: '≠', missing: '∅', unplanned: '+', unchecked: '?', match: '✓' }

export const STATUS_LABEL: Record<CompareStatus, string> = {
  differs: 'otherwise',
  missing: 'missing',
  unplanned: 'unplanned',
  unchecked: 'unchecked',
  match: 'as planned',
}

/** Levels that fold unless the user asks for all. */
export const isFolded = (level: Level | undefined) => level === 'low' || level === 'noise'

/** critical and high: what the threshold and the reviewer care about (SIGNIFICANT in @mag/diff). */
export const isSignificant = (level: Level | undefined) => level === 'critical' || level === 'high'

/** A change's mark: add, del, mod (signature | body), move from <old>. */
export function mark(c: Change): string {
  if (c.diff === 'mod' && c.part) return `mod (${c.part})`
  if (c.diff === 'move' && c.from) return `move from ${c.from.replace(/^[^:]*:/, '')}`
  return c.diff
}

/** What a change is about, without its place: `<module> <decl> <name>`, a dependency, a file or a module. */
export function what(c: Change): string {
  const module = c.module ?? '(no module)'
  if (c.kind === 'edge') return `${module} → ${c.name}`
  if (c.kind === 'module') return `module ${c.key}`
  if (c.kind === 'file') return `file ${c.path}`
  return `${module} ${c.decl ? `${c.decl} ` : ''}${c.name}${c.exported === false ? ' (internal)' : ''}`
}

/** Where a change's code is: its first hunk with a `path:line` label; null when it has none (e.g. a planned change). */
export function where(c: Change): { label: string; hunk: HunkRef } | null {
  const hunk = c.hunks[0]
  if (!hunk) return null
  const line = c.line ?? (hunk.newLines ? hunk.newStart : hunk.oldStart)
  return { label: `${hunk.path}:${line}`, hunk }
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

/** A stable key for a hunk of a repository. */
export const hunkKey = (repo: string, h: HunkRef) => `${repo}\0${h.path}\0${h.oldStart},${h.oldLines}\0${h.newStart},${h.newLines}`
