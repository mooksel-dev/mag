import { useEffect, useRef, useState } from 'react'
import {
  WORK_GROUPS,
  WORK_GROUP_LABELS,
  canCancel,
  cardFilter,
  searchCards,
  workCards,
  type Project,
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

/** Reviews only (the footer's Reviews), per project. */
function useReviewsOnly(projectId: string): [boolean, (on: boolean) => void] {
  const key = `mag.worklist.reviews.${projectId}`
  const [on, setOn] = useState(() => localStorage.getItem(key) === '1')
  const set = (v: boolean) => {
    setOn(v)
    try { localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ }
  }
  return [on, set]
}

/**
 * The sidebar only lists (redesign-start-screen-big-composer.2): the project switcher, ＋ New (Home), search (⌘K), the
 * groups of core workCards() with Done folded, and a footer (Ideas, Reviews, Architecture, settings). Each row has a ⋯
 * menu, also on right-click: Rename, Branch, Turn into a work, Close and Delete….
 */
export function WorkList({ project, state, selected, home, page, picker, onPicker, onSelect, onNew, onOpenPage }: {
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
  onOpenPage: (p: ListPage) => void
}) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const all = workCards(project.id, tasks, state.sessions, now)
  const [reviewsOnly, setReviewsOnly] = useReviewsOnly(project.id)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const cards = searchCards(cardFilter(all, reviewsOnly ? 'reviews' : 'all'), query)
  const ideas = state.ideas.filter((i) => i.projectId === project.id).length
  const [showDone, setShowDone] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
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
  const groups = WORK_GROUPS.map((g) => ({ g, list: cards.filter((c) => c.group === g) })).filter((x) => x.list.length)
  // What the selection was is gone (deleted): Home.
  const gone = (c: WorkCard) => { if (selected?.id === c.id) onNew() }
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
      </div>
      <div className="wlscroll">
        {crash && <CrashRow crash={crash} onDismiss={() => mag.dismissCrash().then(() => setCrash(null))} />}
        {!all.length && <p className="muted small pad">No works yet. Start one with ＋ New: a discussion opens, and its agent plans the work with you.</p>}
        {all.length > 0 && !cards.length && <p className="muted small pad">{searching ? 'Nothing matches.' : 'No reviews.'}</p>}
        {groups.map(({ g, list }) => {
          const open = g !== 'done' || showDone || searching
          return (
            <div key={g} className="wlgroup">
              <div className="wlgrp"><span>{WORK_GROUP_LABELS[g]}</span><span>{list.length}</span></div>
              {open && list.map((c) => (
                <Row
                  key={c.id}
                  card={c}
                  now={now}
                  on={selected?.id === c.id}
                  menu={menu === c.id}
                  onMenu={(o) => setMenu(o ? c.id : null)}
                  onSelect={onSelect}
                  onGone={() => gone(c)}
                />
              ))}
              {g === 'done' && !searching && (
                <button className="wlfold" aria-expanded={showDone} onClick={() => setShowDone((d) => !d)}>{showDone ? '▾ Hide done' : '▸ Show done'}</button>
              )}
            </div>
          )
        })}
      </div>
      <div className="wlfoot">
        <button className={`link${page === 'ideas' ? ' on' : ''}`} onClick={() => onOpenPage('ideas')}>Ideas · {ideas}</button>
        <button className={`link${reviewsOnly ? ' on' : ''}`} aria-pressed={reviewsOnly} title="Show only reviews of PRs" onClick={() => setReviewsOnly(!reviewsOnly)}>Reviews</button>
        <button className={`link${page === 'architecture' ? ' on' : ''}`} onClick={() => onOpenPage('architecture')}>Architecture</button>
        <button className={`link wlgear${page === 'settings' ? ' on' : ''}`} title="Settings" aria-label="Settings" onClick={() => onOpenPage('settings')}>⚙</button>
      </div>
    </nav>
  )
}

/**
 * A row: dot, title and time, then one line: whose move (a discussion without one: its last message). ⋯ on hover and a
 * right-click open its menu.
 */
function Row({ card: c, now, on, menu, onMenu, onSelect, onGone }: {
  card: WorkCard
  now: number
  on: boolean
  menu: boolean
  onMenu: (open: boolean) => void
  onSelect: (s: Selection) => void
  onGone: () => void
}) {
  const tone = c.move.who === 'you' ? 'you' : c.move.who === 'agent' ? 'agent' : 'other'
  const line = c.kind === 'topic' && c.move.who === 'other' && c.last ? c.last.text : c.move.who === 'you' ? `→ ${c.move.text}` : c.move.text
  return (
    <div
      className={`wlrow${on ? ' on' : ''}${menu ? ' menuopen' : ''}`}
      onContextMenu={(e) => { e.preventDefault(); onMenu(true) }}
    >
      <button className="wlmain" title={c.task?.key} aria-current={on ? 'true' : undefined} onClick={() => onSelect(cardSelection(c))}>
        <span className={`wldot ${c.dot}`} aria-hidden />
        <span className="title">{c.title}</span>
        <span className="wltime">{threadTime(c.at, now)}</span>
        <span className={`wlmove ${tone}`}>{line}</span>
      </button>
      <button className="wlmore" aria-label={`More for ${c.title}`} aria-haspopup="menu" aria-expanded={menu} title="Rename, close, delete…" onClick={() => onMenu(!menu)}>⋯</button>
      {menu && <RowMenu card={c} onClose={() => onMenu(false)} onSelect={onSelect} onGone={onGone} />}
    </div>
  )
}

/** What the row menu needs of a row: a work's or a review's task, or a discussion's session. */
export type MenuCard = Pick<WorkCard, 'kind' | 'title' | 'task' | 'session'>

/** What the row menu shows instead of its items: a field for a topic's title, or for why a work closes. */
type Asking = 'rename' | 'close' | null

/**
 * The row menu: a discussion is renamed, branched, turned into a work, closed (history kept, under Done) or deleted; a
 * work is closed (canceled, with a reason) or deleted; a review closed or deleted. Delete asks first. A work's or a
 * discussion's header ⋯ opens the same menu.
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
      <div className={`menulist ${className} small`} role="menu" aria-label={`${c.title}: actions`}>{body}</div>
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
