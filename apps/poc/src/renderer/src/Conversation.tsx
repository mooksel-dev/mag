import { useRef, useState } from 'react'
import {
  agentState,
  chatCommands,
  isReview,
  openPrs,
  prRepoName,
  resolveChoice,
  reviewTopic,
  shortTitle,
  workStage,
  type AgentSession,
  type Attachment,
  type Task,
  type WorkStage,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { WorkCards } from './Cards'
import { Chat, Composer, ModelChip } from './Chat'
import { prLabel } from './format'
import { CancelButton, ReopenButton, StatusPill, TicketLinks, AgentDot, useNow } from './Tasks'

const mag = window.mag

/**
 * The conversation of a work: its owner (the topic that planned it, or its groomer; a review's topic). Legacy works
 * without one fall back to their latest groomer.
 */
export function ownerSession(work: Task, sessions: AgentSession[]): AgentSession | null {
  return (
    sessions.find((s) => s.id === work.ownerSessionId)
    ?? (isReview(work) ? reviewTopic(work, sessions) : undefined)
    ?? sessions.filter((s) => s.taskId === work.id && s.role === 'groomer').at(-1)
    ?? null
  )
}

type Stage = Exclude<WorkStage, 'Done'>
const STAGES: Stage[] = ['Plan', 'Approve', 'Build', 'Merge']

function Stepper({ stage }: { stage: WorkStage }) {
  const at = stage === 'Done' ? STAGES.length : STAGES.indexOf(stage)
  return (
    <span className="stepper" aria-label={`Stage: ${stage}`}>
      {STAGES.map((s, i) => <span key={s} className={i < at ? 'past' : i === at ? 'now' : ''}>{s}</span>)}
    </span>
  )
}

/** The centre column for a work: its header, the owner conversation and, at its end, the cards of what waits on you. */
export function WorkConversation({ work, state, onOpenKey }: { work: Task; state: AppState; onOpenKey: (key: string) => void }) {
  const now = useNow(15_000)
  const box = useRef<HTMLDivElement>(null)
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const owner = ownerSession(work, state.sessions)
  const mine = state.sessions.filter((s) => s.taskId === work.id)
  const stage = workStage(work, tasks)
  const [fullBrief, setFullBrief] = useState(false)
  const review = isReview(work)
  const pr = work.prReview?.pr
  const canGroom = !review && !mine.some((s) => s.status === 'running') && !work.work && (work.status === 'planning' || work.status === 'ready')
  const focus = () => box.current?.querySelector('textarea')?.focus()
  const cards = <WorkCards work={work} owner={owner} state={state} onAnswer={focus} />
  return (
    <section className="convo" ref={box}>
      <div className="convohead">
        <div className="taskrow">
          <span className="key">{work.key}</span>
          {review && pr && project ? <button className="link" onClick={() => mag.open(pr.url)}>{prRepoName(project, pr)}#{pr.number} ↗</button> : <TicketLinks task={work} />}
          <StatusPill status={work.status} />
          {stage && !review && <Stepper stage={stage} />}
          <AgentDot state={agentState(work, mine, tasks)} now={now} />
          <div className="grow" />
          {canGroom && !owner && <button className="small" onClick={() => mag.groom(work.id)}>Groom</button>}
          {review && <button className="small" title="The whole review in its own window" onClick={() => mag.openWindow({ kind: 'review', taskId: work.id })}>Open review</button>}
          {!review && <ReopenButton task={work} />}
          {!review && <CancelButton task={work} small />}
        </div>
        <h1>{shortTitle(work)}</h1>
        {work.description && (
          <div className={`brief ${fullBrief ? 'full' : ''}`}>
            <span className="brieftext">{work.description}</span>
            <button className="link" onClick={() => setFullBrief((f) => !f)}>{fullBrief ? 'Less' : 'Full brief'}</button>
          </div>
        )}
        {work.status === 'canceled' && <CanceledLine work={work} tasks={tasks} />}
      </div>
      {owner ? (
        <Chat session={owner} sessions={state.sessions} onOpenTask={onOpenKey} placeholder="Write to the owner…" cards={cards} chip={project && owner.role === 'chat' ? <ModelChip project={project} activeModel={owner.activeModel} /> : undefined} />
      ) : (
        <div className="chatbox">
          <div className="items">
            <p className="muted small">This work has no owner conversation yet. Groom it: an agent reads the brief, plans the work with you here.</p>
            {cards}
          </div>
        </div>
      )}
    </section>
  )
}

function CanceledLine({ work, tasks }: { work: Task; tasks: Task[] }) {
  const prs = openPrs(work, tasks)
  return (
    <div className="muted small">
      Canceled{work.cancelReason ? `: ${work.cancelReason}` : '.'}
      {prs.length > 0 && <> Its PRs are still open; close them on GitHub: {prs.map((r) => <button key={r.prUrl} className="link" onClick={() => mag.open(r.prUrl!)}>{prLabel(r.prUrl!)}</button>)}</>}
    </div>
  )
}

/** The centre column for a topic without a work: rename, branch, delete, and its chat. */
export function TopicConversation({ topic, state, onOpenKey, onSelectTopic, onDeleted }: {
  topic: AgentSession
  state: AppState
  onOpenKey: (key: string) => void
  onSelectTopic: (id: string) => void
  onDeleted: () => void
}) {
  const project = state.projects.find((p) => p.id === topic.projectId)
  const parent = topic.branchOf ? state.sessions.find((s) => s.id === topic.branchOf) : undefined
  // A branch forks the topic's Claude Code session: only one that has a session, while chats run on Claude Code.
  const canBranch = !!topic.nativeSessionId && topic.agent === 'claude-code' && !!project && resolveChoice(project, 'chat').agent === 'claude-code'
  const remove = () => {
    if (confirm(`Delete topic "${topic.title ?? 'Topic'}"? Its history is lost.`)) void mag.deleteChat(topic.id).then(onDeleted)
  }
  const chip = project && <ModelChip project={project} activeModel={topic.activeModel} />
  return (
    <section className="convo">
      <div className="convohead">
        <div className="taskrow">
          <span className="muted small">Topic</span>
          <TopicTitle topic={topic} />
          <div className="grow" />
          <button className="iconbtn" disabled={!canBranch} onClick={() => mag.branchChat(topic.id).then(onSelectTopic, (e: Error) => alert(e.message))} aria-label="Branch" title={canBranch ? 'Branch: a new topic that starts with everything said here' : 'Branch: needs a topic with a Claude Code session (send a message first)'}>⑂</button>
          <button className="iconbtn" aria-label="Delete topic" title="Delete" onClick={remove}>🗑</button>
        </div>
        {topic.branchOf && (
          <div className="muted small">
            Branched from {parent ? <button type="button" className="link" onClick={() => onSelectTopic(parent.id)}>{parent.title ?? 'Topic'}</button> : 'a deleted topic'}
          </div>
        )}
      </div>
      {topic.items.length ? (
        <Chat session={topic} sessions={state.sessions} onOpenTask={onOpenKey} placeholder="Message…" chip={chip} />
      ) : (
        <div className="chatbox">
          <div className="items">
            <p className="muted small">
              Talk about the project: a problem, ideas, design, priorities. The agent reads the code, draws mockups, and
              plans a work with you; it never edits code itself.
            </p>
          </div>
          <Composer busy={false} placeholder="Message…" commands={chatCommands(topic, state.sessions)} onSend={(t: string, a: Attachment[]) => mag.send(topic.id, t, a)} chip={chip} />
        </div>
      )}
    </section>
  )
}

/** The topic's title; a click renames it, Enter saves, Esc cancels. */
function TopicTitle({ topic }: { topic: AgentSession }) {
  const title = topic.title ?? 'Topic'
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  if (draft === null) return <button className="topictitle" title="Rename" onClick={() => { cancelled.current = false; setDraft(title) }}>{title}</button>
  const save = () => {
    const t = draft.trim()
    setDraft(null)
    if (!cancelled.current && t && t !== title) void mag.renameChat(topic.id, t)
  }
  return (
    <input
      autoFocus
      className="topictitle"
      value={draft}
      aria-label="Topic title"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
      }}
    />
  )
}
