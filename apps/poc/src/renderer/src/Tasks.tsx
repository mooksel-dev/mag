import { useEffect, useState } from 'react'
import {
  STATUS_LABELS,
  agentState,
  canApprove,
  canCancel,
  canReopen,
  openPrs,
  subtaskProgress,
  subtasksOf,
  taskPrs,
  workSections,
  type AgentSession,
  type AgentState,
  type Project,
  type SubtaskStatus,
  type Task,
} from '@mag/core'
import { ago } from './format'
import { PrPills, TicketPill, TicketPills } from './LinkPill'
import { StartButton } from './LocalMode'

const mag = window.mag

/** Re-renders every `ms` so durations keep growing. */
export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export function StatusPill({ status }: { status: Task['status'] }) {
  return <span className={`status s-${status}`}>{STATUS_LABELS[status].toLowerCase()}</span>
}

/** Green pulsing dot + role and duration while an agent works; yellow + "waiting on you" (reason in the tooltip). */
export function AgentDot({ state, now }: { state: AgentState; now: number }) {
  if (!state) return null
  return state.kind === 'working' ? (
    <span className="agentstate working" title={`${state.role} is working`}>
      <span className="pdot" />{state.role} · {ago(state.since, now)}
    </span>
  ) : (
    <span className="agentstate waiting" title={state.reason}>
      <span className="pdot" />waiting on you
    </span>
  )
}

export const SUBTASK_ICONS: Record<SubtaskStatus, string> = { todo: '○', in_progress: '◐', done: '●' }

/** ○ / ◐ / ● for a subtask status. */
export function SubtaskIcon({ status }: { status: Task['status'] }) {
  const s = status as SubtaskStatus
  return <span className={`subicon sub-${s}`} title={STATUS_LABELS[s]} aria-label={STATUS_LABELS[s]}>{SUBTASK_ICONS[s] ?? '○'}</span>
}

/**
 * The work's tickets in its header (T-55.5): a pill per ticket with a ⋯ menu (Remove), and a quiet "+ Ticket" that opens
 * a URL field: Enter adds, Esc cancels, something that is not a link shows under it.
 */
export function TicketLinks({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const edit = () => { setUrl(''); setError(null); setMenu(null); setEditing(true) }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true)
    const r = await mag.addTicket(task.id, url.trim()).finally(() => setBusy(false))
    if ('error' in r) return setError(r.error)
    setEditing(false)
  }
  return (
    <>
      {(task.tickets ?? []).map((t) => (
        <span key={t.url} className="ticketlink">
          <TicketPill ticket={t} />
          <span className="menu">
            <button className="iconbtn" aria-label="Ticket link" aria-haspopup="menu" aria-expanded={menu === t.url} title="Ticket link" onClick={() => setMenu((m) => (m === t.url ? null : t.url))}>⋯</button>
            {menu === t.url && (
              <>
                <div className="menuscrim" onClick={() => setMenu(null)} />
                <div className="menulist small" role="menu">
                  <button role="menuitem" onClick={() => { setMenu(null); void mag.removeTicket(task.id, t.url) }}>Remove</button>
                </div>
              </>
            )}
          </span>
        </span>
      ))}
      {editing ? (
        <form className="ticketlink" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
          <input
            autoFocus
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null) }}
            onBlur={() => !url.trim() && setEditing(false)}
            placeholder="Ticket link (any tracker)"
            aria-label="Ticket URL"
            aria-invalid={!!error}
          />
          {error && <span className="err small" role="alert">{error}</span>}
        </form>
      ) : (
        <button className="link small" title="Add a ticket this work is about, by its link" onClick={edit}>{task.tickets?.length ? '+ Ticket' : 'Add ticket'}</button>
      )}
    </>
  )
}

/** Approves the plan of a work in planning (→ ready); disabled, with the reason, while it has no step to do. */
export function ApproveButton({ task, tasks, sessions, small }: { task: Task; tasks: Task[]; sessions: AgentSession[]; small?: boolean }) {
  const can = canApprove(task, tasks)
  const busy = sessions.some((s) => s.taskId === task.id && s.status === 'running')
  const why = !can.ok ? can.reason : busy ? 'An agent is running on this work' : 'Approve the plan: the work is ready to start'
  return (
    <button className={small ? 'small' : ''} disabled={!can.ok || busy} title={why} onClick={(e) => { e.stopPropagation(); void mag.approve(task.id) }}>
      Approve plan
    </button>
  )
}

/** Finished works shown before "Show all". */
const FINISHED_SHOWN = 10

/** The Tasks tab: works by state. No backlog (ideas have their own tab), priority or archive (T-55.7). */
export function TasksPage({ project, tasks, sessions, onOpen, fromTicket }: {
  project: Project
  tasks: Task[]
  sessions: AgentSession[]
  onOpen: (id: string) => void
  /** Open the ticket link field (from Home). */
  fromTicket: boolean
}) {
  const now = useNow(15_000)
  const [ticket, setTicket] = useState(fromTicket)
  const [allFinished, setAllFinished] = useState(false)
  const s = workSections(tasks)
  const row = { tasks, sessions, now, onOpen }
  const finished = allFinished ? s.finished : s.finished.slice(0, FINISHED_SHOWN)
  const empty = !s.inProgress.length && !s.ready.length && !s.planning.length && !s.finished.length
  return (
    <section className="page">
      <div className="tasksbar">
        <h1>Tasks</h1>
        <span className="grow" />
        {!ticket && <button title="Start a work from a ticket link; a groomer reads the ticket and plans it" onClick={() => setTicket(true)}>From a ticket</button>}
      </div>
      {ticket && <WorkFromTicket projectId={project.id} onOpen={onOpen} onClose={() => setTicket(false)} />}
      {empty ? (
        <p className="muted">No works yet. Discuss a problem in a project chat (it plans the work with you), start one from an idea or from a ticket link.</p>
      ) : (
        <>
          <Section title="In progress" list={s.inProgress} empty="No work in progress." {...row} />
          <Section title="Ready" note="plan approved; you start it" list={s.ready} rowActions={(t) => <span className="rowactions"><ReadyStart task={t} tasks={tasks} sessions={sessions} project={project} /></span>} {...row} />
          <Section title="Planning" list={s.planning} rowActions={(t) => <span className="rowactions"><ApproveButton task={t} tasks={tasks} sessions={sessions} small /></span>} {...row} />
          <Section
            title="Finished"
            list={finished}
            count={s.finished.length}
            action={s.finished.length > FINISHED_SHOWN && <button className="small" onClick={() => setAllFinished((a) => !a)}>{allFinished ? 'Show recent' : `Show all ${s.finished.length}`}</button>}
            extra={(t) => t.status === 'canceled' && t.cancelReason ? <span className="muted small reason" title={t.cancelReason}>{t.cancelReason}</span> : undefined}
            {...row}
          />
        </>
      )}
    </section>
  )
}

interface RowProps {
  tasks: Task[]
  sessions: AgentSession[]
  now: number
  onOpen: (id: string) => void
}

function Section({ title, note, list, count, empty, action, rowActions, extra, ...row }: {
  title: string
  note?: string
  list: Task[]
  /** When the list shows only some: how many there are. */
  count?: number
  empty?: string
  action?: React.ReactNode
  rowActions?: (t: Task) => React.ReactNode
  extra?: (t: Task) => React.ReactNode
} & RowProps) {
  if (!list.length && !empty) return null
  return (
    <div className="tasksec">
      <h2>
        {title} <span className="muted cnt">{count ?? list.length}</span>
        {note && <span className="muted small"> · {note}</span>}
        <span className="grow" />
        {action}
      </h2>
      {list.length ? (
        <div className="tree">
          {list.map((t) => <TaskRow key={t.id} task={t} {...row} actions={rowActions?.(t)} extra={extra?.(t)} />)}
        </div>
      ) : (
        <p className="muted small">{empty}</p>
      )}
    </div>
  )
}

/** Starts development of a ready work (the Start popup). Not while it waits on the user or an agent of it is running. */
function ReadyStart({ task, tasks, sessions, project }: { task: Task; tasks: Task[]; sessions: AgentSession[]; project: Project }) {
  const busy = sessions.some((s) => s.taskId === task.id && s.status === 'running')
  const why = task.needsInput ? `Needs input: ${task.needsInput}` : busy ? 'An agent is running on this work' : `Start a developer on ${task.key}`
  return <StartButton task={task} tasks={tasks} project={project} className="small" disabled={!!task.needsInput || busy} title={why} />
}

/** A work row: chevron, key, title, agent indicator, badges, progress and state; expands to its steps with their PRs. */
export function TaskRow({ task, tasks, sessions, now, onOpen, actions, extra }: RowProps & {
  task: Task
  actions?: React.ReactNode
  /** Shown before the status, e.g. a PR link or the cancel reason. */
  extra?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const subs = subtasksOf(task.id, tasks)
  const progress = subtaskProgress(task.id, tasks)
  const prs = task.status === 'in_progress' ? openPrs(task, tasks) : []
  return (
    <div className="taskrow-wrap">
      <div className="rowwrap">
        <button
          className="icon chevron"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} subtasks of ${task.key}`}
          disabled={!subs.length}
          onClick={() => setOpen((o) => !o)}
        >
          {subs.length ? (open ? '▾' : '▸') : ''}
        </button>
        <button className="row" onClick={() => onOpen(task.id)}>
          <span className="key">{task.key}</span>
          <span className="title grow">{task.title}</span>
          <TicketPills task={task} compact />
          <AgentDot state={agentState(task, sessions, tasks)} now={now} />
          <PrPills prs={prs} />
          {extra}
          {progress.total > 0 && <span className="muted small" title="Subtasks done">{progress.done}/{progress.total}</span>}
          <span className="type">{task.type}</span>
          <StatusPill status={task.status} />
        </button>
        {actions}
      </div>
      {open && subs.length > 0 && (
        <div className="subpeek">
          {subs.map((s) => (
            <div key={s.id} className={`subpeekrow sub-${s.status}`}>
              <SubtaskIcon status={s.status} />
              <span className="key">{s.key}</span>
              <span className="grow">{s.title}</span>
              {s.startManually && <span className="muted small" title="Waits for your Start">start manually</span>}
              <PrPills prs={taskPrs(s)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A ticket link → a new work, which opens; a groomer reads the ticket and plans it in the background. */
function WorkFromTicket({ projectId, onOpen, onClose }: { projectId: string; onOpen: (id: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true)
    const r = await mag.workFromTicket(projectId, url.trim()).finally(() => setBusy(false))
    if ('error' in r) return setError(r.error)
    onOpen(r.taskId)
  }
  return (
    <form className="newtask importtask" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <input
        autoFocus
        value={url}
        onChange={(e) => { setUrl(e.target.value); setError(null) }}
        placeholder="Ticket link, e.g. https://acme.atlassian.net/browse/ABC-12"
        aria-label="Ticket URL"
        aria-invalid={!!error}
      />
      <span className="newtaskactions">
        <button type="submit" className="primary" disabled={!url.trim() || busy}>Start</button>
        <button type="button" onClick={onClose}>Close</button>
      </span>
      {error ? <span className="err small" role="alert">{error}</span>
        : <span className="muted small">mag keeps only the link. A groomer reads the ticket any way your environment has (MCP, CLI) and plans the work; to plan it yourself, discuss it in a project chat instead.</span>}
    </form>
  )
}

/** Cancel with an optional reason; a running agent stops and the worktrees go. */
export function CancelButton({ task, small }: { task: Task; small?: boolean }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  if (!canCancel(task)) return null
  if (!asking) return <button className={small ? 'small' : ''} onClick={(e) => { e.stopPropagation(); setAsking(true) }}>Cancel</button>
  return (
    <form
      className="cancelform"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => { e.preventDefault(); void mag.cancel(task.id, reason.trim() || null); setAsking(false) }}
      onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
    >
      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label={`Why cancel ${task.key}`} />
      <button type="submit" className="danger small">Cancel {task.key}</button>
      <button type="button" className="small" onClick={() => setAsking(false)}>Keep</button>
    </form>
  )
}

/** Continue a done work (T-55.6): what else is needed goes to its owner, and the work is back in planning. */
export function ReopenButton({ task, onReopened }: { task: Task; onReopened?: () => void }) {
  const [asking, setAsking] = useState(false)
  const [what, setWhat] = useState('')
  if (!canReopen(task)) return null
  if (!asking) return <button title="More is needed: back to planning, its owner adds steps" onClick={() => setAsking(true)}>Continue</button>
  return (
    <form
      className="cancelform"
      onSubmit={(e) => {
        e.preventDefault()
        if (!what.trim()) return
        void mag.reopen(task.id, what.trim()).then(onReopened)
        setAsking(false)
        setWhat('')
      }}
      onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
    >
      <input autoFocus value={what} onChange={(e) => setWhat(e.target.value)} placeholder="What else is needed?" aria-label={`What else ${task.key} needs`} />
      <button type="submit" className="primary small" disabled={!what.trim()}>Continue {task.key}</button>
      <button type="button" className="small" onClick={() => setAsking(false)}>Keep done</button>
    </form>
  )
}
