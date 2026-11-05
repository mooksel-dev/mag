import { useEffect, useState } from 'react'
import {
  CARD_FILTERS,
  CARD_FILTER_LABELS,
  WORK_GROUPS,
  WORK_GROUP_LABELS,
  cardFilter,
  workCards,
  type CardFilter,
  type Project,
  type WorkCard,
} from '@mag/core'
import type { AppState, CrashReport } from '../../preload/api'
import { crashMarkdown, threadTime } from './format'
import { useNow } from './Tasks'

const mag = window.mag

/** What the list has open: a work (a review too) or a topic without a work. */
export type Selection = { kind: 'work' | 'topic'; id: string }

/** The selection a card opens. */
export const cardSelection = (c: WorkCard): Selection => ({ kind: c.kind === 'topic' ? 'topic' : 'work', id: c.id })

/** The filter the list shows, per project. */
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

/**
 * The left column (work-list-the-left-column.1): ＋ New opens Home (its composer starts any work), filters with counts,
 * then a card per work and topic of core workCards() by group. Done is folded; Ideas is a link at the end.
 */
export function WorkList({ project, state, selected, home, onSelect, onNew, onOpenIdeas }: {
  project: Project
  state: AppState
  selected: Selection | null
  /** Home is open: ＋ New is the current row. */
  home: boolean
  onSelect: (s: Selection) => void
  onNew: () => void
  onOpenIdeas: () => void
}) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const all = workCards(project.id, tasks, state.sessions, now)
  const [filter, setFilter] = useFilter(project.id)
  const cards = cardFilter(all, filter)
  const ideas = state.ideas.filter((i) => i.projectId === project.id).length
  const [showDone, setShowDone] = useState(false)
  const [crash, setCrash] = useState<CrashReport | null>(null)
  useEffect(() => {
    mag.lastCrash().then(setCrash, () => {})
  }, [])
  const groups = WORK_GROUPS.map((g) => ({ g, list: cards.filter((c) => c.group === g) })).filter((x) => x.list.length)
  return (
    <nav className="worklist" aria-label="Works">
      <div className="wlnew">
        <button className={`newbtn${home ? ' on' : ''}`} aria-current={home ? 'page' : undefined} title="Ask, describe a task, review a PR or start from a ticket" onClick={onNew}>
          ＋ New <kbd>⌘N</kbd>
        </button>
      </div>
      {all.length > 0 && (
        <div className="wlfilters" role="tablist" aria-label="Filter works">
          {CARD_FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {CARD_FILTER_LABELS[f]} <span className="count">{cardFilter(all, f).length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="wlscroll">
        {crash && <CrashRow crash={crash} onDismiss={() => mag.dismissCrash().then(() => setCrash(null))} />}
        {!all.length && <p className="muted small pad">No works yet. Start one with ＋ New: a discussion opens, and its agent plans the work with you.</p>}
        {all.length > 0 && !cards.length && <p className="muted small pad">Nothing here.</p>}
        {groups.map(({ g, list }) => (
          <div key={g} className="wlgroup">
            {g === 'done'
              ? <button className="wlhead" aria-expanded={showDone} onClick={() => setShowDone((d) => !d)}>{showDone ? '▾' : '▸'} {WORK_GROUP_LABELS[g]} · {list.length}</button>
              : <div className="wlhead">{WORK_GROUP_LABELS[g]} · {list.length}</div>}
            {(g !== 'done' || showDone) && list.map((c) => (
              <Row key={c.id} card={c} now={now} on={selected?.id === c.id} onSelect={onSelect} />
            ))}
          </div>
        ))}
        <button className="wlideas link" onClick={onOpenIdeas}>Ideas · {ideas} →</button>
      </div>
    </nav>
  )
}

/** A work card: dot, title and time; kind, stage and progress; whose move; the last event. */
function Row({ card: c, now, on, onSelect }: { card: WorkCard; now: number; on: boolean; onSelect: (s: Selection) => void }) {
  const tone = c.move.who === 'you' ? 'you' : c.move.who === 'agent' ? 'agent' : 'other'
  return (
    <button className={`wlrow${on ? ' on' : ''}`} title={c.task?.key} onClick={() => onSelect(cardSelection(c))}>
      <div className="wltop">
        <span className={`wldot ${c.dot}`} aria-hidden />
        <span className="title">{c.title}</span>
        <span className="muted small wltime">{threadTime(c.at, now)}</span>
      </div>
      <div className="wlmeta small">
        <span className="wlkind">{c.kind}</span>
        {c.stage && <span className="wlstage">{c.stage}</span>}
        {c.progress && <span className="muted">{c.progress}</span>}
      </div>
      <div className={`wlmove small ${tone}`}>{c.move.who === 'you' ? `→ ${c.move.text}` : c.move.text}</div>
      {c.last && <div className="wllast muted small">{c.last.text} · {threadTime(c.last.at, now)}</div>}
    </button>
  )
}

/** mag crashed in an earlier run: the report is in the logs folder. */
function CrashRow({ crash, onDismiss }: { crash: CrashReport; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(crashMarkdown(crash)).then(() => setCopied(true))
  return (
    <div className="wlrow crash">
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
