import { useMemo, useState } from 'react'
import {
  currentStep,
  isLegacy,
  isReview,
  repoWorkName,
  subtaskProgress,
  subtasksOf,
  taskDiagrams,
  taskPrs,
  workCanvases,
  type AgentSession,
  type Task,
  type TaskWork,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { agentName, useAgents } from './Agents'
import { CanvasCard, Chat, Markdown } from './Chat'
import { DiffTab, diagramsOf } from './DiffTab'
import { PrPill } from './LinkPill'
import { ReviewView } from './Reviews'
import { SubtaskIcon, SubtaskList, useNow } from './Tasks'

const mag = window.mag

type PaneTab = 'diff' | 'doc' | 'steps' | 'agents'

/**
 * The right column (ux-odna-rozmova-na-robotu.2): what the work has made. A work: Diff, Doc, Steps and Agents (their
 * chats as logs: Stop and Restart, no composer). A review: its page. A topic: its canvases.
 */
export function ArtifactPane({ work, topic, state, onOpenKey, onDeleted }: {
  work: Task | null
  topic?: AgentSession | null
  state: AppState
  onOpenKey: (key: string) => void
  /** The open work is gone (a review deleted). */
  onDeleted: () => void
}) {
  if (work && isReview(work)) {
    const project = state.projects.find((p) => p.id === work.projectId)
    return (
      <aside className="pane">
        <div className="panebody">{project && <ReviewPage work={work} project={project} state={state} onOpenKey={onOpenKey} onDeleted={onDeleted} />}</div>
      </aside>
    )
  }
  if (work) return <WorkPane key={work.id} work={work} state={state} onOpenKey={onOpenKey} />
  if (topic) return <TopicPane topic={topic} state={state} />
  return <aside className="pane"><p className="muted pad">Pick a work on the left.</p></aside>
}

function ReviewPage(props: Omit<React.ComponentProps<typeof ReviewView>, 'now'>) {
  const now = useNow(15_000)
  return <ReviewView key={props.work.id} {...props} now={now} />
}

function WorkPane({ work, state, onOpenKey }: { work: Task; state: AppState; onOpenKey: (key: string) => void }) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const steps = subtasksOf(work.id, tasks)
  const legacy = isLegacy(work)
  const doc = state.docs[work.id]
  const projectCanvases = useMemo(() => state.canvases.filter((c) => c.projectId === work.projectId), [state.canvases, work.projectId])
  // Its own diagrams, then those of other tasks the doc links (T-55.3).
  const diagrams = useMemo(() => diagramsOf(taskDiagrams(work, doc, projectCanvases)), [projectCanvases, work, doc])
  // Its own canvases and those its owner topic drew before the work existed.
  const canvases = useMemo(() => workCanvases(work, projectCanvases), [projectCanvases, work])
  const progress = subtaskProgress(work.id, tasks)
  const sessions = state.sessions.filter((s) => s.taskId === work.id)
  // A work being planned shows its doc first; one in progress what it changed.
  const [tab, setTab] = useState<PaneTab>(() => (diagrams.length && work.status !== 'planning' ? 'diff' : 'doc'))
  const tabs: [PaneTab, string][] = [
    ['diff', `Diff · ${diagrams.length}`],
    ['doc', 'Doc'],
    ['steps', steps.length ? `Steps · ${progress.done}/${progress.total}` : 'Steps'],
    ['agents', `Agents · ${sessions.length}`],
  ]
  return (
    <aside className="pane">
      <div className="tasktabs panetabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
        {tab === 'doc' && doc && (
          <button className="link popbtn" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'doc', taskId: work.id })}>⧉</button>
        )}
      </div>
      <div className="panebody">
        {tab === 'diff' && <DiffTab task={work} tasks={tasks} project={project} diagrams={diagrams} />}
        {tab === 'doc' && (
          <>
            {doc ? <Markdown className="md docmd" text={doc} canvases={projectCanvases} onOpenTask={onOpenKey} /> : <p className="muted">No document yet: the owner writes it while planning.</p>}
            {canvases.length > 0 && (
              <>
                <h2>Canvases · {canvases.length}</h2>
                <div className="canvaslist">{canvases.map((c) => <CanvasCard key={c.id + c.version} canvas={c} />)}</div>
              </>
            )}
          </>
        )}
        {tab === 'steps' && (steps.length ? <SubtaskList parent={work} subs={steps} tasks={tasks} steps={!legacy} project={project} /> : <p className="muted">No steps yet: the owner plans them.</p>)}
        {tab === 'agents' && <AgentsTab work={work} steps={legacy ? [] : steps} sessions={sessions} state={state} onOpenKey={onOpenKey} />}
      </div>
    </aside>
  )
}

/** A topic's canvases: what its agent drew. */
function TopicPane({ topic, state }: { topic: AgentSession; state: AppState }) {
  const canvases = state.canvases.filter((c) => c.sessionId === topic.id && c.taskId === null).sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <aside className="pane">
      <div className="panebody">
        {canvases.length ? (
          <div className="canvaslist">{canvases.map((c) => <CanvasCard key={c.id + c.version} canvas={c} />)}</div>
        ) : (
          <p className="muted">Mockups and diagrams the agent draws show here. Once you agree on the problem and the plan, the topic owns a work and it moves up the list.</p>
        )}
      </div>
    </aside>
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
function AgentsTab({ work, steps, sessions, state, onOpenKey }: { work: Task; steps: Task[]; sessions: AgentSession[]; state: AppState; onOpenKey: (key: string) => void }) {
  const [shownId, setShownId] = useState<string | null>(null)
  const shown = sessions.find((s) => s.id === shownId)
  if (shown) return <AgentLog session={shown} work={work} state={state} onBack={() => setShownId(null)} onOpenKey={onOpenKey} />
  const groups = sessionGroups(steps, sessions)
  const anyPr = taskPrs(work, steps).length > 0
  return (
    <>
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
      <Chat session={session} sessions={state.sessions} onOpenTask={onOpenKey} readOnly />
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
