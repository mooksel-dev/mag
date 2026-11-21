import { useEffect, useState } from 'react'
import {
  STATUS_LABELS,
  SUBTASK_STATUSES,
  canApprove,
  canCancel,
  canMoveSubtask,
  canReopen,
  stepRepoNames,
  subtaskProgress,
  taskPrs,
  type SessionHeader,
  type AgentState,
  type Project,
  type SubtaskStatus,
  type Task,
} from '@mag/core'
import { ago } from './format'
import { PrPills, TicketPill } from './LinkPill'
import { StartButton } from './LocalMode'
import { Icon, type IconName } from './ui/Icon'
import { Pill, type Tone } from './ui/Pill'

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

const STATUS_TONES: Record<Task['status'], Tone> = { planning: 'acc', ready: 'blue', todo: 'blue', in_progress: 'amber', done: 'green', canceled: 'red' }

export function StatusPill({ status }: { status: Task['status'] }) {
  return <Pill tone={STATUS_TONES[status]}>{STATUS_LABELS[status].toLowerCase()}</Pill>
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

const SUBTASK_ICONS: Record<SubtaskStatus, IconName> = { todo: 'circle', in_progress: 'circle-half', done: 'circle-check' }

/** An empty, half or checked circle for a subtask status. */
export function SubtaskIcon({ status }: { status: Task['status'] }) {
  const s = status as SubtaskStatus
  return <span className={`subicon sub-${s}`} title={STATUS_LABELS[s]} aria-label={STATUS_LABELS[s]}><Icon name={SUBTASK_ICONS[s] ?? 'circle'} size={14} /></span>
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
            <button className="iconbtn" aria-label="Ticket link" aria-haspopup="menu" aria-expanded={menu === t.url} title="Ticket link" onClick={() => setMenu((m) => (m === t.url ? null : t.url))}><Icon name="more" size={14} /></button>
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

/**
 * Approves the plan of a work in planning and starts it (ux-odna-rozmova-na-robotu.1), through the Start popup;
 * disabled, with the reason, while it has no step to do or an agent of it runs.
 */
export function ApproveButton({ task, tasks, sessions, project, small }: { task: Task; tasks: Task[]; sessions: SessionHeader[]; project?: Project; small?: boolean }) {
  const can = canApprove(task, tasks)
  const busy = sessions.some((s) => s.taskId === task.id && s.status === 'running')
  const why = !can.ok ? can.reason : busy ? 'An agent is running on this work' : 'Approve the plan and start its first step'
  return <StartButton task={task} tasks={tasks} project={project} label="Approve & Start" className={small ? 'small' : ''} disabled={!can.ok || busy} title={why} onStart={(local) => mag.approveAndStart(task.id, local)} />
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

/**
 * The task's steps in order. Steps: status follows the lifecycle (read-only icon); todo steps can be edited and swap
 * places. A legacy checklist: the user can tick, edit and reorder any step.
 */
export function SubtaskList({ parent, subs, tasks, steps, project }: { parent: Task; subs: Task[]; tasks: Task[]; steps: boolean; project?: Project }) {
  const move = (i: number, dir: 'up' | 'down') => {
    const ids = subs.map((t) => t.id)
    const j = dir === 'up' ? i - 1 : i + 1
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void mag.reorderSubtasks(parent.id, ids)
  }
  const { done, total } = subtaskProgress(parent.id, tasks)
  return (
    <>
      <div className="sublist">
        {subs.map((t, i) => (
          <SubtaskRow key={t.id} sub={t} steps={steps} project={project} canMove={(dir) => canMoveSubtask(t, tasks, dir)} onMove={(dir) => move(i, dir)} />
        ))}
      </div>
      <p className="muted small">
        {done}/{total} done.{' '}
        {steps
          ? 'Steps run one after another, each in a new developer session with its own branch and PRs. A step is done when its PRs are merged; the next one starts on its own unless it starts manually.'
          : 'A plan: one developer works through it in one session and marks each step in progress, then done. Click a circle to change it.'}
      </p>
    </>
  )
}

/** Clicking a checklist subtask's status icon steps todo → in progress → done → todo. */
const nextStatus = (s: Task['status']): SubtaskStatus => SUBTASK_STATUSES[(SUBTASK_STATUSES.indexOf(s as SubtaskStatus) + 1) % SUBTASK_STATUSES.length]

export function SubtaskRow({ sub, steps, project, canMove, onMove }: { sub: Task; steps: boolean; project?: Project; canMove: (dir: 'up' | 'down') => boolean; onMove: (dir: 'up' | 'down') => void }) {
  // The repositories the groomer planned for the step (T-50); an older step works in all of them and shows none.
  const repos = steps && project ? stepRepoNames(sub, project) : undefined
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(sub.title)
  const [note, setNote] = useState(sub.description)
  const [manual, setManual] = useState(!!sub.startManually)
  const done = sub.status === 'done'
  // A step that started keeps its plan; a checklist step can always be edited.
  const editable = !steps || sub.status === 'todo'
  const edit = () => {
    if (!editable) return
    setTitle(sub.title)
    setNote(sub.description)
    setManual(!!sub.startManually)
    setEditing(true)
  }
  const save = () => {
    if (title.trim()) void mag.updateTask(sub.id, { title: title.trim(), description: note.replace(/\s+/g, ' ').trim(), ...(steps && { startManually: manual }) })
    setEditing(false)
  }
  return (
    <div className={`subrow ${done ? 'done' : ''}`}>
      <span className="ord">
        {(['up', 'down'] as const).map((dir) => (
          <button key={dir} className="icon" disabled={!canMove(dir)} aria-label={`Move ${sub.key} ${dir}`} onClick={() => onMove(dir)}>
            <Icon name={dir === 'up' ? 'chev-u' : 'chev-d'} size={12} />
          </button>
        ))}
      </span>
      {steps ? (
        <span className="substatus"><SubtaskIcon status={sub.status} /></span>
      ) : (
        <button
          className="icon substatus"
          title={`${STATUS_LABELS[sub.status]}: click for ${STATUS_LABELS[nextStatus(sub.status)].toLowerCase()}`}
          aria-label={`${sub.key}: ${STATUS_LABELS[sub.status]}`}
          onClick={() => mag.setSubtaskStatus(sub.id, nextStatus(sub.status))}
        >
          <SubtaskIcon status={sub.status} />
        </button>
      )}
      <span className="key">{sub.key}</span>
      {editing ? (
        <form className="subedit" onSubmit={(e) => { e.preventDefault(); save() }} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Subtask title" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional, one line)" aria-label="Subtask note" />
          {steps && <label className="check small"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />start manually</label>}
          <button type="submit" className="primary">Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <>
          <div className="subtitle" onDoubleClick={edit}>
            <div className="subname">{sub.title}</div>
            {sub.description && <div className="muted small">{sub.description}</div>}
          </div>
          <span className="subextra">
            {steps && sub.startManually && <Pill title="Waits for your Start when the previous step is done">start manually</Pill>}
            {repos && <span className="muted small" title="Repositories the step changes; only they get a worktree">{repos.length ? repos.join(', ') : 'no code'}</span>}
            {steps && <PrPills prs={taskPrs(sub)} />}
            {editable && <button className="link small" onClick={edit}>Edit</button>}
          </span>
        </>
      )}
    </div>
  )
}
