import { useEffect, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from 'react'
import {
  CARD_FILTERS,
  CARD_FILTER_LABELS,
  addGroup,
  canCancel,
  cardFilter,
  cardRef,
  groupKey,
  moveRef,
  removeGroup,
  renameGroup,
  searchCards,
  sidebarRows,
  toggleGroup,
  workCards,
  type CardFilter,
  type Project,
  type SidebarGroup,
  type SidebarNode,
  type WorkCard,
} from '@mag/core'
import type { AppState, CrashReport, PickerMode } from '../../preload/api'
import { crashMarkdown, threadTime } from './format'
import { ProjectPicker, ProjectSquare } from './Picker'
import { useNow } from './Tasks'

const mag = window.mag

/** What the list has open: a work (a review too) or a topic without a work. */
export type Selection = { kind: 'work' | 'topic'; id: string }

/** The selection a card opens. */
export const cardSelection = (c: WorkCard): Selection => ({ kind: c.kind === 'topic' ? 'topic' : 'work', id: c.id })

/** Pages the footer opens in place of the conversation. */
export type ListPage = 'ideas' | 'architecture' | 'settings'

/** A group the user starts something in (its +): Home puts what it creates first in that group. */
export interface HomeGroup { id: string; name: string }

/** The filter the list shows, per project; it only hides rows. */
function useFilter(projectId: string): [CardFilter, (f: CardFilter) => void] {
  const key = `mag.worklist.filter.${projectId}`
  const [filter, setFilter] = useState<CardFilter>(() => {
    const f = localStorage.getItem(key) as CardFilter | null
    return f && CARD_FILTERS.includes(f) ? f : 'all'
  })
  const set = (f: CardFilter) => {
    setFilter(f)
    try { localStorage.setItem(key, f) } catch { /* ignore */ }
  }
  return [filter, set]
}

/** Where a drop puts what is dragged: into a group (or the top level) before a key, or at the end. */
type Drop = { groupId: string | null; before: string | null }

/**
 * The sidebar in the user's order (redesign-start-screen-big-composer.2, decision 9): the project switcher, ＋ New
 * (Home), search (⌘K) and filters, then one list laid out by core sidebarRows from project.sidebar. Nothing re-sorts:
 * rows and groups move only by drag & drop, a new item shows on top; status is a badge; filters and search only hide;
 * closed items are under Closed at the bottom. Groups are the user's (create, rename, collapse, delete, + starts something
 * in one). Each row has a ⋯ menu, also on right-click.
 */
export function WorkList({ project, state, selected, home, page, picker, onPicker, onSelect, onNew, onNewIn, onOpenPage }: {
  project: Project
  state: AppState
  selected: Selection | null
  /** Home is open: ＋ New is the current row. */
  home: boolean
  page: ListPage | null
  picker: PickerMode | null
  onPicker: (m: PickerMode | null) => void
  onSelect: (s: Selection) => void
  onNew: () => void
  /** A group's +: Home, creating into that group. */
  onNewIn: (g: HomeGroup) => void
  onOpenPage: (p: ListPage) => void
}) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const all = workCards(project.id, tasks, state.sessions, now)
  const [filter, setFilter] = useFilter(project.id)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const shown = new Set(searchCards(cardFilter(all, filter), query))
  const sidebar = sidebarRows(project.sidebar ?? [], all, (c) => shown.has(c))
  const open = all.filter((c) => !c.closed)
  const ideas = state.ideas.filter((i) => i.projectId === project.id).length
  const [showClosed, setShowClosed] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const [crash, setCrash] = useState<CrashReport | null>(null)
  useEffect(() => {
    mag.lastCrash().then(setCrash, () => {})
  }, [])
  // ⌘K: search the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      search.current?.focus()
      search.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const searching = !!query.trim()
  const hiding = searching || filter !== 'all'
  const save = (layout: SidebarNode[]) => void mag.updateProject(project.id, { sidebar: layout })
  const edit = (f: (layout: SidebarNode[]) => SidebarNode[]) => save(f(sidebar.layout))
  // What the selection was is gone (deleted): Home.
  const gone = (c: WorkCard) => { if (selected?.id === c.id) onNew() }

  /** Drops what is dragged: a group only at the top level (dropped on a row of a group: before that group). */
  const drop = (to: Drop) => {
    const key = drag
    setDrag(null)
    setOver(null)
    if (!key || key === to.before) return
    const isGroup = key.startsWith('group:')
    let { groupId, before } = to
    if (isGroup && groupId) { before = groupKey(groupId); groupId = null }
    const list = groupId
      ? (sidebar.layout.find((n) => n.kind === 'group' && n.id === groupId) as Extract<SidebarNode, { kind: 'group' }>).items
      : sidebar.layout.map((n) => (n.kind === 'group' ? groupKey(n.id) : n.ref))
    const rest = list.filter((k) => k !== key)
    const at = before === null ? rest.length : rest.indexOf(before)
    edit((l) => moveRef(l, key, groupId, at < 0 ? rest.length : at))
  }
  const target = (id: string, to: Drop) => ({
    onDragOver: (e: DragEvent) => { if (!drag) return; e.preventDefault(); e.stopPropagation(); setOver(id) },
    onDrop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); drop(to) },
  })
  const source = (key: string) => ({
    draggable: !hiding,
    onDragStart: (e: DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); setMenu(null); setDrag(key) },
    onDragEnd: () => { setDrag(null); setOver(null) },
  })
  const row = (c: WorkCard, groupId: string | null) => {
    const ref = cardRef(c)
    return (
      <Row
        key={ref}
        card={c}
        now={now}
        on={selected?.id === c.id}
        menu={menu === ref}
        over={over === ref}
        drag={c.closed ? {} : { ...source(ref), ...target(ref, { groupId, before: ref }) }}
        onMenu={(o) => setMenu(o ? ref : null)}
        onSelect={onSelect}
        onGone={() => gone(c)}
      />
    )
  }
  const newGroup = () => {
    const id = Math.random().toString(36).slice(2, 10)
    edit((l) => addGroup(l, 'New group', id))
    setNaming(id)
  }
  const empty = !open.length
  return (
    <nav className="worklist" aria-label="Works">
      <div className="wlhead2">
        <div className="projmenu">
          <button className="projbtn" aria-haspopup="dialog" aria-expanded={!!picker} title="Switch project (⌘O)" onClick={() => onPicker(picker ? null : 'open')}>
            <ProjectSquare project={project} />
            <span className="pname">{project.name}</span>
            <span className="caret" aria-hidden>▾</span>
          </button>
          {picker && <ProjectPicker key={picker} state={state} currentId={project.id} mode={picker} onClose={() => onPicker(null)} />}
        </div>
        <button className={`newbtn${home ? ' on' : ''}`} aria-current={home ? 'page' : undefined} title="Ask, describe a task, review a PR or start from a ticket" onClick={onNew}>
          ＋ New <kbd>⌘N</kbd>
        </button>
        <label className="wlsearch">
          <span aria-hidden>⌕</span>
          <input
            ref={search}
            type="search"
            value={query}
            placeholder="Search works and chats"
            aria-label="Search works and chats"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }}
          />
          {!searching && <kbd>⌘K</kbd>}
        </label>
        {open.length > 0 && (
          <div className="wlfilters" role="tablist" aria-label="Filter works">
            {CARD_FILTERS.map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {CARD_FILTER_LABELS[f]} <span className="count">{cardFilter(open, f).length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="wlscroll">
        {crash && <CrashRow crash={crash} onDismiss={() => mag.dismissCrash().then(() => setCrash(null))} />}
        {!all.length && <p className="muted small pad">No works yet. Start one with ＋ New: a discussion opens, and its agent plans the work with you.</p>}
        {!empty && hiding && !sidebar.entries.length && <p className="muted small pad">{searching ? 'Nothing matches.' : 'Nothing here.'}</p>}
        {sidebar.entries.map((e) => e.kind === 'row' ? row(e.card, null) : (
          <Group
            key={groupKey(e.group.id)}
            group={e.group}
            open={!e.group.collapsed || hiding}
            naming={naming === e.group.id}
            over={over === groupKey(e.group.id)}
            drag={{ ...source(groupKey(e.group.id)), ...target(groupKey(e.group.id), { groupId: e.group.id, before: e.group.rows[0] ? cardRef(e.group.rows[0]) : null }) }}
            onToggle={() => edit((l) => toggleGroup(l, e.group.id))}
            onRename={(name) => { setNaming(null); if (name !== null) edit((l) => renameGroup(l, e.group.id, name)) }}
            onStartRename={() => setNaming(e.group.id)}
            onDelete={() => edit((l) => removeGroup(l, e.group.id))}
            onNew={() => onNewIn({ id: e.group.id, name: e.group.name })}
          >
            {e.group.rows.map((c) => row(c, e.group.id))}
          </Group>
        ))}
        {!hiding && (
          <button className={`wlfold wlend${over === 'end' ? ' over' : ''}`} title="A group of your own; drag rows into it" onClick={newGroup} {...target('end', { groupId: null, before: null })}>
            ＋ New group
          </button>
        )}
        {sidebar.closed.length > 0 && (
          <div className="wlclosed">
            <button className="wlfold" aria-expanded={showClosed || searching} onClick={() => setShowClosed((d) => !d)}>
              {showClosed || searching ? '▾' : '▸'} Closed · {sidebar.closed.length}
            </button>
            {(showClosed || searching) && sidebar.closed.map((c) => row(c, null))}
          </div>
        )}
      </div>
      <div className="wlfoot">
        <button className={`link${page === 'ideas' ? ' on' : ''}`} onClick={() => onOpenPage('ideas')}>Ideas · {ideas}</button>
        <button className={`link${page === 'architecture' ? ' on' : ''}`} onClick={() => onOpenPage('architecture')}>Architecture</button>
        <button className={`link wlgear${page === 'settings' ? ' on' : ''}`} title="Settings" aria-label="Settings" onClick={() => onOpenPage('settings')}>⚙</button>
      </div>
    </nav>
  )
}

type DragProps = Partial<Pick<HTMLAttributes<HTMLDivElement>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop'>>

/** A group of the user's: caret (collapse), name (double-click renames), count; on hover + (new in it) and ⋯. */
function Group({ group: g, open, naming, over, drag, children, onToggle, onRename, onStartRename, onDelete, onNew }: {
  group: SidebarGroup
  open: boolean
  naming: boolean
  over: boolean
  drag: DragProps
  children: ReactNode
  onToggle: () => void
  /** null: renaming canceled. */
  onRename: (name: string | null) => void
  onStartRename: () => void
  onDelete: () => void
  onNew: () => void
}) {
  const [menu, setMenu] = useState(false)
  // Enter, Escape and the blur that follows end one rename once.
  const done = useRef(false)
  useEffect(() => { if (naming) done.current = false }, [naming])
  const finish = (name: string | null) => { if (done.current) return; done.current = true; onRename(name) }
  return (
    <div className="wlgroup">
      <div className={`wlgrp${over ? ' over' : ''}${menu ? ' menuopen' : ''}`} {...drag}>
        {naming ? (
          <form className="wlrename" onSubmit={(e) => { e.preventDefault(); finish((e.currentTarget.elements.namedItem('name') as HTMLInputElement).value) }}>
            <input name="name" autoFocus defaultValue={g.name} aria-label="Group name" onFocus={(e) => e.currentTarget.select()} onBlur={(e) => finish(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Escape') finish(null) }} />
          </form>
        ) : (
          <button className="wlgname" aria-expanded={open} onClick={onToggle} onDoubleClick={onStartRename} title="Collapse; double-click to rename">
            <span aria-hidden>{open ? '▾' : '▸'}</span> {g.name} <span className="count">{g.rows.length}</span>
          </button>
        )}
        <button className="wlgbtn" aria-label={`New in ${g.name}`} title={`Ask, start a work or review a PR in ${g.name}`} onClick={onNew}>＋</button>
        <button className="wlgbtn" aria-label={`More for ${g.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
        {menu && (
          <>
            <div className="menuscrim" onClick={() => setMenu(false)} />
            <div className="menulist wlmenu small" role="menu" aria-label={`${g.name}: actions`}>
              <button role="menuitem" onClick={() => { setMenu(false); onStartRename() }}>Rename</button>
              <button role="menuitem" title="Its rows stay in the list, where the group was" onClick={() => { setMenu(false); onDelete() }}>Delete group</button>
            </div>
          </>
        )}
      </div>
      {open && children}
      {open && !g.rows.length && <p className="wlgempty">Drag rows here</p>}
    </div>
  )
}

/** The badge of a row's state: amber waiting on you, green an agent working, grey done; else none. */
function badge(c: WorkCard): { tone: string; text: string } | null {
  if (c.closed) return null
  if (c.dot === 'amber') return { tone: 'amber', text: 'waiting on you' }
  if (c.dot === 'green') return { tone: 'green', text: 'agent working' }
  if (c.group === 'done') return { tone: 'grey', text: 'done' }
  return null
}

/**
 * A row: title and time, then the state badge and whose move (a discussion without one: its last message). ⋯ on hover
 * and a right-click open its menu; it is dragged to move it.
 */
function Row({ card: c, now, on, menu, over, drag, onMenu, onSelect, onGone }: {
  card: WorkCard
  now: number
  on: boolean
  menu: boolean
  over: boolean
  drag: DragProps
  onMenu: (open: boolean) => void
  onSelect: (s: Selection) => void
  onGone: () => void
}) {
  const tone = c.move.who === 'you' ? 'you' : c.move.who === 'agent' ? 'agent' : 'other'
  const b = badge(c)
  // A discussion without a move shows its last message; a done work its last event (the badge says done).
  const line = (c.kind === 'topic' && c.move.who === 'other') || b?.tone === 'grey' ? c.last?.text ?? (b ? '' : c.move.text) : c.move.text
  return (
    <div
      className={`wlrow${on ? ' on' : ''}${menu ? ' menuopen' : ''}${over ? ' over' : ''}`}
      onContextMenu={(e) => { e.preventDefault(); onMenu(true) }}
      {...drag}
    >
      <button className="wlmain" title={c.task?.key} aria-current={on ? 'true' : undefined} onClick={() => onSelect(cardSelection(c))}>
        <span className="title">{c.title}</span>
        <span className="wltime">{threadTime(c.at, now)}</span>
        <span className={`wlmove ${tone}`}>{b && <span className={`wlbadge ${b.tone}`}>{b.text}</span>}{line}</span>
      </button>
      <button className="wlmore" aria-label={`More for ${c.title}`} aria-haspopup="menu" aria-expanded={menu} title="Rename, close, delete…" onClick={() => onMenu(!menu)}>⋯</button>
      {menu && <RowMenu card={c} onClose={() => onMenu(false)} onSelect={onSelect} onGone={onGone} />}
    </div>
  )
}

/** What the row menu shows instead of its items: a field for a topic's title, or for why a work closes. */
type Asking = 'rename' | 'close' | null

/**
 * The row menu: a discussion is renamed, branched, turned into a work, closed (history kept, under Done) or deleted; a
 * work is closed (canceled, with a reason) or deleted; a review closed or deleted. Delete asks first.
 */
function RowMenu({ card: c, onClose, onSelect, onGone }: { card: WorkCard; onClose: () => void; onSelect: (s: Selection) => void; onGone: () => void }) {
  const [asking, setAsking] = useState<Asking>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const act = (f: () => Promise<unknown>) => () => {
    onClose()
    f().catch((e: Error) => alert(e.message))
  }
  const s = c.session
  const t = c.task
  const ask = (a: Asking, initial = '') => { setText(initial); setAsking(a) }

  let body
  if (asking === 'rename' && s) {
    body = (
      <form className="wlask" onSubmit={(e) => { e.preventDefault(); if (text.trim()) act(() => mag.renameChat(s.id, text))() }}>
        <input autoFocus value={text} aria-label="Title" onChange={(e) => setText(e.target.value)} />
        <button className="small primary" disabled={!text.trim()}>Rename</button>
      </form>
    )
  } else if (asking === 'close' && t) {
    body = (
      <form className="wlask" onSubmit={(e) => { e.preventDefault(); act(() => mag.cancel(t.id, text.trim() || null))() }}>
        <input autoFocus value={text} placeholder="Why close it? (optional)" aria-label="Reason" onChange={(e) => setText(e.target.value)} />
        <button className="small primary">Close work</button>
      </form>
    )
  } else if (c.kind === 'topic' && s) {
    const canBranch = s.agent === 'claude-code' && !!s.nativeSessionId
    const running = s.status === 'running'
    body = (
      <>
        <button role="menuitem" onClick={() => ask('rename', c.title)}>Rename</button>
        <button role="menuitem" disabled={!canBranch} title={canBranch ? 'A new topic that starts with everything said here' : 'Needs a topic with a Claude Code session (send a message first)'} onClick={act(() => mag.branchChat(s.id).then((id) => onSelect({ kind: 'topic', id })))}>Branch</button>
        <button role="menuitem" disabled={running} title={running ? 'The agent is still working' : 'Its agent creates a work from what was discussed'} onClick={act(() => { onSelect({ kind: 'topic', id: s.id }); return mag.turnIntoWork(s.id) })}>Turn into a work</button>
        <hr />
        {!s.closedAt && <button role="menuitem" onClick={act(() => mag.closeChat(s.id))}>Close (keep history)</button>}
        <button role="menuitem" className="danger" onClick={() => {
          if (!confirm(`Delete topic "${c.title}"? Its history is lost.`)) return onClose()
          act(() => mag.deleteChat(s.id).then(onGone))()
        }}>Delete…</button>
      </>
    )
  } else if (t) {
    const review = c.kind === 'review'
    const closable = review ? t.status === 'in_progress' && !t.imported : canCancel(t)
    body = (
      <>
        {closable && (review
          ? <button role="menuitem" onClick={act(() => mag.closeReview(t.id))}>Close (keep history)</button>
          : <button role="menuitem" onClick={() => ask('close')}>Close…</button>)}
        <button role="menuitem" className="danger" onClick={() => {
          const q = review
            ? `Delete review ${t.key}? It goes for good, with its diagrams and the topic mag created for it; nothing changes on GitHub.`
            : `Delete work ${t.key} "${c.title}"? Its steps, conversations, doc and diagrams go for good; branches and PRs stay.`
          if (!confirm(q)) return onClose()
          act(() => mag.deleteWork(t.id).then(onGone))()
        }}>Delete…</button>
      </>
    )
  }
  return (
    <>
      <div className="menuscrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div className="menulist wlmenu small" role="menu" aria-label={`${c.title}: actions`}>{body}</div>
    </>
  )
}

/** mag crashed in an earlier run: the report is in the logs folder. */
function CrashRow({ crash, onDismiss }: { crash: CrashReport; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(crashMarkdown(crash)).then(() => setCopied(true))
  return (
    <div className="wlcrash">
      <div className="wltop"><span className="pill red">Crash</span><span className="title">mag crashed {new Date(crash.time).toLocaleString()}</span></div>
      <div className="muted small">{crash.kind}{crash.screen ? ` on ${crash.screen}` : ''}: {crash.message.split('\n')[0]}</div>
      <div className="actions">
        <button className="small" onClick={() => mag.openLogs()}>Logs</button>
        <button className="small" onClick={onDismiss}>Dismiss</button>
        <button className="small primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy report'}</button>
      </div>
    </div>
  )
}
