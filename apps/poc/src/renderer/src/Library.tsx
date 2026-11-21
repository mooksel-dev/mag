import { useEffect, useState } from 'react'
import { workspaceLabels, type Workspace } from '@mag/core'
import type { AppState, LibraryFilter, LibraryKind, LibraryList, LibraryRow } from '../../preload/api'
import { ago } from './format'
import { LabelChip } from './labels/LabelChips'
import { LIBRARY_KINDS, kindName, rowLabels, storedFilter } from './libraryView'
import { Pill } from './ui/Pill'

const mag = window.mag
/** The list is read again this long after the app's state changes, with the changes that follow. */
const RELOAD_MS = 400

/** The workspace's Library, read again on a filter change, a state change and a meeting's. */
function useLibrary(workspaceId: string, filter: LibraryFilter, state: AppState): LibraryList | null {
  const [list, setList] = useState<LibraryList | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => mag.onMeetingsChanged(() => setVersion((v) => v + 1)), [])
  useEffect(() => {
    const t = setTimeout(() => setVersion((v) => v + 1), RELOAD_MS)
    return () => clearTimeout(t)
  }, [state])
  const key = JSON.stringify(filter)
  useEffect(() => {
    let live = true
    void mag.listLibrary(workspaceId, filter).then((l) => live && setList(l), () => live && setList({ rows: [], hiddenPeople: 0 }))
    return () => {
      live = false
    }
  }, [workspaceId, key, version]) // eslint-disable-line react-hooks/exhaustive-deps
  return list
}

/**
 * The rail's Library (deliverables-library-claims-review-and.4): final and published deliverables, decisions of works
 * and meetings, merged works, newest first, with kind and label chips; filtered by kind, Project and any label.
 * People-sensitive deliverables show only when the filter asks for them. A row opens its topic (with the deliverable),
 * work or meeting.
 */
export function LibrarySection({ workspace, state, onOpen }: { workspace: Workspace; state: AppState; onOpen: (o: LibraryRow['open']) => void }) {
  const view = workspaceLabels(workspace.id, state)
  const projects = view.find((v) => v.group.system === 'project')?.labels ?? []
  const labels = view.filter((v) => !v.group.system).flatMap((v) => v.labels)
  const storeKey = `mag.library.${workspace.id}`
  const [filter, setFilterState] = useState<LibraryFilter>(() => storedFilter(localStorage.getItem(storeKey), projects.map((p) => p.id), labels.map((l) => l.id)))
  const setFilter = (patch: Partial<LibraryFilter>) => {
    const next = { ...filter, ...patch }
    for (const k of Object.keys(next) as (keyof LibraryFilter)[]) if (next[k] === undefined || next[k] === false) delete next[k]
    setFilterState(next)
    try { localStorage.setItem(storeKey, JSON.stringify(next)) } catch { /* ignore */ }
  }
  const list = useLibrary(workspace.id, filter, state)
  const project = filter.projectId === undefined ? '' : filter.projectId ?? '-'
  return (
    <nav className="worklist" aria-label="Library">
      <div className="wlhead2">
        <span className="colhead2">Library</span>
        <div className="libfilters">
          <select aria-label="Kind" value={filter.kind ?? ''} onChange={(e) => setFilter({ kind: (e.target.value || undefined) as LibraryKind | undefined })}>
            <option value="">Any kind</option>
            {LIBRARY_KINDS.map((k) => <option key={k} value={k}>{kindName(k)}</option>)}
          </select>
          <select aria-label="Project" value={project} onChange={(e) => setFilter({ projectId: e.target.value === '' ? undefined : e.target.value === '-' ? null : e.target.value })}>
            <option value="">Any project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="-">No project</option>
          </select>
          {labels.length > 0 && (
            <select aria-label="Label" value={filter.labelId ?? ''} onChange={(e) => setFilter({ labelId: e.target.value || undefined })}>
              <option value="">Any label</option>
              {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          <label className="small" title="Deliverables about a person, such as assessments">
            <input type="checkbox" checked={!!filter.people} onChange={(e) => setFilter({ people: e.target.checked })} /> People-sensitive
          </label>
        </div>
      </div>
      <div className="wlscroll" role="list" aria-label="Library rows">
        {list && !list.rows.length && <p className="muted small pad">{Object.keys(filter).length ? 'Nothing matches.' : 'Nothing final yet: deliverables marked final, decisions of works and meetings, and merged works show here.'}</p>}
        {list?.rows.map((r) => (
          <button key={r.key} role="listitem" className="mtghit librow" title={r.source === 'deliverable' ? r.title : `${r.title}\n${r.text}`} onClick={() => onOpen(r.open)}>
            <span className="mtgtop"><span className="mtgtitle">{r.source === 'doc' || r.source === 'meeting' ? r.text : r.title}</span><span className="wltime">{ago(r.at)}</span></span>
            <span className="libchips">
              <Pill>{kindName(r.kind)}</Pill>
              {r.people && <Pill tone="amber">people</Pill>}
              {rowLabels(r, view).map((l) => <LabelChip key={l.id} label={l} />)}
              {r.tags.map((t) => <LabelChip key={`tag:${t}`} label={{ name: t, color: 'var(--line)' }} muted />)}
              <span className="mtgsnip">{r.source === 'doc' || r.source === 'meeting' ? r.title : r.text}</span>
            </span>
          </button>
        ))}
        {!!list?.hiddenPeople && !filter.people && (
          <button className="wlfold" onClick={() => setFilter({ people: true })}>{list.hiddenPeople} people-sensitive hidden: show</button>
        )}
      </div>
    </nav>
  )
}
