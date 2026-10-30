import { useEffect, useState } from 'react'
import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  STATUS_LABELS,
  activeSections,
  agentState,
  archivedTasks,
  backlogTasks,
  canArchive,
  canCancel,
  canMoveInPlan,
  openPrs,
  subtaskProgress,
  subtasksOf,
  taskPrs,
  viewCounts,
  type AgentSession,
  type AgentState,
  type ArchiveFilter,
  type Project,
  type SubtaskStatus,
  type Task,
  type TaskStatus,
  type TaskType,
  type TasksView,
} from '@mag/core'
import { ago, prLabel } from './format'

const mag = window.mag
const TYPES: TaskType[] = ['dev', 'design', 'spike', 'research']

/** Re-renders every `ms` so durations keep growing. */
export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export function StatusPill({ status }: { status: TaskStatus }) {
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
export function SubtaskIcon({ status }: { status: TaskStatus }) {
  const s = status as SubtaskStatus
  return <span className={`subicon sub-${s}`} title={STATUS_LABELS[s]} aria-label={STATUS_LABELS[s]}>{SUBTASK_ICONS[s] ?? '○'}</span>
}

const VIEWS: [TasksView, string][] = [['active', 'Active'], ['backlog', 'Backlog'], ['archive', 'Archive']]

/** The Tasks tab: Active · Backlog · Archive. */
export function TasksPage({ project, tasks, sessions, view, onView, onOpen, focusNewTask }: {
  project: Project
  tasks: Task[]
  sessions: AgentSession[]
  view: TasksView
  onView: (v: TasksView) => void
  onOpen: (id: string) => void
  focusNewTask: boolean
}) {
  const counts = viewCounts(tasks)
  const now = useNow(15_000)
  const row = { tasks, sessions, now, onOpen }
  return (
    <section className="page">
      <div className="tasksbar">
        <h1>Tasks</h1>
        <div className="seg views" role="tablist" aria-label="Tasks view">
          {VIEWS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => onView(v)}>
              {label} <span className="cnt">{counts[v]}</span>
            </button>
          ))}
        </div>
      </div>
      {view === 'active' ? <ActiveView project={project} {...row} />
        : view === 'backlog' ? <BacklogView project={project} focusNewTask={focusNewTask} {...row} />
        : <ArchiveView {...row} />}
    </section>
  )
}

interface RowProps {
  tasks: Task[]
  sessions: AgentSession[]
  now: number
  onOpen: (id: string) => void
}

function ActiveView({ project, tasks, sessions, now, onOpen }: { project: Project } & RowProps) {
  const s = activeSections(tasks)
  const row = { tasks, sessions, now, onOpen }
  const days = project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS
  if (!s.inProgress.length && !s.todo.length && !s.grooming.length && !s.finished.length)
    return <p className="muted">Nothing active. Groom tasks from the Backlog: groomed tasks land in Todo, and you start them with Start.</p>
  return (
    <>
      <Section title="In progress" list={s.inProgress} empty="No task in progress." {...row} />
      <Section title="Todo" note="ready to start; order is priority; drag or ▲▼ to reorder" list={s.todo} empty="Nothing in todo." ordered {...row} />
      <Section title="Grooming" list={s.grooming} {...row} />
      <Section
        title="Recently finished"
        note={days > 0 ? `archived after ${days} days` : undefined}
        list={s.finished}
        action={s.finished.length > 0 && <button className="small" onClick={() => mag.archive(s.finished.map((t) => t.id))}>Archive all</button>}
        {...row}
      />
    </>
  )
}

function Section({ title, note, list, empty, ordered, action, ...row }: { title: string; note?: string; list: Task[]; empty?: string; ordered?: boolean; action?: React.ReactNode } & RowProps) {
  const [dragId, setDragId] = useState<string | null>(null)
  if (!list.length && !empty) return null
  /** Moves the dragged task step by step to `target`'s place; every step must be allowed. */
  const drop = async (target: Task) => {
    const from = list.findIndex((t) => t.id === dragId)
    const to = list.indexOf(target)
    setDragId(null)
    if (from < 0 || from === to) return
    const dir = to < from ? 'up' : 'down'
    for (let i = 0; i < Math.abs(to - from); i++) await mag.move(list[from].id, dir)
  }
  /** Can the dragged task get to `target`'s place: every task in between must be not started. */
  const canDrop = (target: Task) => {
    const from = list.findIndex((t) => t.id === dragId)
    const to = list.indexOf(target)
    if (from < 0 || from === to) return false
    return list.slice(Math.min(from, to), Math.max(from, to) + 1).every((t) => t.status === 'todo' && !t.work)
  }
  return (
    <div className="tasksec">
      <h2>
        {title} <span className="muted cnt">{list.length}</span>
        {note && <span className="muted small"> · {note}</span>}
        <span className="grow" />
        {action}
      </h2>
      {list.length ? (
        <div className="tree">
          {list.map((t, i) => (
            <TaskRow
              key={t.id}
              task={t}
              {...row}
              order={ordered ? i + 1 : undefined}
              drag={ordered ? { dragging: dragId === t.id, onStart: () => setDragId(t.id), onEnd: () => setDragId(null), canDrop: () => canDrop(t), onDrop: () => void drop(t) } : undefined}
              actions={ordered && (
                <span className="todoactions">
                  <StartButton task={t} sessions={row.sessions} />
                  <Moves task={t} tasks={row.tasks} />
                </span>
              )}
            />
          ))}
        </div>
      ) : (
        <p className="muted small">{empty}</p>
      )}
    </div>
  )
}

/** Starts development of a todo task. Not while it waits on the user or an agent of it is running. */
function StartButton({ task, sessions }: { task: Task; sessions: AgentSession[] }) {
  const busy = sessions.some((s) => s.taskId === task.id && s.status === 'running')
  const why = task.needsInput ? `Needs input: ${task.needsInput}` : busy ? 'An agent is running on this task' : `Start a developer on ${task.key}`
  return (
    <button className="small" disabled={!!task.needsInput || busy} title={why} onClick={() => mag.develop(task.id)}>
      Start
    </button>
  )
}

function Moves({ task, tasks }: { task: Task; tasks: Task[] }) {
  return (
    <span className="moves">
      {(['up', 'down'] as const).map((dir) => (
        <button key={dir} className="icon" disabled={!canMoveInPlan(task, tasks, dir)} aria-label={`Move ${task.key} ${dir}`} onClick={() => mag.move(task.id, dir)}>
          {dir === 'up' ? '▲' : '▼'}
        </button>
      ))}
    </span>
  )
}

interface Drag {
  dragging: boolean
  onStart: () => void
  onEnd: () => void
  canDrop: () => boolean
  onDrop: () => void
}

/** A task row: chevron, key, title, agent indicator, badges, progress and status; expands to its live subtasks. */
export function TaskRow({ task, tasks, sessions, now, onOpen, order, drag, actions, extra }: RowProps & {
  task: Task
  /** Position in the todo list: its priority. */
  order?: number
  drag?: Drag
  actions?: React.ReactNode
  /** Shown before the status, e.g. a PR link or the cancel reason. */
  extra?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const subs = subtasksOf(task.id, tasks)
  const progress = subtaskProgress(task.id, tasks)
  const prs = task.status === 'in_progress' ? openPrs(task) : []
  return (
    <div
      className={`taskrow-wrap ${drag?.dragging ? 'dragging' : ''} ${over ? 'dropover' : ''}`}
      draggable={!!drag && canDragRow(task, tasks)}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; drag?.onStart() }}
      onDragEnd={() => { setOver(false); drag?.onEnd() }}
      onDragOver={(e) => { if (drag?.canDrop()) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); drag?.onDrop() }}
    >
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
          {order !== undefined && <span className="ordno muted small">{order}</span>}
          <span className="key">{task.key}</span>
          <span className="title grow">{task.title}</span>
          <AgentDot state={agentState(task, sessions)} now={now} />
          {prs.length > 0 && <span className="pill green" title={prs.map((r) => r.prUrl).join('\n')}>PR open</span>}
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
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const canDragRow = (task: Task, tasks: Task[]) => canMoveInPlan(task, tasks, 'up') || canMoveInPlan(task, tasks, 'down')

function BacklogView({ project, tasks, sessions, now, onOpen, focusNewTask }: { project: Project; focusNewTask: boolean } & RowProps) {
  const list = backlogTasks(tasks)
  return (
    <>
      <NewTask projectId={project.id} autoFocus={focusNewTask} />
      {list.length ? (
        <div className="tree">
          {list.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              tasks={tasks}
              sessions={sessions}
              now={now}
              onOpen={onOpen}
              actions={
                <span className="rowactions">
                  <button className="small" onClick={() => mag.groom(t.id)}>Groom</button>
                  <CancelButton task={t} small />
                </span>
              }
            />
          ))}
        </div>
      ) : (
        <p className="muted">Backlog is empty.</p>
      )}
    </>
  )
}

const FILTERS: [ArchiveFilter, string][] = [['all', 'All'], ['done', 'Done'], ['canceled', 'Canceled']]

function ArchiveView({ tasks, sessions, now, onOpen }: RowProps) {
  const [filter, setFilter] = useState<ArchiveFilter>('all')
  const [query, setQuery] = useState('')
  const list = archivedTasks(tasks, filter, query)
  return (
    <>
      <div className="archivebar">
        <div className="seg" role="group" aria-label="Archive filter">
          {FILTERS.map(([f, label]) => (
            <button key={f} aria-pressed={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by key or title" aria-label="Search the archive" />
      </div>
      {list.length ? (
        <div className="tree">
          {list.map((t) => {
            const pr = taskPrs(t)[0]?.prUrl
            return (
              <TaskRow
                key={t.id}
                task={t}
                tasks={tasks}
                sessions={sessions}
                now={now}
                onOpen={onOpen}
                extra={
                  t.status === 'canceled' ? (t.cancelReason && <span className="muted small reason" title={t.cancelReason}>{t.cancelReason}</span>)
                  : pr && <span className="link small" role="link" onClick={(e) => { e.stopPropagation(); void mag.open(pr) }}>{prLabel(pr)}</span>
                }
                actions={<span className="rowactions"><button className="small" onClick={() => mag.restore(t.id)}>Restore</button></span>}
              />
            )
          })}
        </div>
      ) : (
        <p className="muted">{query || filter !== 'all' ? 'No archived tasks match.' : 'The archive is empty.'}</p>
      )}
    </>
  )
}

function NewTask({ projectId, autoFocus }: { projectId: string; autoFocus?: boolean }) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<TaskType>('dev')
  const [description, setDescription] = useState('')
  return (
    <form className="newtask" onSubmit={async (e) => { e.preventDefault(); if (!title.trim()) return; await mag.createTask({ projectId, title: title.trim(), type, description }); setTitle(''); setDescription('') }}>
      <input autoFocus={autoFocus} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title" aria-label="Task title" />
      <select value={type} onChange={(e) => setType(e.target.value as TaskType)} aria-label="Task type">
        {TYPES.map((t) => <option key={t}>{t}</option>)}
      </select>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What and why, as briefly as you like" aria-label="Task description" rows={2} />
      <button type="submit">Add to backlog</button>
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

/** Archive or Restore, where the task allows it. */
export function ArchiveButton({ task }: { task: Task }) {
  if (task.archivedAt) return <button onClick={() => mag.restore(task.id)}>Restore</button>
  if (canArchive(task)) return <button onClick={() => mag.archive([task.id])}>Archive</button>
  return null
}
