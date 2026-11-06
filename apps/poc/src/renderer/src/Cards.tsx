import { useContext, useState } from 'react'
import {
  acceptRecommendations,
  currentStep,
  inbox,
  isLegacy,
  isReview,
  openLocalChecks,
  shortTitle,
  stepRepoNames,
  subtasksOf,
  taskPrs,
  type AgentSession,
  type CanvasRef,
  type InboxItem,
  type MoveAction,
  type Project,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { ApprovalCard, CanvasOpener } from './Chat'
import { canAskFor, integrationCard, mergeCard, type CardButton, type CardModel, type IntegrationItem } from './conversationCards'
import { prName } from './format'
import { LocalChecks, StartButton } from './LocalMode'
import { ApproveButton } from './Tasks'

const mag = window.mag

/**
 * What the work needs from the user, as cards at the end of its owner conversation (ux-odna-rozmova-na-robotu.2):
 * the questions with recommendations, the plan with Approve & Start, the merge, a failed agent or check, a step that
 * waits for Start, local checks, and approvals of its agents (their chats are logs). `label`: another work of the same
 * chat (work-list-the-left-column.3): its cards under a thin divider with its key and title, none when nothing waits.
 */
export function WorkCards({ work, owner, state, onAnswer, label = false }: {
  work: Task
  owner: AgentSession | null
  state: AppState
  /** Puts the cursor in the owner's composer: "Answer differently". */
  onAnswer: () => void
  label?: boolean
}) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  // Approvals have cards of their own; the one other item of the work is what waits on the user.
  const item = inbox(work.projectId, tasks, state.sessions).find((i) => i.task?.id === work.id && i.kind !== 'approval')
  const step = isLegacy(work) ? null : currentStep(work.id, tasks)
  const ownerBusy = owner?.status === 'running'
  // The owner's own approvals are in its chat; those of the work's other agents only here.
  const others = state.sessions.filter((s) => s.taskId === work.id && s.id !== owner?.id)
  const approvals = others.flatMap((s) => s.items.flatMap((i) => (i.kind === 'approval' && i.status === 'pending' ? [{ s, i }] : [])))
  // An agent of the work asked for an integration that is off for its role (decision 8): its card waits here too.
  const integrations = others.flatMap((s) => s.items.flatMap((i) => (i.kind === 'integration' && i.status === 'off' ? [{ s, i }] : [])))
  const checks = !!step && openLocalChecks(step).length > 0
  const questions = !!work.needsInput && !checks
  const plan = !ownerBusy && (work.status === 'planning' || work.status === 'ready') && !isReview(work) && subtasksOf(work.id, tasks).length > 0
  const itemShown = !!item && ITEM_CARDS.includes(item.kind)
  if (label && !approvals.length && !integrations.length && !checks && !questions && !plan && !itemShown) return null
  return (
    <>
      {label && <div className="cardsof" title={work.title}>{work.key} · {shortTitle(work)}</div>}
      {approvals.map(({ s, i }) => <ApprovalCard key={i.id} sessionId={s.id} item={i} who={s.role} />)}
      {integrations.map(({ s, i }) => <IntegrationCard key={i.id} sessionId={s.id} item={i} />)}
      {checks && <div className="workcard"><LocalChecks step={step} project={project} /></div>}
      {questions && <QuestionsCard key={work.needsInput} work={work} owner={owner} busy={ownerBusy} onAnswer={onAnswer} />}
      {plan && <PlanCard work={work} tasks={tasks} project={project} state={state} />}
      {itemShown && <ItemCard item={item} work={work} tasks={tasks} canvases={state.canvases} />}
    </>
  )
}

/** The inbox items ItemCard draws a card for (a question has QuestionsCard). */
const ITEM_CARDS: InboxItem['kind'][] = ['ready_to_merge', 'review_look', 'check_failed', 'agent_failed', 'ready_to_start', 'review_ready']

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
function ItemCard({ item, work, tasks, canvases }: { item: InboxItem; work: Task; tasks: Task[]; canvases: CanvasRef[] }) {
  const { kind, text, review } = item
  const prs = taskPrs(work, tasks)
  if (kind === 'ready_to_merge' || kind === 'review_look') {
    const step = isLegacy(work) ? null : currentStep(work.id, tasks)
    return <MergeCard card={mergeCard({ step, review, fact: step?.fact, look: kind === 'review_look', prs: step?.work?.repos ?? prs })} canvases={canvases} />
  }
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
    return (
      <div className="workcard bad">
        <div className="cardtitle">{text}</div>
        <div className="muted small">Its log is under Agents. Restart runs it again where it stopped.</div>
        <div className="actions"><button className="primary" onClick={() => void restartAgent(work, item.session)}>Restart</button></div>
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

/** Runs the failed agent of a work again: a review's agent, its reviewer, its developer, else its groomer. */
function restartAgent(work: Task, last: AgentSession | undefined) {
  if (isReview(work)) return mag.reviewAgain(work.id)
  if (last?.role === 'reviewer') return mag.review(work.id)
  // A work in progress is never groomed again: its developer goes on.
  if (last?.role !== 'groomer' || work.status === 'in_progress') return mag.develop(work.id)
  return mag.groom(work.id)
}

/**
 * The button of a card's move (work-list-the-left-column.2), for the Waiting-on-you bar: the same handlers as the cards
 * above. Approve & Start and Start are the cards' buttons (they pick local repos); a review's direction and Publish
 * happen in its review window. None where the conversation itself is the action (an approval card in it, a stopped
 * developer).
 */
export function MoveButton({ action, work, state, onAnswer }: { action: MoveAction; work: Task; state: AppState; onAnswer: () => void }) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const sessions = state.sessions.filter((s) => s.taskId === work.id)
  const openReview = () => mag.openWindow({ kind: 'review', taskId: work.id })
  switch (action.kind) {
    case 'open_pr':
      return <button className="primary small" onClick={() => mag.open(action.url)}>Open PR ↗</button>
    case 'approve_start':
      return <ApproveButton task={work} tasks={tasks} sessions={sessions} project={project} small />
    case 'start':
      return <StartButton task={work} tasks={tasks} project={project} className="primary small" disabled={!!work.needsInput || sessions.some((s) => s.status === 'running')} />
    case 'start_step':
      return <button className="primary small" onClick={() => mag.startStep(work.id)}>Start step</button>
    case 'answer':
      return <button className="primary small" onClick={onAnswer}>Answer…</button>
    case 'restart':
      return <button className="primary small" onClick={() => void restartAgent(work, state.sessions.find((s) => s.id === action.sessionId))}>Restart</button>
    case 'publish':
      return <button className="primary small" title="Publish from the review window: the verdict and the findings to post" onClick={openReview}>Publish…</button>
    case 'review_again':
      return <button className="primary small" onClick={() => mag.reviewAgain(work.id)}>Review again</button>
    case 'open':
      return isReview(work) ? <button className="primary small" onClick={openReview}>Open review</button> : null
  }
}

/** The step's PRs wait for the user's merge: the owner's verdict, the PRs' health, plan ↔ fact, what to check by hand. */
export function MergeCard({ card, canvases }: { card: CardModel; canvases: CanvasRef[] }) {
  const openCanvas = useContext(CanvasOpener)
  const onFact = (id: string) => {
    const c = canvases.find((x) => x.id === id)
    if (openCanvas && c) openCanvas(c)
    else void mag.openWindow({ kind: 'canvas', canvasId: id })
  }
  return <StructuredCard card={card} onFact={onFact} />
}

/** An integration off for an agent's role (decision 8): Enable: Ask / Auto turns it on and the agent repeats its step. */
export function IntegrationCard({ sessionId, item }: { sessionId: string; item: IntegrationItem }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enable = (mode: 'ask' | 'auto') => {
    setBusy(true)
    setError(null)
    mag.enableIntegration(sessionId, item.id, mode).catch((e) => setError(String((e as Error).message ?? e))).finally(() => setBusy(false))
  }
  return <StructuredCard card={integrationCard(item, canAskFor(item.role))} onEnable={enable} busy={busy} error={error} />
}

const VERDICT_CLASS = { good: 'ok', warn: 'look', bad: 'bad', neutral: '' } as const

/**
 * A card of the conversation from its model (conversationCards): a title with a verdict chip, short facts, 2–5 tagged
 * rows, folded details and the buttons in a footer.
 */
export function StructuredCard({ card, onEnable, onFact, busy, error }: {
  card: CardModel
  onEnable?: (mode: 'ask' | 'auto') => void
  /** Plan ↔ fact: opens the fact's canvas. */
  onFact?: (canvasId: string) => void
  busy?: boolean
  error?: string | null
}) {
  const press = (b: CardButton) => {
    if (b.kind === 'open_pr') return mag.open(b.url)
    if (b.kind === 'review_window') return mag.openWindow({ kind: 'review', taskId: b.taskId })
    if (b.kind === 'enable') return onEnable?.(b.mode)
    return onFact?.(b.canvasId)
  }
  return (
    <div className={`scard ${card.tone}`}>
      <div className="scardhead">
        <b>{card.title}</b>
        {card.verdict && <span className={`verdict ${VERDICT_CLASS[card.verdict.tone]}`}>{card.verdict.label}</span>}
      </div>
      <div className="scardbody">
        {card.stats.length > 0 && <div className="scardstats">{card.stats.map((x) => <span key={x}>{x}</span>)}</div>}
        {card.rows.map((r, i) => (
          <div key={i} className="scardrow">
            {r.tag && <span className={`tag t-${r.tag.replace(/ /g, '-')}`}>{r.tag}</span>}
            <span>{r.lead && <b>{r.lead} </b>}{r.text}</span>
          </div>
        ))}
        {card.details.map((d) => (
          <details key={d.summary} className="scardfold">
            <summary>{d.summary}</summary>
            <ul>{d.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </details>
        ))}
        {error && <div className="small err">{error}</div>}
      </div>
      {(card.buttons.length > 0 || card.note) && (
        <div className="scardfoot">
          {card.buttons.map((b) => <button key={`${b.kind}-${b.label}`} className={'primary' in b && b.primary ? 'primary' : ''} disabled={busy} onClick={() => void press(b)}>{b.label}</button>)}
          {card.note && <span className="muted small">{card.note}</span>}
        </div>
      )}
    </div>
  )
}
