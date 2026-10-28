import { useEffect, useState } from 'react'
import {
  STATUS_LABELS,
  inbox,
  pipelineCounts,
  queueHead,
  taskPrs,
  type InboxItem,
  type InboxKind,
  type PipelineStage,
  type Project,
  type Task,
  type TaskStatus,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { ago, inputPreview, prLabel, prName } from './format'

const mag = window.mag

const STAGES: [PipelineStage, string][] = [
  ['backlog', 'Backlog'],
  ['grooming', 'Grooming'],
  ['groomed', 'Groomed'],
  ['planned', 'Planned'],
  ['in_progress', 'In progress'],
  ['in_review', 'In review'],
  ['done7d', 'Done · 7d'],
]
/** Tiles that mean the user can act; highlighted when not zero. */
const HIGHLIGHT: PipelineStage[] = ['groomed', 'in_review']

const PILLS: Record<InboxKind, [string, string]> = {
  approval: ['amber', 'Approval'],
  agent_failed: ['red', 'Agent failed'],
  check_failed: ['red', 'PR check failed'],
  question: ['amber', 'Question'],
  ready_to_merge: ['green', 'Ready to merge'],
  groomed: ['violet', 'Groomed'],
}

const RECENT = 15

/** Re-renders every `ms` so durations keep growing. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export function Home({ project, tasks, state, onOpen, onOpenKey, onFilter, onNewTask }: {
  project: Project
  tasks: Task[]
  state: AppState
  onOpen: (id: string) => void
  onOpenKey: (key: string) => void
  /** Open Backlog or Plan filtered to this status. */
  onFilter: (status: TaskStatus) => void
  onNewTask: () => void
}) {
  const now = useNow(15_000)
  const counts = pipelineCounts(tasks, now)
  const items = inbox(project.id, tasks, state.sessions)
  const running = state.sessions.filter(
    (s) => s.status === 'running' && (tasks.some((t) => t.id === s.taskId) || (s.role === 'architect' && s.projectId === project.id)),
  )
  const { current, next } = queueHead(tasks)
  const events = state.events.filter((e) => e.projectId === project.id).slice(-RECENT).reverse()
  const keyOf = (taskId: string | null) => tasks.find((t) => t.id === taskId)?.key

  return (
    <section className="page home">
      <div className="homehead">
        <div>
          <h1>{project.name}</h1>
          <RepoLine project={project} />
        </div>
        <div className="grow" />
        <button onClick={onNewTask}>+ New task</button>
      </div>

      <div className="tiles">
        {STAGES.map(([stage, label]) => (
          <button key={stage} className={`tile ${HIGHLIGHT.includes(stage) && counts[stage] > 0 ? 'hl' : ''}`} onClick={() => onFilter(stage === 'done7d' ? 'done' : stage)}>
            <small>{label}</small>
            <div>{counts[stage]}</div>
          </button>
        ))}
      </div>

      <div className="card">
        <h2>Waiting on you <span className="muted">{items.length}</span></h2>
        {items.length ? items.map((i) =>
          i.kind === 'approval' ? <ApprovalRow key={i.approvalId} item={i} onOpen={onOpen} />
          : i.task && <InboxRow key={i.task.id} item={{ ...i, task: i.task }} state={state} onOpen={onOpen} />,
        ) : <p className="muted">Nothing is waiting on you.</p>}
      </div>

      <div className="side">
        <div className="card">
          <h2>Now</h2>
          {running.length ? running.map((s) => (
            <div key={s.id} className="q">
              <span className="dot live" />
              {s.taskId ? <button className="link key" onClick={() => onOpen(s.taskId!)}>{keyOf(s.taskId)}</button> : null}
              <span>{s.role}</span>
              <span className="grow" />
              <span className="muted">{ago(s.runStartedAt ?? s.createdAt, now)}</span>
            </div>
          )) : <div className="muted small">No agents working.</div>}
          <div className="muted small qnext">
            {next ? (
              <>Next in queue: <button className="link key" onClick={() => onOpen(next.id)}>{next.key}</button>{current && ` (after ${current.key} is merged)`}</>
            ) : current ? `Working on ${current.key}; nothing after it in the plan.` : 'The plan is empty.'}
          </div>
          <button className="link small" onClick={() => mag.checkPrs()}>check PRs now</button>
        </div>

        <div className="card">
          <h2>Recent</h2>
          {events.length ? events.map((e) => (
            <div key={e.id} className="ev">
              {e.taskKey && <><button className="link key" onClick={() => onOpenKey(e.taskKey!)}>{e.taskKey}</button> </>}
              {e.text} · <span className="muted">{ago(e.at, now)}</span>
            </div>
          )) : <div className="muted small">Nothing has happened yet.</div>}
        </div>
      </div>
    </section>
  )
}

function RepoLine({ project }: { project: Project }) {
  const repo = project.repos[0]
  const [origin, setOrigin] = useState<string | null>(null)
  useEffect(() => {
    setOrigin(null)
    if (repo) mag.repoInfo(repo).then((i) => setOrigin(i.origin))
  }, [repo])
  if (!repo) return <div className="muted small">No repository yet. Add one in Settings.</div>
  return <div className="muted small">{[repo, project.baseBranch, origin].filter(Boolean).join(' · ')}</div>
}

const act = (fn: () => unknown) => (e: React.MouseEvent) => { e.stopPropagation(); void fn() }

/** An ask-mode integration call from a task agent or a project chat. */
function ApprovalRow({ item, onOpen }: { item: InboxItem; onOpen: (id: string) => void }) {
  const { task, session, approvalId, text } = item
  const approval = session?.items.find((i) => i.kind === 'approval' && i.id === approvalId)
  if (!session || !approvalId || approval?.kind !== 'approval') return null
  const [color, label] = PILLS.approval
  return (
    <div className="inboxrow" onClick={() => task && onOpen(task.id)}>
      <span className={`pill ${color}`}>{label}</span>
      {task ? <span className="key">{task.key}</span> : <span className="muted small">Chat</span>}
      <div className="grow">
        <div className="title">{task ? task.title : (session.title ?? 'Project chat')}</div>
        <div className="muted small">{session.role} {text}</div>
        <div className="input muted">{inputPreview(approval.input)}</div>
      </div>
      <button onClick={act(() => mag.decideApproval(session.id, approvalId, false))}>Deny</button>
      <button className="primary" onClick={act(() => mag.decideApproval(session.id, approvalId, true))}>Allow</button>
    </div>
  )
}

function InboxRow({ item, state, onOpen }: { item: InboxItem & { task: Task }; state: AppState; onOpen: (id: string) => void }) {
  const { task, kind, text } = item
  const [blockers, setBlockers] = useState<string[]>([])
  const [color, label] = PILLS[kind]
  const prs = taskPrs(task)
  // The PR whose check failed, else the first one still open.
  const pr = (kind === 'check_failed' ? prs.find((r) => r.checkError) : prs.find((r) => r.prState !== 'merged'))?.prUrl ?? prs[0]?.prUrl
  const open = prs.filter((r) => r.prState !== 'merged' && r.prUrl).map((r) => r.prUrl!)
  const restart = () => {
    const last = state.sessions.filter((s) => s.taskId === task.id && (s.role === 'groomer' || s.role === 'developer')).at(-1)
    return last?.role === 'groomer' ? mag.groom(task.id) : mag.develop(task.id)
  }
  const addToPlan = async () => {
    const r = await mag.addToPlan(task.id)
    setBlockers(r.ok ? [] : r.reasons)
  }
  const sub =
    kind === 'check_failed' && pr ? `${prName(pr)} · ${text}`
    : kind === 'ready_to_merge' && open.length ? `${open.map(prName).join(', ')} · merge ${open.length > 1 ? 'them' : 'it'} yourself; comments go back to the agent`
    : text

  return (
    <div className="inboxrow" onClick={() => onOpen(task.id)}>
      <span className={`pill ${color}`}>{label}</span>
      <span className="key">{task.key}</span>
      <div className="grow">
        <div className="title">{task.title}</div>
        <div className="muted small">{sub}</div>
        {blockers.length > 0 && <div className="small blockers">Can't add to plan: {blockers.join(' · ')}</div>}
      </div>
      {kind === 'agent_failed' && <><button onClick={act(() => onOpen(task.id))}>Open</button><button className="primary" onClick={act(restart)}>Restart</button></>}
      {kind === 'check_failed' && <>{pr && <button onClick={act(() => mag.open(pr))}>Open PR ↗</button>}<button className="primary" onClick={act(() => mag.checkPrs())}>Check again</button></>}
      {kind === 'question' && <button className="primary" onClick={act(() => onOpen(task.id))}>Answer</button>}
      {kind === 'ready_to_merge' &&
        open.map((url) => <button key={url} className="primary" onClick={act(() => mag.open(url))}>{open.length > 1 ? prLabel(url) : 'Open PR ↗'}</button>)}
      {kind === 'groomed' && <><button onClick={act(() => onOpen(task.id))}>Review</button><button className="primary" onClick={act(addToPlan)}>Add to plan</button></>}
    </div>
  )
}

/** "Status: In review ✕" above a filtered Backlog or Plan list. */
export function StatusChip({ status, onClear }: { status: TaskStatus; onClear: () => void }) {
  return (
    <div className="statuschip">
      Status: {STATUS_LABELS[status]}
      <button className="icon" aria-label="Clear status filter" onClick={onClear}>✕</button>
    </div>
  )
}
