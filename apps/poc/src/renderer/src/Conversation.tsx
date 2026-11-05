import { Fragment, useCallback, useRef, useState } from 'react'
import {
  agentState,
  chatCommands,
  isLegacy,
  isReview,
  openPrs,
  prRepoName,
  reviewTopic,
  shortTitle,
  stepsLine,
  subtaskProgress,
  workCard,
  workStage,
  type AgentSession,
  type Attachment,
  type CanvasRef,
  type CardMove,
  type ReviewStage,
  type StepLine,
  type Task,
  type WorkStage,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { AgentsTab, DiagramsTab, DocTab, PlanTab, ReviewTab, useWorkCanvases, workSessions } from './ArtifactPane'
import { MoveButton, WorkCards } from './Cards'
import { CanvasOpener, Chat, Composer, ModelChip } from './Chat'
import { DiagramDrawer, type DrawerCanvas } from './Drawer'
import { prLabel } from './format'
import { ReopenButton, TicketLinks, AgentDot, useNow } from './Tasks'
import { RowMenu, type MenuCard, type Selection } from './WorkList'

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

const WORK_STAGES: WorkStage[] = ['Plan', 'Approve', 'Build', 'Merge']
const REVIEW_STAGES: ReviewStage[] = ['Running', 'Report ready', 'Waiting for author']

/** A work's stages Plan → Merge, a review's Running → Waiting for author; Done shows them all past. */
function Stepper({ stage, stages }: { stage: WorkStage | ReviewStage; stages: (WorkStage | ReviewStage)[] }) {
  const at = stage === 'Done' ? stages.length : stages.indexOf(stage)
  return (
    <span className="stepper" aria-label={`Stage: ${stage}`}>
      {stages.map((s, i) => <span key={s} className={i < at ? 'past' : i === at ? 'now' : ''}>{s}</span>)}
    </span>
  )
}

const STEP_STATE: Record<StepLine['state'], string> = { done: 'done', merge: 'merge', build: 'building', waiting: 'waits', manual: 'start manually', todo: 'next' }
const stepState = (s: StepLine) => (s.state === 'waiting' ? `waits for ${s.waitsFor}` : STEP_STATE[s.state])

/**
 * The work's steps as one line of chips: "✓ 1 · Model · PR #84 › 2 · Rows · PR #85 · merge"; done ones green, the
 * current one amber with where it stands; every chip names its key and state on hover.
 */
export function StepChips({ steps }: { steps: StepLine[] }) {
  const current = steps.find((s) => s.state !== 'done')
  return (
    <div className="stepchips" aria-label="Steps">
      {steps.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <span className="arrow" aria-hidden>›</span>}
          <span className={`stepchip${s.state === 'done' ? ' done' : s === current ? ' now' : ''}`} title={`${s.key} · ${s.title} · ${stepState(s)}`}>
            <span className="t">{s.state === 'done' ? '✓ ' : ''}{s.no} · {s.title}</span>
            {s.pr && <span> · {s.pr}</span>}
            {s === current && <span> · {stepState(s)}</span>}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

/** "Waiting on you: <the row's move>" with the button for it (work-list-the-left-column.2). */
function WaitingBar({ move, work, state, onAnswer }: { move: CardMove; work: Task; state: AppState; onAnswer: () => void }) {
  return (
    <div className="waitingbar" role="status">
      <b>Waiting on you</b>
      <span>{move.text}</span>
      {move.action && <MoveButton action={move.action} work={work} state={state} onAnswer={onAnswer} />}
    </div>
  )
}

export type WorkTab = 'conversation' | 'plan' | 'diagrams' | 'doc' | 'agents' | 'review'

/** A work's tabs: Conversation · Plan & steps · Diagrams · Doc · Agents; a review's Conversation · Review · Agents. */
export function WorkTabs({ work, state, tab, onTab }: { work: Task; state: AppState; tab: WorkTab; onTab: (tab: WorkTab) => void }) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const { diagrams, canvases } = useWorkCanvases(work, state)
  const progress = subtaskProgress(work.id, tasks)
  const agents = workSessions(work, state).length
  const tabs: [WorkTab, string, string | number | null][] = isReview(work)
    ? [['conversation', 'Conversation', null], ['review', 'Review', null], ['agents', 'Agents', agents || null]]
    : [
      ['conversation', 'Conversation', null],
      ['plan', 'Plan & steps', progress.total ? `${progress.done}/${progress.total}` : null],
      ['diagrams', 'Diagrams', diagrams.length + canvases.length || null],
      ['doc', 'Doc', null],
      ['agents', 'Agents', agents || null],
    ]
  return (
    <div className="worktabs" role="tablist">
      {tabs.map(([id, label, n]) => (
        <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => onTab(id)}>
          {label}{n !== null && <span className="n">{n}</span>}
        </button>
      ))}
    </div>
  )
}

/** The header's ⋯: the same menu as the row's in the sidebar. */
function HeadMenu({ card, onSelect, onGone }: { card: MenuCard; onSelect: (s: Selection) => void; onGone: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="menu">
      <button className="iconbtn" aria-label={`More for ${card.title}`} aria-haspopup="menu" aria-expanded={open} title="Rename, close, delete…" onClick={() => setOpen(!open)}>⋯</button>
      {open && <RowMenu card={card} className="wlmenu headmenu" onClose={() => setOpen(false)} onSelect={onSelect} onGone={onGone} />}
    </span>
  )
}

/** The drawer of a screen: the canvas open in it, and the opener canvas cards below it use. */
function useDrawer() {
  const [open, setOpen] = useState<DrawerCanvas | null>(null)
  const show = useCallback((c: CanvasRef | string, focus?: string) => setOpen({ id: typeof c === 'string' ? c : c.id, focus }), [])
  const close = useCallback(() => setOpen(null), [])
  return { open, show, close }
}

/**
 * A work's screen (redesign-start-screen-big-composer.3): a compact header (title, kind and key, ⋯), its steps as
 * chips, the Waiting bar and the tabs; below, the tab open and, when a diagram is opened, the drawer at the right. The
 * conversation is its owner's chat, with the cards of what waits on you at its end.
 */
export function WorkConversation({ work, state, onOpenKey, onSelect, onDeleted }: {
  work: Task
  state: AppState
  onOpenKey: (key: string) => void
  onSelect: (s: Selection) => void
  /** The work is gone (deleted from its menu or its review page). */
  onDeleted: () => void
}) {
  const now = useNow(15_000)
  const box = useRef<HTMLDivElement>(null)
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const owner = ownerSession(work, state.sessions)
  const mine = workSessions(work, state)
  const review = isReview(work)
  // The same card as the work's row: its stage and whose move. A review without a stage (asking, failed) has none here
  // either.
  const card = workCard(work, tasks, state.sessions, now)
  const stage = card ? card.stage : review ? null : workStage(work, tasks)
  // A legacy work's subtasks are a checklist, not steps.
  const steps = review || isLegacy(work) ? [] : stepsLine(work, tasks)
  const [tab, setTab] = useState<WorkTab>('conversation')
  const drawer = useDrawer()
  const [fullBrief, setFullBrief] = useState(false)
  const pr = work.prReview?.pr
  const canGroom = !review && !mine.some((s) => s.status === 'running') && !work.work && (work.status === 'planning' || work.status === 'ready')
  // An answer goes to the conversation: back to its tab, then into the composer.
  const focus = () => {
    setTab('conversation')
    requestAnimationFrame(() => box.current?.querySelector<HTMLTextAreaElement>('.screenmain textarea')?.focus())
  }
  const cards = <WorkCards work={work} owner={owner} state={state} onAnswer={focus} />
  return (
    <CanvasOpener.Provider value={drawer.show}>
      <section className="convo" ref={box}>
        <header className="convohead">
          <div className="headline">
            <h1 title={work.title}>{shortTitle(work)}</h1>
            <span className="kind">{review ? 'review' : 'work'} · {work.key}</span>
            {review && pr && project ? <button className="link small" onClick={() => mag.open(pr.url)}>{prRepoName(project, pr)}#{pr.number} ↗</button> : <TicketLinks task={work} />}
            {stage && !steps.length && <Stepper stage={stage} stages={review ? REVIEW_STAGES : WORK_STAGES} />}
            <AgentDot state={agentState(work, mine, tasks)} now={now} />
            <div className="grow" />
            {canGroom && !owner && <button className="small" onClick={() => mag.groom(work.id)}>Groom</button>}
            {review && <button className="small" title="The whole review in its own window" onClick={() => mag.openWindow({ kind: 'review', taskId: work.id })}>Open review ⧉</button>}
            {!review && <ReopenButton task={work} />}
            <HeadMenu card={{ kind: review ? 'review' : 'work', title: shortTitle(work), task: work, closed: work.status === 'canceled' || !!work.closedAt }} onSelect={onSelect} onGone={onDeleted} />
          </div>
          {steps.length > 0 && <StepChips steps={steps} />}
          {card?.move.who === 'you' && <WaitingBar move={card.move} work={work} state={state} onAnswer={focus} />}
          {review && work.description && (
            <div className={`brief ${fullBrief ? 'full' : ''}`}>
              <span className="brieftext">{work.description}</span>
              <button className="link" onClick={() => setFullBrief((f) => !f)}>{fullBrief ? 'Less' : 'Full brief'}</button>
            </div>
          )}
          {work.status === 'canceled' && <CanceledLine work={work} tasks={tasks} />}
          <WorkTabs work={work} state={state} tab={tab} onTab={setTab} />
        </header>
        <div className="screenbody">
          <div className="screenmain">
            {tab === 'conversation' ? (
              owner ? (
                <Chat session={owner} sessions={state.sessions} onOpenTask={onOpenKey} placeholder="Write to the owner: ask, change the plan, give feedback…" cards={cards} chip={project && owner.role === 'chat' ? <ModelChip project={project} activeModel={owner.activeModel} /> : undefined} />
              ) : (
                <div className="chatbox">
                  <div className="items">
                    <p className="muted small">This work has no owner conversation yet. Groom it: an agent reads the brief, plans the work with you here.</p>
                    {cards}
                  </div>
                </div>
              )
            ) : (
              <div className="tabbody">
                {tab === 'plan' && <PlanTab work={work} state={state} />}
                {tab === 'diagrams' && <DiagramsTab work={work} state={state} onOpen={drawer.show} />}
                {tab === 'doc' && <DocTab work={work} state={state} onOpenKey={onOpenKey} />}
                {tab === 'agents' && <AgentsTab work={work} state={state} onOpenKey={onOpenKey} />}
                {tab === 'review' && <ReviewTab work={work} state={state} onOpenKey={onOpenKey} onDeleted={onDeleted} />}
              </div>
            )}
          </div>
          {drawer.open && <DiagramDrawer open={drawer.open} state={state} onClose={drawer.close} />}
        </div>
      </section>
    </CanvasOpener.Provider>
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

/**
 * A discussion's screen: the same layout without steps and tabs. Its header: the title (click to rename), Turn into a
 * work and the ⋯ menu (rename, branch, close, delete); a canvas opens in the drawer.
 */
export function TopicConversation({ topic, state, onOpenKey, onSelect, onDeleted }: {
  topic: AgentSession
  state: AppState
  onOpenKey: (key: string) => void
  onSelect: (s: Selection) => void
  onDeleted: () => void
}) {
  const project = state.projects.find((p) => p.id === topic.projectId)
  const parent = topic.branchOf ? state.sessions.find((s) => s.id === topic.branchOf) : undefined
  const running = topic.status === 'running'
  const drawer = useDrawer()
  const chip = project && <ModelChip project={project} activeModel={topic.activeModel} />
  const turn = () => void mag.turnIntoWork(topic.id).catch((e: Error) => alert(e.message))
  return (
    <CanvasOpener.Provider value={drawer.show}>
      <section className="convo">
        <header className="convohead">
          <div className="headline">
            <TopicTitle topic={topic} />
            <span className="kind">discussion</span>
            <div className="grow" />
            <button className="small" disabled={running} title={running ? 'The agent is still working' : 'Its agent creates a work from what was discussed'} onClick={turn}>Turn into a work</button>
            <HeadMenu card={{ kind: 'topic', title: shortTitle(topic), session: topic, closed: !!topic.closedAt }} onSelect={onSelect} onGone={onDeleted} />
          </div>
          {topic.branchOf && (
            <div className="muted small">
              Branched from {parent ? <button type="button" className="link" onClick={() => onSelect({ kind: 'topic', id: parent.id })}>{parent.title ?? 'Topic'}</button> : 'a deleted topic'}
            </div>
          )}
        </header>
        <div className="screenbody">
          <div className="screenmain">
            {topic.items.length ? (
              <Chat session={topic} sessions={state.sessions} onOpenTask={onOpenKey} placeholder="Reply…" chip={chip} />
            ) : (
              <div className="chatbox">
                <div className="items">
                  <p className="muted small">
                    Talk about the project: a problem, ideas, design, priorities. The agent reads the code, draws mockups, and
                    plans a work with you; it never edits code itself.
                  </p>
                </div>
                <Composer busy={false} placeholder="Reply…" commands={chatCommands(topic, state.sessions)} onSend={(t: string, a: Attachment[]) => mag.send(topic.id, t, a)} chip={chip} />
              </div>
            )}
          </div>
          {drawer.open && <DiagramDrawer open={drawer.open} state={state} onClose={drawer.close} />}
        </div>
      </section>
    </CanvasOpener.Provider>
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
