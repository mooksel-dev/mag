import { Fragment, useContext, useEffect, useState } from 'react'
import {
  agentState,
  currentStep,
  isLegacy,
  isReview,
  openPrs,
  prHeads,
  reportLine,
  repoWorkName,
  shortTitle,
  stepsLine,
  subtasksOf,
  taskPrs,
  workCard,
  workStage,
  type AgentSession,
  type CardMove,
  type ReviewStage,
  type StepLine,
  type Task,
  type TaskWork,
  type WorkStage,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { agentName, useAgents } from './Agents'
import type { AgentLine, ArtifactChip, ArtifactTarget, TopicAgents, TopicArtifacts } from './artifacts'
import { MoveButton } from './Cards'
import { CanvasOpener, Chat, Markdown } from './Chat'
import { FactPanel } from './FactPanel'
import { prLabel } from './format'
import { PrPill } from './LinkPill'
import { ReportView } from './ReportView'
import { ReviewView } from './Reviews'
import { AgentDot, ReopenButton, SubtaskIcon, SubtaskList, TicketLinks, useNow } from './Tasks'
import { RowMenu, type MenuCard, type Selection } from './WorkList'

/**
 * The artifacts of a topic (topics-a-tree-of-agent.3): the list beside its conversation, and the bodies the drawer
 * shows for a work's card, its doc and a review. They replace the work screen's tabs.
 */

const mag = window.mag

/**
 * The topic's panel (topic-screen-one-new-compact.2, right-panel-only-what-is.1): Agents of the topic or subtopic, those
 * working, waiting on you or failed, the finished ones folded under them; then Documents and diagrams with plain titles, of
 * its unfinished works and what it drew outside any work. A tree's agent opens as its own page, a work's agent in the
 * drawer; a document or diagram in the drawer.
 */
export function TopicPanel({ agents, artifacts, onOpen, onSelect }: {
  agents: TopicAgents
  artifacts: TopicArtifacts
  onOpen: (target: ArtifactTarget) => void
  onSelect: (s: Selection) => void
}) {
  const docs = [...artifacts.works.flatMap((w) => w.lines), ...artifacts.loose]
  const line = (a: AgentLine) => <AgentRow key={a.session.id} agent={a} onOpen={() => (a.open.kind === 'select' ? onSelect({ kind: 'topic', id: a.open.id }) : onOpen(a.open))} />
  const [showDone, setShowDone] = useState(false)
  const total = agents.active.length + agents.finished.length
  return (
    <aside className="artifacts" aria-label="Agents, documents and diagrams">
      {total > 0 && (
        <section className="artsection" aria-label="Agents">
          <div className="artkind">Agents · {total}</div>
          {agents.active.map(line)}
          {!agents.active.length && <p className="muted small">None running now.</p>}
          {agents.finished.length > 0 && (
            <>
              <button className="wlfold" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Finished · {agents.finished.length}</button>
              {showDone && agents.finished.map(line)}
            </>
          )}
        </section>
      )}
      {docs.length > 0 && (
        <section className="artsection" aria-label="Documents and diagrams">
          <div className="artkind">Documents and diagrams</div>
          {docs.map((c) => <ArtifactRow key={c.key} chip={c} onOpen={() => onOpen(c.open)} />)}
        </section>
      )}
    </aside>
  )
}

/** A line of Documents and diagrams; one that can be deleted has ⋯ → Delete…, which asks first. */
function ArtifactRow({ chip: c, onOpen }: { chip: ArtifactChip; onOpen: () => void }) {
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])
  const ids = c.deletes
  const remove = () => {
    setMenu(false)
    if (!ids || !confirm(`Delete "${c.label}"${ids.length > 1 ? ` with its ${ids.length} diagrams` : ''}? It goes for good; links to it show as plain text.`)) return
    Promise.all(ids.map((id) => mag.deleteCanvas(id))).catch((e: Error) => alert(e.message))
  }
  return (
    <div className="artrow">
      <button className={`artline2${c.tone ? ` ${c.tone}` : ''}`} title={c.title} onClick={onOpen}>
        <span className="title">{c.label}</span>
      </button>
      {ids && (
        <span className="menu">
          <button className="iconbtn" aria-label={`More for ${c.label}`} aria-haspopup="menu" aria-expanded={menu} title="Delete…" onClick={() => setMenu(!menu)}>⋯</button>
          {menu && (
            <>
              <div className="menuscrim" onClick={() => setMenu(false)} />
              <div className="menulist wlmenu headmenu small" role="menu" aria-label={`${c.label}: actions`}>
                <button role="menuitem" className="danger" onClick={remove}>Delete…</button>
              </div>
            </>
          )}
        </span>
      )}
    </div>
  )
}

const AGENT_STATE_LABELS: Record<AgentLine['state'], string> = { working: 'working', waiting: 'waits on you', failed: 'failed', done: 'done' }

/** An agent's line: its role, what it works on, its state and its PR; a click opens its chat. */
function AgentRow({ agent: a, onOpen }: { agent: AgentLine; onOpen: () => void }) {
  return (
    <div className="agentrow">
      <button className="agentline" title={`${a.role} · ${a.on} · ${AGENT_STATE_LABELS[a.state]}`} onClick={onOpen}>
        <span className={`sessdot ${a.state === 'working' ? 'green' : a.state === 'waiting' ? 'amber' : 'grey'}`} aria-hidden />
        <span className="sessrole">{a.role}</span>
        <span className="agenton">{a.on}</span>
        <span className={`agentstate ${a.state}`}>{AGENT_STATE_LABELS[a.state]}</span>
      </button>
      {a.prUrl && <button className="link" title={a.prUrl} onClick={() => mag.open(a.prUrl!)}>{prLabel(a.prUrl)}</button>}
    </div>
  )
}

/** What the drawer's head says for a task's artifact, and whether its window opens with ⧉. */
export function taskArtifactHead(target: Extract<ArtifactTarget, { taskId: string }>, task: Task): { title: string; window: (() => void) | null } {
  if (target.kind === 'doc') return { title: `Doc · ${task.key}`, window: () => mag.openWindow({ kind: 'doc', taskId: task.id }) }
  if (target.kind === 'review') return { title: task.parentId ? `Review · ${task.key}` : `Review · ${shortTitle(task)}`, window: () => mag.openWindow({ kind: 'review', taskId: task.id }) }
  return { title: `${task.key} · ${shortTitle(task)}`, window: null }
}

/** The body of a task's artifact in the drawer: a work's card, its doc, a PR's review or a step's agent review. */
export function TaskArtifact({ target, task, state, onOpenKey, onSelect, onDeleted }: {
  target: Extract<ArtifactTarget, { taskId: string }>
  task: Task
  state: AppState
  onOpenKey: (key: string) => void
  onSelect: (s: Selection) => void
  onDeleted: () => void
}) {
  if (target.kind === 'doc') return <DocArtifact work={task} state={state} onOpenKey={onOpenKey} />
  if (target.kind === 'review') return task.parentId ? <StepReview step={task} state={state} /> : <PrReview work={task} state={state} onOpenKey={onOpenKey} onDeleted={onDeleted} />
  return <WorkArtifact work={task} state={state} onOpenKey={onOpenKey} onSelect={onSelect} onDeleted={onDeleted} />
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
function StepChips({ steps }: { steps: StepLine[] }) {
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

/** "Waiting on you · <key>: <the row's move>" with the button for it (work-list-the-left-column.2). */
export function WaitingBar({ move, work, state, onAnswer, keyed = false }: { move: CardMove; work: Task; state: AppState; onAnswer: () => void; keyed?: boolean }) {
  return (
    <div className="waitingbar" role="status">
      <b>Waiting on you{keyed ? ` · ${work.key}` : ''}</b>
      <span>{move.text}</span>
      {move.action && <MoveButton action={move.action} work={work} state={state} onAnswer={onAnswer} />}
    </div>
  )
}

/** A header's ⋯: the same menu as the row's in the sidebar. */
export function HeadMenu({ card, onSelect, onGone }: { card: MenuCard; onSelect: (s: Selection) => void; onGone: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="menu">
      <button className="iconbtn" aria-label={`More for ${card.title}`} aria-haspopup="menu" aria-expanded={open} title="Rename, close, delete…" onClick={() => setOpen(!open)}>⋯</button>
      {open && <RowMenu card={card} className="wlmenu headmenu" onClose={() => setOpen(false)} onSelect={onSelect} onGone={onGone} />}
    </span>
  )
}

/** The ⋯ menu's card of a work or a review. */
export const workMenuCard = (work: Task): MenuCard => ({ kind: isReview(work) ? 'review' : 'work', title: shortTitle(work), task: work, closed: work.status === 'canceled' || !!work.closedAt })

function CanceledLine({ work, tasks }: { work: Task; tasks: Task[] }) {
  const prs = openPrs(work, tasks)
  return (
    <div className="muted small">
      Canceled{work.cancelReason ? `: ${work.cancelReason}` : '.'}
      {prs.length > 0 && <> Its PRs are still open; close them on GitHub: {prs.map((r) => <button key={r.prUrl} className="link" onClick={() => mag.open(r.prUrl!)}>{prLabel(r.prUrl!)}</button>)}</>}
    </div>
  )
}

/** The agents that worked on a work (its own sessions). */
export const workSessions = (work: Task, state: AppState) => state.sessions.filter((s) => s.taskId === work.id)

/**
 * A work's card (it was the Plan & steps and Agents tabs): its stage or steps as chips, its tickets, what its agent
 * does, Continue and its ⋯ menu; the brief and the steps with their PRs; then per step its worktrees, branches and
 * agents, whose logs open in place.
 */
function WorkArtifact({ work, state, onOpenKey, onSelect, onDeleted }: { work: Task; state: AppState; onOpenKey: (key: string) => void; onSelect: (s: Selection) => void; onDeleted: () => void }) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const steps = subtasksOf(work.id, tasks)
  const chips = isLegacy(work) ? [] : stepsLine(work, tasks)
  const card = workCard(work, tasks, state.sessions, now)
  const stage = card ? card.stage : workStage(work, tasks)
  return (
    <div className="artbody">
      <div className="artline">
        <span className="kind">work · {work.key}</span>
        <TicketLinks task={work} />
        {stage && !chips.length && <Stepper stage={stage} stages={WORK_STAGES} />}
        <AgentDot state={agentState(work, workSessions(work, state), tasks)} now={now} />
        <div className="grow" />
        <ReopenButton task={work} />
        <HeadMenu card={workMenuCard(work)} onSelect={onSelect} onGone={onDeleted} />
      </div>
      {chips.length > 0 && <StepChips steps={chips} />}
      {work.status === 'canceled' && <CanceledLine work={work} tasks={tasks} />}
      {work.description && <div className="brieffull">{work.description}</div>}
      {steps.length ? <SubtaskList parent={work} subs={steps} tasks={tasks} steps={!isLegacy(work)} project={project} /> : <p className="muted">No steps yet: the owner plans them.</p>}
      <p className="muted small">To change the plan, tell the owner in the conversation.</p>
      <WorkAgents work={work} state={state} onOpenKey={onOpenKey} />
    </div>
  )
}

/** A work's doc; its canvases open in the drawer, ⧉ in the drawer's head pops it out. */
function DocArtifact({ work, state, onOpenKey }: { work: Task; state: AppState; onOpenKey: (key: string) => void }) {
  const doc = state.docs[work.id]
  const canvases = state.canvases.filter((c) => c.projectId === work.projectId)
  return doc ? <Markdown className="md docmd" text={doc} canvases={canvases} onOpenTask={onOpenKey} /> : <p className="muted">No document yet: the owner writes it while planning.</p>
}

/** A teammate's PR review: the report, its fact and diagrams, as its own window shows them. */
function PrReview({ work, state, onOpenKey, onDeleted }: { work: Task; state: AppState; onOpenKey: (key: string) => void; onDeleted: () => void }) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const stage = workCard(work, tasks, state.sessions, now)?.stage
  if (!project) return null
  return (
    <div className="artbody">
      {stage && <div className="artline"><Stepper stage={stage} stages={REVIEW_STAGES} /></div>}
      <ReviewView key={work.id} work={work} project={project} state={state} onOpenKey={onOpenKey} onDeleted={onDeleted} now={now} />
    </div>
  )
}

/** A step has a fact to show: an open PR, or the fact mag recorded at its review. */
const hasFact = (step: Task) => !!step.fact || Object.keys(prHeads(step.work)).length > 0

/** The agent review of a step's PRs: plan ↔ fact, the report (or its verdict and findings); the whole of it in its window. */
function StepReview({ step, state }: { step: Task; state: AppState }) {
  const open = useContext(CanvasOpener)
  const r = step.review
  const diagramsKey = state.canvases.filter((c) => c.stepId === step.id).map((c) => `${c.id}@${c.version}`).join(',')
  return (
    <div className="artbody">
      <div className="artline"><SubtaskIcon status={step.status} /> {step.key} · {step.title}</div>
      {hasFact(step) && <FactPanel step={step} diagramsKey={diagramsKey} />}
      {r?.report ? (
        <>
          <div className="diffhead">Agent review: {reportLine(r.report, 'step')}</div>
          <ReportView report={r.report} fact={step.fact} kind="step" onView={(id) => open?.({ id, title: '', version: 0 })} />
        </>
      ) : r ? (
        <>
          <div className="diffhead">Agent review: {r.verdict} · round {r.round}</div>
          {r.findings.length > 0 ? <ul>{r.findings.map((f, i) => <li key={i}>{f.text}</li>)}</ul> : <p className="muted small">No findings.</p>}
        </>
      ) : <p className="muted">No agent review yet.</p>}
    </div>
  )
}

const sessionCost = (s: AgentSession) => s.items.reduce((sum, i) => sum + (i.kind === 'result' ? (i.costUsd ?? 0) : 0), 0)

/** A group of a work's sessions: grooming, one step's developer and reviewer, or a legacy work's agents. */
interface SessionGroup {
  label: string
  step?: Task
  sessions: AgentSession[]
}

/** Sessions by what they worked on: grooming first, then each step in order; legacy sessions last. */
function sessionGroups(steps: Task[], sessions: AgentSession[]): SessionGroup[] {
  const groups: SessionGroup[] = [
    { label: 'Grooming', sessions: sessions.filter((s) => s.role === 'groomer') },
    ...steps.map((step) => ({ label: step.key, step, sessions: sessions.filter((s) => s.stepId === step.id) })),
    { label: 'Agents', sessions: sessions.filter((s) => s.role !== 'groomer' && !steps.some((st) => st.id === s.stepId)) },
  ]
  return groups.filter((g) => g.sessions.length || g.step)
}

/**
 * Per step its worktrees, branches, PRs and agents; an agent opens as its log. The user never writes there: questions
 * go through the owner, who passes them on with message_agent.
 */
function WorkAgents({ work, state, onOpenKey }: { work: Task; state: AppState; onOpenKey: (key: string) => void }) {
  const [shownId, setShownId] = useState<string | null>(null)
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const steps = isLegacy(work) ? [] : subtasksOf(work.id, tasks)
  const sessions = workSessions(work, state)
  const shown = sessions.find((s) => s.id === shownId)
  if (shown) return <AgentLog session={shown} work={work} state={state} onBack={() => setShownId(null)} onOpenKey={onOpenKey} />
  const groups = sessionGroups(steps, sessions)
  const anyPr = taskPrs(work, steps).length > 0
  return (
    <>
      <div className="diffhead">Agents</div>
      <p className="muted small">Agents' chats are logs: write to the owner in the conversation, it passes things on. {anyPr && <button className="link small" onClick={() => mag.checkPrs()}>check PRs now</button>}</p>
      {work.work && (
        <div className="workgroup">
          <h2>Work folder <button className="link small" onClick={() => mag.open(work.work!.dir)}>open</button></h2>
          <RepoList work={work.work} />
        </div>
      )}
      {groups.map((g) => (
        <div key={g.label} className="workgroup">
          <h2>
            {g.step ? <><SubtaskIcon status={g.step.status} /> {g.step.key} · {g.step.title}</> : g.label}
            {g.step?.work && <button className="link small" onClick={() => mag.open(g.step!.work!.dir)}>open step folder</button>}
          </h2>
          {g.step && (g.step.work ? <RepoList work={g.step.work} /> : <p className="muted small">Not started yet.</p>)}
          {g.sessions.length > 0 && <SessionList sessions={g.sessions} all={sessions} ownerId={work.ownerSessionId} onShow={setShownId} />}
        </div>
      ))}
      {!sessions.length && <p className="muted">No agent has worked on this yet.</p>}
    </>
  )
}

/** An agent's chat as a log: Stop while it runs, Restart when it is the work's latest of its role and can go on. */
function AgentLog({ session, work, state, onBack, onOpenKey }: { session: AgentSession; work: Task; state: AppState; onBack: () => void; onOpenKey: (key: string) => void }) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const mine = state.sessions.filter((s) => s.taskId === work.id)
  const running = mine.some((s) => s.status === 'running')
  const latest = mine.filter((s) => s.role === session.role).at(-1) === session
  const step = isLegacy(work) ? null : currentStep(work.id, tasks)
  const restart =
    !latest || running ? null
    : session.role === 'groomer' && !work.work && (work.status === 'planning' || work.status === 'ready') ? () => mag.groom(work.id)
    : session.role === 'developer' && work.status === 'in_progress' && (isLegacy(work) || step?.id === session.stepId) ? () => mag.develop(work.id)
    : session.role === 'reviewer' && work.status === 'in_progress' && step?.id === session.stepId ? () => mag.review(work.id)
    : null
  return (
    <div className="agentlog">
      <div className="chathead">
        <button className="link small" onClick={onBack}>‹ Agents</button>
        <span>{session.role}{session.id === work.ownerSessionId ? ' · owner' : ''}</span>
        <span className="chatmodel muted small">{session.activeModel ?? 'default'} · {session.status}</span>
        <div className="grow" />
        {session.status === 'running' && <button className="small" onClick={() => mag.stop(session.id)}>Stop</button>}
        {restart && <button className="small" title="Run this agent again where it stopped" onClick={() => void restart()}>Restart</button>}
      </div>
      <Chat session={session} sessions={state.sessions} canvases={state.canvases} onOpenTask={onOpenKey} readOnly />
    </div>
  )
}

/** Per repo: its branch, worktree and PR. */
function RepoList({ work }: { work: TaskWork }) {
  return (
    <div className="repolist">
      {work.repos.map((r) => (
        <div key={r.repo} className="reporow">
          <span className="reponame">{repoWorkName(work, r)}</span>
          <code className="grow">{r.branch}</code>
          {r.local ? (
            <button className="link" title={`Works right in the main checkout ${r.repo}`} onClick={() => mag.open(r.repo)}>local</button>
          ) : (
            <button className="link" onClick={() => mag.open(r.worktree)}>worktree</button>
          )}
          {r.prUrl ? <PrPill pr={r} /> : <span className="muted">no PR</span>}
          {r.checkError && <span className="pill amber" title={r.checkError}>check failed: {r.checkError.slice(0, 60)}</span>}
        </div>
      ))}
    </div>
  )
}

function SessionList({ sessions, all, ownerId, onShow }: { sessions: AgentSession[]; all: AgentSession[]; ownerId?: string | null; onShow: (sessionId: string) => void }) {
  const agents = useAgents()
  return (
    <div className="sessionlist">
      {sessions.map((s) => (
        <button key={s.id} className="sessionrow" onClick={() => onShow(s.id)} title="Show its log">
          <span className="no">#{all.indexOf(s) + 1}</span>
          <span>{s.role}{s.id === ownerId ? ' · owner' : ''}</span>
          <span className="muted grow">{agentName(agents, s.agent)} · {s.activeModel ?? 'default'}</span>
          <span className={`status ${s.status === 'running' ? 's-in_progress' : ''}`}>{s.status}</span>
          <span className="muted small">${sessionCost(s).toFixed(2)}</span>
        </button>
      ))}
    </div>
  )
}
