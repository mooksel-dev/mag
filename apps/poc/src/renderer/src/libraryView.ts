// What the Library section shows of its rows (deliverables-library-claims-review-and.4): kind names, chips, the stored filter.
import type { Label, LabelGroupView } from '@mag/core'
import { DELIVERABLE_KINDS } from '../../main/core/services/deliverables/types.ts'
import type { LibraryFilter, LibraryKind, LibraryRow } from '../../preload/api'

export const LIBRARY_KINDS: LibraryKind[] = [...DELIVERABLE_KINDS, 'change']

/** A kind as the filter and a row's chip name it; decisions of docs and meetings are of kind decision too. */
export const kindName = (k: LibraryKind) => (k === 'change' ? 'Merged change' : k === 'decision' ? 'Decision' : k.charAt(0).toUpperCase() + k.slice(1))

/** A row's labels the workspace has, in the label editor's order (Project first). */
export function rowLabels(row: Pick<LibraryRow, 'labelIds'>, view: LabelGroupView[]): Label[] {
  return view.flatMap((v) => v.labels).filter((l) => row.labelIds.includes(l.id))
}

/** A stored filter, without what is no longer there (a deleted project or label, an unknown kind). */
export function storedFilter(json: string | null, projectIds: string[], labelIds: string[]): LibraryFilter {
  let raw: Record<string, unknown> = {}
  try {
    const v = JSON.parse(json ?? '{}') as unknown
    if (v && typeof v === 'object') raw = v as Record<string, unknown>
  } catch {
    // none stored
  }
  const f: LibraryFilter = {}
  if (LIBRARY_KINDS.includes(raw.kind as LibraryKind)) f.kind = raw.kind as LibraryKind
  if (raw.projectId === null || projectIds.includes(raw.projectId as string)) f.projectId = raw.projectId as string | null
  if (labelIds.includes(raw.labelId as string)) f.labelId = raw.labelId as string
  if (raw.people === true) f.people = true
  return f
}
