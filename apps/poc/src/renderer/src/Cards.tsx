import { useState } from 'react'
import {
  acceptRecommendations,
  currentStep,
  inbox,
  isLegacy,
  isReview,
  openLocalChecks,
  stepRepoNames,
  subtasksOf,
  taskPrs,
  type AgentSession,
  type InboxItem,
  type Project,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { ApprovalCard } from './Chat'
import { prLabel, prName } from './format'
import { LocalChecks, StartButton } from './LocalMode'
import { ApproveButton } from './Tasks'

const mag = window.mag

/**
 * What the work needs from the user, as cards at the end of its owner conversation (ux-odna-rozmova-na-robotu.2):
 * the questions with recommendations, the plan with Approve & Start, the merge, a failed agent or check, a step that
 * waits for Start, local checks, and approvals of its agents (their chats are logs).
 */
export function WorkCards({ work, owner, state, onAnswer }: {
  work: Task
  owner: AgentSession | null
  state: AppState
  /** Puts the cursor in the owner's composer: "Answer differently". */
  onAnswer: () => void
}) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  // Approvals have cards of their own; the one other item of the work is what waits on the user.
  const item = inbox(work.projectId, tasks, state.sessions).find((i) => i.task?.id === work.id && i.kind !== 'approval')
  const step = isLegacy(work) ? null : currentStep(work.id, tasks)
  const ownerBusy = owner?.status === 'running'
  // The owner's own approvals are in its chat; those of the work's other agents only here.
  const approvals = state.sessions
    .filter((s) => s.taskId === work.id && s.id !== owner?.id)
    .flatMap((s) => s.items.flatMap((i) => (i.kind === 'approval' && i.status === 'pending' ? [{ s, i }] : [])))
  return (
    <>
      {approvals.map(({ s, i }) => <ApprovalCard key={i.id} sessionId={s.id} item={i} who={s.role} />)}
      {step && openLocalChecks(step).length > 0 && <div className="workcard"><LocalChecks step={step} project={project} /></div>}
      {work.needsInput && !(step && openLocalChecks(step).length) && <QuestionsCard key={work.needsInput} work={work} owner={owner} busy={ownerBusy} onAnswer={onAnswer} />}
      {!ownerBusy && (work.status === 'planning' || work.status === 'ready') && <PlanCard work={work} tasks={tasks} project={project} state={state} />}
      {item && <ItemCard item={item} work={work} tasks={tasks} />}
    </>
  )
}

/** The agent's questions with its recommendations: one click accepts them all; anything else is typed to the owner. */
export function QuestionsCard({ work, owner, busy, onAnswer }: { work: Task; owner: AgentSession | null; busy: boolean; onAnswer: () => void }) {
  const [sent, setSent] = useState(false)
  const questions = work.needsQuestions ?? []
  const accept = () => {
    if (!owner) return
    setSent(true)
    mag.send(owner.id, acceptRecommendations(questions)).catch(() => setSent(false))
  }
  return (
    <div className="workcard ask">
      <div className="cardtitle">{questions.length ? `${questions.length} ${questions.length > 1 ? 'decisions' : 'decision'} needed from you` : 'Needs you'}</div>
      <div className="muted small">{work.needsInput}</div>
      {questions.length > 0 && (
        <ol className="questions">
          {questions.map((q, i) => (
            <li key={i}>
              <div>{q.text}</div>
              {q.recommendation && <div className="rec">★ {q.recommendation}</div>}
            </li>
          ))}
        </ol>
      )}
      {owner && (
        <div className="actions">
          {questions.length > 0 && <button className="primary" disabled={busy || sent} title={busy ? 'The owner is in a turn' : 'Send the owner: you accept its recommendations'} onClick={accept}>{sent ? 'Sent' : 'Accept recommendations'}</button>}
          <button onClick={onAnswer}>{questions.length ? 'Answer differently' : 'Answer'}</button>
        </div>
      )}
    </div>
  )
}

/** The plan of a work in planning (Approve & Start) or ready (Start): its steps, and what happens next on its own. */
export function PlanCard({ work, tasks, project, state }: { work: Task; tasks: Task[]; project?: Project; state: AppState }) {
  if (isReview(work)) return null
  const steps = subtasksOf(work.id, tasks)
  if (!steps.length) return null
  const sessions = state.sessions.filter((s) => s.taskId === work.id)
  return (
    <div className="workcard plan">
      <div className="cardtitle">Plan: {steps.length} {steps.length > 1 ? 'steps' : 'step'}</div>
      <ol className="plansteps">
        {steps.map((s) => {
          const repos = project ? stepRepoNames(s, project) : undefined
          return (
            <li key={s.id}>
              <span className="key">{s.key}</span> {s.title}
              {repos && <span className="muted small"> · {repos.length ? repos.join(', ') : 'no code'}</span>}
              {s.startManually && <span className="muted small"> · start manually</span>}
            </li>
          )
        })}
      </ol>
      <div className="actions">
        {work.status === 'planning'
          ? <ApproveButton task={work} tasks={tasks} sessions={sessions} project={project} />
          : <StartButton task={work} tasks={tasks} project={project} className="primary" disabled={!!work.needsInput || sessions.some((s) => s.status === 'running')} />}
        <span className="muted small">Then on its own: developer → PR → the owner's review → a Merge card here. To change the plan, tell the owner.</span>
      </div>
    </div>
  )
}

/** The work's inbox item as a card: merge, look, a failed agent or check, a step waiting for Start, a review ready. */
function ItemCard({ item, work, tasks }: { item: InboxItem; work: Task; tasks: Task[] }) {
  const { kind, text, review } = item
  const prs = taskPrs(work, tasks)
  const open = prs.filter((r) => r.prState !== 'merged' && r.prUrl).map((r) => r.prUrl!)
  if (kind === 'ready_to_merge' || kind === 'review_look') return <MergeCard text={text} review={review} open={open} look={kind === 'review_look'} />
  if (kind === 'check_failed') {
    const pr = prs.find((r) => r.checkError)?.prUrl
    return (
      <div className="workcard bad">
        <div className="cardtitle">PR check failed</div>
        <div className="muted small">{pr ? `${prName(pr)} · ` : ''}{text}</div>
        <div className="actions">
          {pr && <button onClick={() => mag.open(pr)}>Open PR ↗</button>}
          <button className="primary" onClick={() => mag.checkPrs()}>Check again</button>
        </div>
      </div>
    )
  }
  if (kind === 'agent_failed') {
    const last = item.session
    const restart = () => {
      if (isReview(work)) return mag.reviewAgain(work.id)
      if (last?.role === 'reviewer') return mag.review(work.id)
      // A work in progress is never groomed again: its developer goes on.
      if (last?.role !== 'groomer' || work.status === 'in_progress') return mag.develop(work.id)
      return mag.groom(work.id)
    }
    return (
      <div className="workcard bad">
        <div className="cardtitle">{text}</div>
        <div className="muted small">Its log is under Agents. Restart runs it again where it stopped.</div>
        <div className="actions"><button className="primary" onClick={() => void restart()}>Restart</button></div>
      </div>
    )
  }
  if (kind === 'ready_to_start') {
    return (
      <div className="workcard">
        <div className="cardtitle">{text}</div>
        <div className="actions"><button className="primary" onClick={() => mag.startStep(work.id)}>Start</button></div>
      </div>
    )
  }
  if (kind === 'review_ready') {
    return (
      <div className="workcard">
        <div className="cardtitle">Review ready</div>
        <div className="muted small">{text}. The findings and Publish are in the pane on the right.</div>
      </div>
    )
  }
  return null
}

/** The step's PRs wait for the user's merge: the owner's verdict, where to look, and the PRs to open. */
export function MergeCard({ text, review, open, look }: { text: string; review?: InboxItem['review']; open: string[]; look: boolean }) {
  return (
    <div className={`workcard ${look ? 'ask' : 'good'}`}>
      <div className="cardtitle">{look ? 'Look before merging' : 'Ready to merge'}</div>
      <div className="muted small">{text}</div>
      {review && review.findings.length > 1 && (
        <ul className="findings small">
          {review.findings.slice(1).map((f, i) => <li key={i}>{f.where && <code>{f.where}</code>} {f.text}</li>)}
        </ul>
      )}
      <div className="actions">
        {open.map((url) => <button key={url} className="primary" onClick={() => mag.open(url)}>{open.length > 1 ? prLabel(url) : 'Open PR ↗'}</button>)}
        <span className="muted small">Merge it yourself on GitHub; mag sees the merge and goes on. Comments on the PR go back to the developer.</span>
      </div>
    </div>
  )
}
