import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from 'react'
import {
  CARD_FILTERS,
  addGroup,
  canCancel,
  isReview,
  cardRef,
  groupKey,
  moveRef,
  isSubagent,
  removeGroup,
  renameGroup,
  toggleGroup,
  topicKids,
  type CardFilter,
  type ItemRef,
  type SessionHeader,
  type SessionLike,
  type SessionNode,
  type ChatRef,
  type Project,
  type SidebarGroup,
  type SidebarNode,
  type SidebarRows,
  type WorkCard,
} from '@mag/core'
import type { CrashReport } from '../../preload/api'
import { crashMarkdown, threadTime } from './format'
import { ProjectSquare } from './Picker'
import { canReference, referenceInCurrentChat } from './Chat'
import { DraftRow, SubtopicRows } from './SessionTree'
import { Caret, Icon } from './ui/Icon'
import { Pill } from './ui/Pill'

const mag = window.mag

/**
 * What the list has open: a work (a review too), a topic or subtopic (its session id), or the draft of a New subtopic
 * under a topic or subtopic (its id: the parent's session id).
 */
export type Selection = { kind: 'work' | 'topic' | 'draft'; id: string }

/** The selection a card opens. */
export const cardSelection = (c: WorkCard): Selection => ({ kind: c.kind === 'topic' ? 'topic' : 'work', id: c.id })

/** A project's pages (its section's ⋯) open in place of the conversation. */
export type ListPage = 'architecture' | 'settings'

/** A group the user starts something in (its +): Home puts what it creates first in that group. */
export interface HomeGroup { id: string; name: string }

/** The filter the column shows, per window; it only hides rows. */
export function useFilter(scope: string): [CardFilter, (f: CardFilter) => void] {
  const key = `mag.worklist.filter.${scope}`
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

/** Which topics have their subtopics folded (▸), per project (or per section without one); open by default. */
export function useFolded(scope: string): [Set<string>, (id: string) => void] {
  const key = `mag.worklist.folded.${scope}`
  const [folded, setFolded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]) } catch { return new Set() }
  })
  const toggle = (id: string) => {
    const next = new Set(folded)
    if (!next.delete(id)) next.add(id)
    setFolded(next)
    try { localStorage.setItem(key, JSON.stringify([...next])) } catch { /* ignore */ }
  }
  return [folded, toggle]
}

/** A localStorage flag; `initial` until set. */
export function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => { const v = localStorage.getItem(key); return v === null ? initial : v === '1' })
  const set = (v: boolean) => {
    setOn(v)
    try { localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ }
  }
  return [on, set]
}

/** Whether a tree of subtopics has `id`. */
const hasNode = (nodes: SessionNode[], id: string | undefined): boolean => !!id && nodes.some((n) => n.session.id === id || hasNode(n.children, id))

/** Whether `c` (its row, a work under it or a subtopic) is what is open. */
export const holdsSelection = (c: WorkCard, s: Selection | null): boolean =>
  !!s && (s.id === c.id || (s.kind === 'work' && !!c.children?.some((k) => k.id === s.id)) || (s.kind !== 'work' && hasNode(topicKids(c), s.id)))

/** Starring a row (slack-like-shell-rail-resizable.1): what the column gives its rows' menus. */
export interface Stars {
  has: (ref: ItemRef) => boolean
  toggle: (ref: ItemRef) => void
}
export const StarsContext = createContext<Stars | null>(null)

/** Where a drop puts what is dragged: into a group (or the top level) before a key, or at the end. */
type Drop = { groupId: string | null; before: string | null }

/** What every row of the column shares: the selection, the clock, how it opens and what happens when it goes. */
export interface RowEnv {
  now: number
  selected: Selection | null
  sessions: SessionLike[]
  onSelect: (s: Selection) => void
  /** What was open is gone (deleted): Home. */
  onNew: () => void
}

/**
 * A row; a topic's with its subtopics under it, nested, behind its ▸/▾ (topic-screen-one-new-compact.2). Its works and
 * agents are on its page. A topic is the current row while one of its works is open; a subtopic moves with its topic.
 */
export function CardRow({ card: c, env, folded, onFold, over = false, drag = {} }: {
  card: WorkCard
  env: RowEnv
  folded: Set<string>
  onFold: (id: string) => void
  over?: boolean
  drag?: DragProps
}) {
  const { now, selected, sessions, onSelect, onNew } = env
  const [menu, setMenu] = useState(false)
  const ref = cardRef(c)
  const subs = topicKids(c)
  const sel = selected?.kind === 'topic' ? selected.id : null
  const draftOf = selected?.kind === 'draft' ? selected.id : null
  const draftHere = !!draftOf && (draftOf === c.id || hasNode(subs, draftOf))
  // The open subtopic or draft stays in sight.
  const open = !folded.has(c.id) || hasNode(subs, sel ?? undefined) || draftHere
  // A subtopic deleted from its menu: what was open in it (itself, a subtopic or draft under it) goes to its parent.
  const goneSub = (s: SessionLike) => {
    const under = (id: string): boolean => id === s.id || (() => { const p = sessions.find((x) => x.id === id)?.parentId; return !!p && under(p) })()
    if (selected && selected.kind !== 'work' && under(selected.id)) onSelect({ kind: 'topic', id: s.parentId! })
  }
  const one = (
    <Row
      key={ref}
      card={c}
      now={now}
      on={(selected?.kind !== 'draft' && selected?.id === c.id) || (selected?.kind === 'work' && !!c.children?.some((k) => k.id === selected.id))}
      menu={menu}
      over={over}
      fold={subs.length || draftOf === c.id ? { open, toggle: () => onFold(c.id) } : null}
      drag={c.closed ? {} : drag}
      onMenu={setMenu}
      onSelect={onSelect}
      onGone={() => { if (selected?.id === c.id) onNew() }}
    />
  )
  if (!subs.length && draftOf !== c.id) return one
  return (
    <div className="wlchat">
      {one}
      {open && (
        <div className="wlkids" aria-label={`Subtopics of ${c.title}`}>
          <SubtopicRows nodes={subs} selectedId={sel} draftOf={draftOf} onSelect={onSelect} onGone={goneSub} />
          {draftOf === c.id && <DraftRow />}
        </div>
      )}
    </div>
  )
}

/**
 * One project's section of the topics column (slack-like-shell-rail-resizable.1): its Project label's header (fold,
 * what waits on the user, + and ⋯ on hover), then its rows laid out by core sidebarRows from project.sidebar
 * (redesign-start-screen-big-composer.2, decision 9). Nothing re-sorts: rows and groups move only by drag & drop
 * within the section, a new item shows on top; status is a badge; filters only hide. Groups are the user's (create,
 * rename, collapse, delete, + starts something in one). Each row has a ⋯ menu, also on right-click. Its ideas close it.
 */
export function ProjectSection({ project, sidebar, waiting, ideas, hiding, empty, env, page, onNewIn, onOpenPage }: {
  project: Project
  /** Its rows as laid out, the column's filter (and Starred) applied. */
  sidebar: SidebarRows
  /** What waits on the user in it. */
  waiting: number
  ideas: SessionHeader[]
  /** A filter hides rows: no drag, groups show open. */
  hiding: boolean
  /** It has no open rows at all. */
  empty: boolean
  env: RowEnv
  /** The page open in place of the conversation, when it is this project's. */
  page: ListPage | null
  /** A group's + (or the section's, with no group): Home, creating into this project and that group. */
  onNewIn: (g: HomeGroup | null) => void
  onOpenPage: (p: ListPage) => void
}) {
  const [folded, toggleFold] = useFolded(project.id)
  const [collapsed, setCollapsed] = useStoredFlag(`mag.column.collapsed.${project.id}`, false)
  const [menu, setMenu] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const save = (layout: SidebarNode[]) => void mag.updateProject(project.id, { sidebar: layout })
  const edit = (f: (layout: SidebarNode[]) => SidebarNode[]) => save(f(sidebar.layout))
  const rows = sidebar.entries.flatMap((e) => (e.kind === 'row' ? [e.card] : e.group.rows))
  // The open row stays in sight.
  const open = !collapsed || rows.some((c) => holdsSelection(c, env.selected))

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
  // Only what was dragged from this section drops in it: another section's drag is null here.
  const target = (id: string, to: Drop) => ({
    onDragOver: (e: DragEvent) => { if (!drag) return; e.preventDefault(); e.stopPropagation(); setOver(id) },
    onDrop: (e: DragEvent) => { if (!drag) return; e.preventDefault(); e.stopPropagation(); drop(to) },
  })
  const source = (key: string) => ({
    draggable: !hiding,
    onDragStart: (e: DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); setDrag(key) },
    onDragEnd: () => { setDrag(null); setOver(null) },
  })
  const row = (c: WorkCard, groupId: string | null) => {
    const ref = cardRef(c)
    return <CardRow key={ref} card={c} env={env} folded={folded} onFold={toggleFold} over={over === ref} drag={{ ...source(ref), ...target(ref, { groupId, before: ref }) }} />
  }
  const newGroup = () => {
    const id = Math.random().toString(36).slice(2, 10)
    edit((l) => addGroup(l, 'New group', id))
    setNaming(id)
    setCollapsed(false)
  }
  return (
    <section className="colsection" aria-label={project.name}>
      <div className={`wlgrp colhead${menu ? ' menuopen' : ''}`}>
        <button className={`wlgname${waiting ? ' unread' : ''}`} aria-expanded={open} onClick={() => setCollapsed(open)} title={waiting ? `${waiting} waiting on you` : project.name}>
          <span aria-hidden><Caret open={open} /></span> <ProjectSquare project={project} /> <span className="colname">{project.name}</span>
          {waiting > 0 && <span className="colcount">{waiting}</span>}
        </button>
        <button className="wlgbtn" aria-label={`New topic in ${project.name}`} title={`Ask, start a topic or review a PR in ${project.name}`} onClick={() => onNewIn(null)}><Icon name="plus" size={14} /></button>
        <button className="wlgbtn" aria-label={`More for ${project.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" size={14} /></button>
        {menu && (
          <>
            <div className="menuscrim" onClick={() => setMenu(false)} />
            <div className="menulist wlmenu small" role="menu" aria-label={`${project.name}: actions`}>
              <button role="menuitem" disabled={hiding} title={hiding ? 'Show All to arrange groups' : 'A group of your own; drag rows into it'} onClick={() => { setMenu(false); newGroup() }}>New group</button>
              <button role="menuitem" aria-current={page === 'architecture' ? 'page' : undefined} onClick={() => { setMenu(false); onOpenPage('architecture') }}>Architecture</button>
              <button role="menuitem" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => { setMenu(false); onOpenPage('settings') }}>Settings</button>
            </div>
          </>
        )}
      </div>
      {open && (
        <div className="colbody">
          {empty && !hiding && <p className="wlgempty">No topics yet. + starts one.</p>}
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
              <Icon name="plus" size={14} /> New group
            </button>
          )}
          {!hiding && <Ideas topics={ideas} projectId={project.id} selectedId={env.selected?.kind === 'topic' ? env.selected.id : null} now={env.now} onSelect={env.onSelect} />}
        </div>
      )}
    </section>
  )
}

/**
 * The project's ideas (ideas-are-parked-topics.1): its parked topics, a line each, in a section collapsed by default;
 * a click opens the topic, + Idea parks a new one with the typed text (its first line is the title).
 */
function Ideas({ topics, projectId, selectedId, now, onSelect }: {
  topics: SessionHeader[]
  projectId: string
  selectedId: string | null
  now: number
  onSelect: (s: Selection) => void
}) {
  const key = `mag.worklist.ideas.${projectId}`
  const [open, setOpen] = useState(() => localStorage.getItem(key) === 'open')
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The open idea stays in sight.
  const shown = open || topics.some((t) => t.id === selectedId)
  const toggle = () => {
    setOpen(!shown)
    try { localStorage.setItem(key, shown ? 'closed' : 'open') } catch { /* ignore */ }
  }
  const add = () => {
    const text = draft?.trim()
    if (!text) return
    mag.addIdea(projectId, text).then((id) => { setDraft(null); setError(null); onSelect({ kind: 'topic', id }) }, (e: Error) => setError(e.message))
  }
  return (
    <div className="wlideas">
      <button className="wlfold" aria-expanded={shown} onClick={toggle}>
        <Caret open={shown} /> Ideas · {topics.length}
      </button>
      {shown && (
        <>
          {topics.map((t) => (
            <div
              key={t.id}
              className={`row wlidea${selectedId === t.id ? ' on' : ''}`}
              role="button"
              tabIndex={0}
              title={t.brief ?? t.title}
              onClick={() => onSelect({ kind: 'topic', id: t.id })}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect({ kind: 'topic', id: t.id }) }}
            >
              <span className="wlideatitle">{t.title}</span>
              <span className="muted small">{t.source ?? ''} {threadTime(t.parkedAt!, now)}</span>
            </div>
          ))}
          {draft === null ? (
            <button className="wlfold" onClick={() => setDraft('')}><Icon name="plus" size={14} /> Idea</button>
          ) : (
            <form className="ideaadd" onSubmit={(e) => { e.preventDefault(); add() }}>
              <textarea
                autoFocus
                rows={3}
                value={draft}
                placeholder="An idea… The first line is its title."
                aria-label="New idea"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setDraft(null)
                  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add() }
                }}
              />
              {error && <div className="error small">{error}</div>}
              <div className="ideaaddactions">
                <button type="submit" className="primary small" disabled={!draft.trim()}>Add</button>
                <button type="button" className="small" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
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
            <span aria-hidden><Caret open={open} /></span> {g.name} <span className="count">{g.rows.length}</span>
          </button>
        )}
        <button className="wlgbtn" aria-label={`New in ${g.name}`} title={`Ask, start a topic or review a PR in ${g.name}`} onClick={onNew}><Icon name="plus" size={14} /></button>
        <button className="wlgbtn" aria-label={`More for ${g.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="more" size={14} /></button>
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

/**
 * A row on one line (topic-screen-one-new-compact.1): a topic's ▸/▾ when it has subtopics, its state dot, title, then
 * "you" when it waits on you, else the time. The status line under it (whose move) only while it works or waits on you.
 * ⋯ on hover and a right-click open its menu; it is dragged to move it.
 */
function Row({ card: c, now, on, menu, over, fold, drag, onMenu, onSelect, onGone }: {
  card: WorkCard
  now: number
  on: boolean
  menu: boolean
  over: boolean
  /** A topic with subtopics: whether they show, and its toggle. */
  fold: { open: boolean; toggle: () => void } | null
  drag: DragProps
  onMenu: (open: boolean) => void
  onSelect: (s: Selection) => void
  onGone: () => void
}) {
  const tone = c.move.who === 'you' ? 'you' : c.move.who === 'agent' ? 'agent' : 'other'
  const you = !c.closed && c.group === 'waiting'
  const status = !c.closed && (c.group === 'working' || c.group === 'waiting')
  const time = threadTime(c.at, now)
  const state = c.closed ? 'closed' : DOT_LABELS[c.dot]
  return (
    <div
      className={`wlrow${fold ? ' folds' : ''}${on ? ' on' : ''}${menu ? ' menuopen' : ''}${over ? ' over' : ''}${you ? ' you' : ''}`}
      onContextMenu={(e) => { e.preventDefault(); onMenu(true) }}
      {...drag}
    >
      {fold && <button className="wlcaret" aria-expanded={fold.open} aria-label={`${fold.open ? 'Fold' : 'Unfold'} the subtopics of ${c.title}`} onClick={fold.toggle}><Caret open={fold.open} /></button>}
      <button className="wlmain" title={[state, c.move.text, time].filter(Boolean).join(' · ')} aria-current={on ? 'true' : undefined} onClick={() => onSelect(cardSelection(c))}>
        <span className={`sessdot ${c.closed ? 'grey' : c.dot}`} title={state} aria-hidden />
        <span className="title">{c.title}</span>
        {you ? <Pill tone="amber">you</Pill> : <span className="wltime">{time}</span>}
        {status && <span className={`wlmove ${tone}`}>{c.move.text}</span>}
      </button>
      <button className="wlmore" aria-label={`More for ${c.title}`} aria-haspopup="menu" aria-expanded={menu} title="New subtopic, rename, close, delete…" onClick={() => onMenu(!menu)}><Icon name="more" size={14} /></button>
      {menu && <RowMenu card={c} onClose={() => onMenu(false)} onSelect={onSelect} onGone={onGone} />}
    </div>
  )
}

/** What a row's dot means, in its tooltip. */
const DOT_LABELS: Record<WorkCard['dot'], string> = { green: 'an agent is working', amber: 'waits on you', grey: 'idle', red: 'an agent failed' }

/** What the row menu needs of a row: a work's or a review's task, or a discussion's session. */
export type MenuCard = Pick<WorkCard, 'kind' | 'title' | 'task' | 'session' | 'closed' | 'sessions'>

/** What the row menu shows instead of its items: a field for a topic's title, or for why a work closes. */
type Asking = 'rename' | 'close' | null

/**
 * The row menu: a discussion is renamed, branched, closed (history kept) or deleted; an open work is closed by cancel
 * (with a reason), a done work or a review closed with all it has; a closed row (not a canceled work) is restored to
 * where it was. Delete asks first. A work's or a discussion's header ⋯ opens the same menu.
 * With a conversation open, any row is referenced in its composer (a chip: the agent gets its summary).
 */
export function RowMenu({ card: c, onClose, onSelect, onGone, className = 'wlmenu' }: {
  card: MenuCard
  onClose: () => void
  onSelect: (s: Selection) => void
  onGone: () => void
  /** Where the menu sits: by a row (default) or under a screen's header ⋯. */
  className?: string
}) {
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
  const ref: ChatRef | null = s ? { kind: 'topic', id: s.id } : t ? { kind: 'task', id: t.id } : null
  const stars = useContext(StarsContext)
  const itemRef: ItemRef | null = c.kind === 'topic' ? (s ? `topic:${s.id}` : null) : t ? `work:${t.id}` : null
  const starred = !!itemRef && !!stars?.has(itemRef)
  const reference = (
    <>
      {stars && itemRef && (!c.closed || starred) && <button role="menuitem" onClick={() => { onClose(); stars.toggle(itemRef) }}>{starred ? 'Unstar' : 'Star'}</button>}
      {ref && canReference(ref) && <button role="menuitem" title="A chip in the open conversation's composer: the agent gets this chat's summary and can read it whole" onClick={() => { onClose(); referenceInCurrentChat(ref) }}>Reference in current chat</button>}
    </>
  )

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
        <button className="small primary">Close</button>
      </form>
    )
  } else if (c.kind === 'topic' && s && !(s.reviewOf && t)) {
    const canBranch = s.agent === 'claude-code' && !!s.nativeSessionId
    // A subagent starts nothing under it (startChild refuses).
    const canSub = !isSubagent(s)
    body = (
      <>
        {reference}
        {canSub && <button role="menuitem" title="A new conversation under this one; kept once you write in it" onClick={() => { onClose(); onSelect({ kind: 'draft', id: s.id }) }}>New subtopic</button>}
        <button role="menuitem" onClick={() => ask('rename', c.title)}>Rename</button>
        <button role="menuitem" disabled={!canBranch} title={canBranch ? 'A subtopic that starts with everything said here' : 'Needs a topic with a Claude Code conversation (send a message first)'} onClick={act(() => mag.startChild(s.id, '', null, true).then((c) => onSelect({ kind: 'topic', id: c.id })))}>Branch</button>
        <hr />
        {c.closed
          ? <button role="menuitem" title="Back in the list, where it was" onClick={act(() => mag.restore('topic', s.id))}>Restore</button>
          : <button role="menuitem" onClick={act(() => mag.closeChat(s.id))}>Close (keep history)</button>}
        <button role="menuitem" className="danger" onClick={() => {
          if (!confirm(`Delete topic "${c.title}"${c.sessions?.length ? ' with its subtopics and agents' : ''}? Its history is lost.`)) return onClose()
          act(() => mag.deleteChat(s.id).then(onGone))()
        }}>Delete…</button>
      </>
    )
  } else if (t) {
    const review = isReview(t)
    // Open: canceled with a reason (final). Done or a review: closed with all it has, Restore brings it back.
    const close = c.closed
      ? t.status !== 'canceled' && <button role="menuitem" title="Back in the list, where it was" onClick={act(() => mag.restore('work', t.id))}>Restore</button>
      : !review && canCancel(t)
        ? <button role="menuitem" onClick={() => ask('close')}>Close…</button>
        : <button role="menuitem" onClick={act(() => (review ? mag.closeReview(t.id) : mag.closeWork(t.id)))}>Close (keep history)</button>
    body = (
      <>
        {reference}
        {close}
        <button role="menuitem" className="danger" onClick={() => {
          const q = review
            ? `Delete review ${t.key}? It goes for good, with its diagrams and the topic mag created for it; nothing changes on GitHub.`
            : `Delete "${c.title}" (${t.key})? Its steps, conversations, doc and diagrams go for good; branches and PRs stay.`
          if (!confirm(q)) return onClose()
          act(() => mag.deleteWork(t.id).then(onGone))()
        }}>Delete…</button>
      </>
    )
  }
  return (
    <>
      <div className="menuscrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div className={`menulist ${className} small`} role="menu" aria-label={`${c.title}: actions`}>{body}</div>
    </>
  )
}

/** mag crashed in an earlier run: the report is in the logs folder. */
export function CrashRow({ crash, onDismiss }: { crash: CrashReport; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(crashMarkdown(crash)).then(() => setCopied(true))
  return (
    <div className="wlcrash">
      <div className="wltop"><Pill tone="red">Crash</Pill><span className="title">mag crashed {new Date(crash.time).toLocaleString()}</span></div>
      <div className="muted small">{crash.kind}{crash.screen ? ` on ${crash.screen}` : ''}: {crash.message.split('\n')[0]}</div>
      <div className="actions">
        <button className="small" onClick={() => mag.openLogs()}>Logs</button>
        <button className="small" onClick={onDismiss}>Dismiss</button>
        <button className="small primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy report'}</button>
      </div>
    </div>
  )
}
