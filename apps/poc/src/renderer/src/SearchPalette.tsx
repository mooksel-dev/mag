import { useEffect, useMemo, useRef, useState } from 'react'
import { workspaceLabels, type Workspace } from '@mag/core'
import type { AppState, PaletteResult } from '../../preload/api'
import type { Hit } from '../../main/core/services/search/types.ts'
import { canReference, referenceInCurrentChat } from './Chat'
import { threadTime } from './format'
import { LabelChip } from './labels/LabelChips'
import { PALETTE_TABS, countText, labelQuery, snippetParts, sourceLine, type PaletteTab } from './searchView'
import { Icon } from './ui/Icon'
import { Seg } from './ui/Seg'

const mag = window.mag
/** As main's PALETTE_LIMIT: a tab this full shows "50+". */
const LIMIT = 50
const DELAY_MS = 120

/**
 * The search palette (unified-search-across-the-workspace.2), ⌘K and the rail's Search: one index of topics, docs,
 * decisions, meetings, deliverables and people, this workspace by default or all of them. Tabs per kind with counts,
 * label filters, People (person rows) off by default. Each hit shows its source and time. ↑↓ move, Tab the next kind,
 * ↵ opens the source, ⌘↵ references the hit in the open topic, Esc closes.
 */
export function SearchPalette({ workspace, state, onOpen, onClose }: {
  workspace: Workspace
  state: AppState
  /** Opens the hit's source; returns why it can't, or null. */
  onOpen: (hit: Hit) => string | null
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<PaletteTab>('all')
  const [scope, setScope] = useState<'workspace' | 'all'>('workspace')
  const [people, setPeople] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const groups = useMemo(() => workspaceLabels(workspace.id, state), [workspace.id, state])
  const labelsById = useMemo(() => new Map(groups.flatMap((g) => g.labels).map((l) => [l.id, l])), [groups])
  const labels = labelQuery(picked, groups)
  const labelsKey = JSON.stringify(labels ?? null)
  // The result of the last query answered: typing stays responsive while it catches up.
  const [shown, setShown] = useState<{ query: string; result: PaletteResult | null }>({ query: '', result: null })
  useEffect(() => {
    let current = true
    const q = query
    if (!q.trim()) {
      setShown({ query: q, result: null })
      return
    }
    const t = setTimeout(() => {
      mag.searchWorkspace(q, { workspaceId: workspace.id, scope: scope === 'all' ? 'all' : undefined, labels: JSON.parse(labelsKey) ?? undefined, people })
        .then((result) => current && setShown({ query: q, result }), () => current && setShown({ query: q, result: null }))
    }, DELAY_MS)
    return () => {
      current = false
      clearTimeout(t)
    }
  }, [query, workspace.id, scope, labelsKey, people])
  const { result } = shown
  const hits = result ? (tab === 'all' ? result.all : result.byKind[tab]) : []
  const at = Math.min(active, Math.max(hits.length - 1, 0))
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at, shown, tab])
  const ctx = { workspaceId: workspace.id, workspaces: state.workspaces, projects: state.projects, labels: state.labels, deliverables: state.deliverables ?? [] }

  const open = (h: Hit | undefined) => {
    if (!h) return
    const why = onOpen(h)
    if (why) setNote(why)
    else onClose()
  }
  const reference = (h: Hit | undefined) => {
    if (!h) return
    const ref = { kind: 'hit' as const, id: h.ref, title: h.title }
    if (!canReference(ref)) return setNote('Open a topic first: ⌘↵ adds the hit to its message as a reference.')
    referenceInCurrentChat(ref)
    onClose()
  }
  const moveTab = (by: number) => {
    const i = PALETTE_TABS.findIndex((t) => t.id === tab)
    setTab(PALETTE_TABS[(i + by + PALETTE_TABS.length) % PALETTE_TABS.length].id)
    setActive(0)
  }
  const count = (t: PaletteTab) => (result ? countText((t === 'all' ? result.all : result.byKind[t]).length, LIMIT) : '')
  const now = Date.now()
  return (
    <>
      <div className="spscrim" onClick={onClose} />
      <div className="spalette" role="dialog" aria-label="Search">
        <input
          autoFocus
          type="search"
          value={query}
          placeholder={`Search ${scope === 'all' ? 'every workspace' : workspace.name}: topics, docs, decisions, meetings, deliverables`}
          aria-label="Search"
          aria-controls="sphits"
          onChange={(e) => { setQuery(e.target.value); setActive(0); setNote(null) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(at + 1, hits.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(at - 1, 0)) }
            else if (e.key === 'Tab') { e.preventDefault(); moveTab(e.shiftKey ? -1 : 1) }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reference(hits[at]) }
            else if (e.key === 'Enter') { e.preventDefault(); open(hits[at]) }
            else if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }}
        />
        <div className="spfilters">
          <Seg<'workspace' | 'all'> label="Scope" value={scope} onChange={(v) => { setScope(v); setActive(0) }} options={[{ value: 'workspace', label: workspace.name, title: 'This workspace and the meetings' }, { value: 'all', label: 'All workspaces' }]} />
          <button type="button" className={`small sppeople${people ? ' on' : ''}`} aria-pressed={people} title="Person rows (who is who) are left out unless this is on" onClick={() => { setPeople(!people); setActive(0) }}>People</button>
          {picked.map((id) => labelsById.get(id) && (
            <span key={id} className="splabel">
              <LabelChip label={labelsById.get(id)!} />
              <button type="button" className="x" aria-label={`Remove the filter ${labelsById.get(id)!.name}`} onClick={() => setPicked(picked.filter((x) => x !== id))}><Icon name="x" size={12} /></button>
            </span>
          ))}
          <select aria-label="Filter by label" value="" onChange={(e) => { if (e.target.value) setPicked([...picked, e.target.value]); setActive(0) }}>
            <option value="">+ Label</option>
            {groups.map(({ group, labels: ls }) => ls.some((l) => !picked.includes(l.id)) && (
              <optgroup key={group.id} label={group.name}>
                {ls.filter((l) => !picked.includes(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {shown.query.trim() && (
          <>
            <div className="sptabs" role="tablist" aria-label="Kinds">
              {PALETTE_TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} className={t.id === tab ? 'on' : ''} onClick={() => { setTab(t.id); setActive(0) }}>
                  {t.label} <span className="spcount">{count(t.id)}</span>
                </button>
              ))}
            </div>
            <div className="sphits" id="sphits" role="listbox" aria-label="Results" ref={list}>
              {hits.map((h, i) => (
                <button key={h.ref} role="option" aria-selected={i === at} className={`sphit${i === at ? ' on' : ''}`} title={h.ref} onClick={(e) => (e.metaKey || e.ctrlKey ? reference(h) : open(h))} onMouseMove={() => i !== at && setActive(i)}>
                  <span className="sptop">
                    <span className="title">{h.title}</span>
                    <span className="sptime">{threadTime(h.at, now)}</span>
                  </span>
                  <span className="spsource">{sourceLine(h, ctx)}</span>
                  {h.snippet && <span className="spline">{snippetParts(h.snippet).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}</span>}
                </button>
              ))}
              {!hits.length && <p className="muted small spempty">{tab === 'person' && !people ? 'Turn People on to search persons.' : 'Nothing matches.'}</p>}
            </div>
          </>
        )}
        {note && <p className="small spnote" role="status">{note}</p>}
        <div className="spkeys muted small">↵ open · ⌘↵ reference in the open topic · Tab next kind · Esc close</div>
      </div>
    </>
  )
}
