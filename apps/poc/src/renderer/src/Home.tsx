import { useEffect, useRef, useState } from 'react'
import {
  agentState,
  currentStep,
  inbox,
  isLegacy,
  isReview,
  pipelineCounts,
  prRepoName,
  projectReviews,
  reviewLine,
  reviewOfTopic,
  reviewState,
  reviewTopic,
  runningAgents,
  taskPrs,
  type InboxItem,
  type InboxKind,
  type PipelineStage,
  type Project,
  type AgentSession,
  type ReviewState,
  type Task,
} from '@mag/core'
import type { AppState, CrashReport } from '../../preload/api'
import { projectTopics } from './Chat'
import { ago, crashMarkdown, inputPreview, prLabel, prName, threadTime } from './format'
import { AgentDot, useNow } from './Tasks'
import { LocalChecks } from './LocalMode'

const mag = window.mag

const STAGES: [PipelineStage, string][] = [
  ['planning', 'Planning'],
  ['ready', 'Ready'],
  ['in_progress', 'In progress'],
  ['done7d', 'Done · 7d'],
]

const PILLS: Record<InboxKind, [string, string]> = {
  approval: ['amber', 'Approval'],
  agent_failed: ['red', 'Agent failed'],
  check_failed: ['red', 'PR check failed'],
  question: ['amber', 'Question'],
  review_look: ['amber', 'Look here'],
  ready_to_merge: ['green', 'Ready to merge'],
  review_ready: ['violet', 'Review ready'],
  ready_to_start: ['amber', 'Waits for Start'],
}

const REVIEW_PILLS: Record<ReviewState, [string, string]> = {
  reviewing: ['', 'Reviewing'],
  question: ['amber', 'Question'],
  ready: ['violet', 'Ready'],
  failed: ['red', 'Failed'],
  outdated: ['amber', 'New commits'],
  waiting: ['', 'Waiting'],
  closed: ['', 'Closed'],
}

const RECENT = 15

export function Home({ project, tasks, state, topicId, onOpenTopic, onOpen, onOpenKey, onStage, onFromTicket }: {
  project: Project
  tasks: Task[]
  state: AppState
  /** The topic open in the chat aside, if the user picked one. */
  topicId: string | null
  /** Show the topic in the chat aside. */
  onOpenTopic: (id: string) => void
  onOpen: (id: string) => void
  onOpenKey: (key: string) => void
  /** Open the Tasks tab, which shows this stage. */
  onStage: (stage: PipelineStage) => void
  /** Open the ticket link field: a new work from a ticket. */
  onFromTicket: () => void
}) {
  const now = useNow(15_000)
  const counts = pipelineCounts(tasks, now)
  const items = inbox(project.id, tasks, state.sessions)
  const running = runningAgents(state.sessions).filter((s) => s.projectId === project.id)
  const events = state.events.filter((e) => e.projectId === project.id).slice(-RECENT).reverse()
  const keyOf = (taskId: string | null) => tasks.find((t) => t.id === taskId)?.key
  const [crash, setCrash] = useState<CrashReport | null>(null)
  useEffect(() => {
    mag.lastCrash().then(setCrash, () => {})
  }, [])
  const waiting = items.length + (crash ? 1 : 0)
  const reviews = projectReviews(tasks).filter((t) => t.status === 'in_progress')
  // A topic mag created for a review shows as its review, not among the topics.
  const reviewTopics = new Set(projectReviews(tasks).map((t) => reviewTopic(t, state.sessions)?.id))
  const topics = projectTopics(state.sessions, project.id).filter((t) => !reviewTopics.has(t.id))

  return (
    <section className="page home">
      <div className="homehead">
        <div>
          <h1>{project.name}</h1>
          <RepoLine project={project} />
        </div>
        <div className="grow" />
        <button title="A new topic: discuss the problem, and it plans the work with you" onClick={() => mag.newChat(project.id).then(onOpenTopic)}>+ New work</button>
        <button title="Start a work from a ticket link; a groomer reads the ticket and plans it" onClick={onFromTicket}>From a ticket</button>
      </div>

      <div className="tiles">
        {STAGES.map(([stage, label]) => (
          <button key={stage} className="tile" onClick={() => onStage(stage)}>
            <small>{label}</small>
            <div>{counts[stage]}</div>
          </button>
        ))}
      </div>

      <div className="col">
        <div className="card">
          <h2>Waiting on you <span className="muted">{waiting}</span></h2>
          {crash && <CrashRow crash={crash} onDismiss={() => mag.dismissCrash().then(() => setCrash(null))} />}
          {waiting ? items.map((i) =>
            i.kind === 'approval' ? <ApprovalRow key={i.approvalId} item={i} onOpen={onOpen} />
            : i.task && <InboxRow key={i.task.id} item={{ ...i, task: i.task }} state={state} now={now} onOpen={onOpen} />,
          ) : <p className="muted">Nothing is waiting on you.</p>}
        </div>
        {reviews.length > 0 && <Reviews project={project} reviews={reviews} sessions={state.sessions} onOpen={onOpen} />}
        <Topics topics={topics} openId={topicId} now={now} onOpen={onOpenTopic} onNew={() => mag.newChat(project.id).then(onOpenTopic)} />
      </div>

      <div className="side">
        <div className="card">
          <h2>Now · {running.length}</h2>
          {running.length ? running.map((s) => {
            // A review's topic goes by its review.
            const review = s.taskId ? undefined : reviewOfTopic(tasks, s.id)
            return (
              <div key={s.id} className="q">
                {s.taskId ? <button className="link key" onClick={() => onOpen(s.taskId!)}>{keyOf(s.taskId)}</button>
                  : review ? <button className="link key" onClick={() => onOpen(review.id)}>{review.key}</button>
                  : s.role === 'chat' ? <span className="muted small">chat</span> : null}
                <span className="grow" />
                <AgentDot state={{ kind: 'working', role: s.role, since: s.runStartedAt ?? s.createdAt }} now={now} />
              </div>
            )
          }) : <div className="muted small">No agents working.</div>}
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

/** Open reviews of teammates' PRs with their state: a click opens the review, ✕ deletes it after a confirm. */
function Reviews({ project, reviews, sessions, onOpen }: { project: Project; reviews: Task[]; sessions: AgentSession[]; onOpen: (id: string) => void }) {
  return (
    <div className="card">
      <h2>Reviews <span className="muted">{reviews.length}</span></h2>
      {reviews.map((t) => {
        const pr = t.prReview?.pr
        const [color, label] = REVIEW_PILLS[reviewState(t, sessions)]
        const remove = () => {
          if (!confirm(`Delete review ${t.key} "${t.title}"? It goes for good, with its diagrams and the topic mag created for it; nothing changes on GitHub.`)) return
          mag.deleteReview(t.id).catch((e) => alert(String((e as Error).message ?? e)))
        }
        return (
          <div key={t.id} className="topicrow" title={reviewLine(t, sessions)} onClick={() => onOpen(t.id)}>
            {reviewState(t, sessions) === 'reviewing' && <span className="dot live" />}
            {pr && <span className="key">{prRepoName(project, pr)}#{pr.number}</span>}
            <span className="title">{t.title.replace(/^[^:]*#\d+: /, '')}</span>
            {pr && <span className="muted small">@{pr.author}</span>}
            <span className="grow" />
            <span className={`pill ${color}`}>{label}</span>
            <button className="iconbtn" aria-label="Delete review" title="Delete review" onClick={act(remove)}>✕</button>
          </div>
        )
      })}
    </div>
  )
}

/** Project chats as topics: open one in the chat aside, rename it inline, delete it. */
function Topics({ topics, openId, now, onOpen, onNew }: { topics: AgentSession[]; openId: string | null; now: number; onOpen: (id: string) => void; onNew: () => void }) {
  // The aside shows the newest topic when none is picked (or the picked one is gone).
  const shown = topics.find((t) => t.id === openId) ?? topics[0]
  return (
    <div className="card">
      <div className="cardhead">
        <h2>Topics <span className="muted">{topics.length}</span></h2>
        <div className="grow" />
        <button className="small" onClick={onNew}>+ New topic</button>
      </div>
      {topics.length ? topics.map((t) => <TopicRow key={t.id} topic={t} open={t === shown} now={now} onOpen={() => onOpen(t.id)} />) : <p className="muted">No topics yet.</p>}
    </div>
  )
}

function TopicRow({ topic, open, now, onOpen }: { topic: AgentSession; open: boolean; now: number; onOpen: () => void }) {
  const title = topic.title ?? 'Topic'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  // Esc cancels: the blur that follows must not save.
  const cancelled = useRef(false)
  const startEdit = () => {
    cancelled.current = false
    setDraft(title)
    setEditing(true)
  }
  const save = () => {
    setEditing(false)
    if (cancelled.current) return
    const t = draft.trim()
    if (t && t !== title) void mag.renameChat(topic.id, t)
  }
  const remove = () => {
    if (confirm(`Delete topic "${title}"? Its history is lost.`)) void mag.deleteChat(topic.id)
  }
  return (
    <div className={`topicrow${open ? ' on' : ''}`} onClick={editing ? undefined : onOpen}>
      {topic.status === 'running' && <span className="dot live" />}
      {editing ? (
        <input
          autoFocus
          value={draft}
          aria-label="Topic title"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              cancelled.current = true
              e.currentTarget.blur()
            }
          }}
        />
      ) : (
        <span className="title" title={title}>{title}</span>
      )}
      <span className="grow" />
      <span className="muted small">{threadTime(topic.createdAt, now)}</span>
      <button className="iconbtn" aria-label="Rename topic" title="Rename" onClick={act(startEdit)}>✎</button>
      <button className="iconbtn" aria-label="Delete topic" title="Delete" onClick={act(remove)}>🗑</button>
    </div>
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

/** mag crashed in an earlier run: the report is in the logs folder. */
function CrashRow({ crash, onDismiss }: { crash: CrashReport; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(crashMarkdown(crash)).then(() => setCopied(true))
  return (
    <div className="inboxrow" onClick={() => mag.openLogs()}>
      <span className="pill red">Crash</span>
      <div className="grow">
        <div className="title">mag crashed at {new Date(crash.time).toLocaleString()}</div>
        <div className="muted small">{crash.kind}{crash.screen ? ` on ${crash.screen}` : ''}: {crash.message.split('\n')[0]}</div>
      </div>
      <button onClick={act(onDismiss)}>Dismiss</button>
      <button className="primary" onClick={act(copy)}>{copied ? 'Copied' : 'Copy report'}</button>
    </div>
  )
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

function InboxRow({ item, state, now, onOpen }: { item: InboxItem & { task: Task }; state: AppState; now: number; onOpen: (id: string) => void }) {
  const { task, kind, text, review } = item
  const [color, label] = PILLS[kind]
  const prs = taskPrs(task, state.tasks)
  const step = isLegacy(task) ? null : currentStep(task.id, state.tasks)
  // The PR whose check failed, else the first one still open.
  const pr = (kind === 'check_failed' ? prs.find((r) => r.checkError) : prs.find((r) => r.prState !== 'merged'))?.prUrl ?? prs[0]?.prUrl
  const open = prs.filter((r) => r.prState !== 'merged' && r.prUrl).map((r) => r.prUrl!)
  const restart = () => {
    const last = item.session
    // A review of a teammate's PR whose topic failed: its PR gets another look.
    if (isReview(task)) return mag.reviewAgain(task.id)
    if (last?.role === 'reviewer') return mag.review(task.id)
    // A task in progress is never groomed again: its developer goes on.
    if (last?.role !== 'groomer' || task.status === 'in_progress') return mag.develop(task.id)
    return mag.groom(task.id)
  }
  const sub =
    kind === 'check_failed' && pr ? `${prName(pr)} · ${text}`
    : kind === 'ready_to_merge' && open.length ? `${review ? `${text} · ` : ''}${open.map(prName).join(', ')} · merge ${open.length > 1 ? 'them' : 'it'} yourself; comments go back to the agent`
    : text

  return (
    <div className="inboxrow" onClick={() => onOpen(task.id)}>
      <span className={`pill ${color}`}>{label}</span>
      <span className="key">{task.key}</span>
      <div className="grow">
        <div className="title">{task.title}</div>
        <div className="muted small">{sub}</div>
        {/* A question of the step's local checks (T-50) is answered right here. */}
        {kind === 'question' && step && <LocalChecks step={step} project={state.projects.find((p) => p.id === task.projectId)} compact />}
        {/* The agent review's findings (T-55.1): where to look before merging. */}
        {review && review.findings.length > 1 && (
          <ul className="findings small">
            {review.findings.slice(1).map((f, i) => <li key={i}>{f.where && <code>{f.where}</code>} {f.text}</li>)}
          </ul>
        )}
      </div>
      <AgentDot state={agentState(task, state.sessions, state.tasks)} now={now} />
      {kind === 'agent_failed' && <><button onClick={act(() => onOpen(task.id))}>Open</button><button className="primary" onClick={act(restart)}>Restart</button></>}
      {kind === 'check_failed' && <>{pr && <button onClick={act(() => mag.open(pr))}>Open PR ↗</button>}<button className="primary" onClick={act(() => mag.checkPrs())}>Check again</button></>}
      {kind === 'question' && <button className="primary" onClick={act(() => onOpen(task.id))}>Answer</button>}
      {kind === 'ready_to_start' && <button className="primary" onClick={act(() => mag.startStep(task.id))}>Start</button>}
      {(kind === 'ready_to_merge' || kind === 'review_look') &&
        open.map((url) => <button key={url} className="primary" onClick={act(() => mag.open(url))}>{open.length > 1 ? prLabel(url) : 'Open PR ↗'}</button>)}
    </div>
  )
}
