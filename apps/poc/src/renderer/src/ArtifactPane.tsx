import { useMemo, useState } from 'react'
import {
  currentStep,
  isLegacy,
  repoWorkName,
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
import { Chat, Markdown } from './Chat'
import { DiffTab, diagramsOf } from './DiffTab'
import { PrPill } from './LinkPill'
import { ReviewView } from './Reviews'
import { SubtaskIcon, SubtaskList, useNow } from './Tasks'

/**
 * The bodies of a work's tabs (redesign-start-screen-big-composer.3): Plan & steps, Diagrams, Doc, Agents, and a review's
 * page. They were the right column; the work's screen shows them under its header, one at a time.
 */

const mag = window.mag

/**
 * A work's diagrams and canvases for its tabs: its own diagrams, then those of other tasks its doc links (T-55.3); its
 * HTML canvases and those its owner topic drew before the work existed.
 */
export function useWorkCanvases(work: Task, state: AppState) {
  const doc = state.docs[work.id]
  const projectCanvases = useMemo(() => state.canvases.filter((c) => c.projectId === work.projectId), [state.canvases, work.projectId])
  const diagrams = useMemo(() => diagramsOf(taskDiagrams(work, doc, projectCanvases)), [projectCanvases, work, doc])
  const canvases = useMemo(() => workCanvases(work, projectCanvases), [projectCanvases, work])
  return { projectCanvases, diagrams, canvases }
}

/** Plan & steps: the brief, then the steps in order (a legacy work: its checklist). */
export function PlanTab({ work, state }: { work: Task; state: AppState }) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const steps = subtasksOf(work.id, tasks)
  return (
    <div className="tabin">
      {work.description && <div className="brieffull">{work.description}</div>}
      {steps.length ? <SubtaskList parent={work} subs={steps} tasks={tasks} steps={!isLegacy(work)} project={project} /> : <p className="muted">No steps yet: the owner plans them.</p>}
      <p className="muted small">To change the plan, tell the owner in the conversation.</p>
    </div>
  )
}

/**
 * Diagrams: by their place (options, plan by step with plan ↔ fact, the rest), then the other canvases of the work and
 * its owner topic. A click opens one in the drawer.
 */
export function DiagramsTab({ work, state, onOpen }: { work: Task; state: AppState; onOpen: (canvasId: string) => void }) {
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const project = state.projects.find((p) => p.id === work.projectId)
  const { diagrams, canvases } = useWorkCanvases(work, state)
  return (
    <div className="tabin">
      <DiffTab task={work} tasks={tasks} project={project} diagrams={diagrams} onOpen={onOpen} />
      {canvases.length > 0 && (
        <section>
          <div className="diffhead">Canvases · {canvases.length}</div>
          <div className="difflistrows">
            {canvases.map((c) => (
              <button key={c.id} className="diffrow" onClick={() => onOpen(c.id)}>
                <span className="type">{c.kind === 'diagram' ? 'Diagram' : 'Mockup'}</span>
                <span className="title">{c.title}</span>
                <span className="muted small">v{c.version}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** Doc: the work's document; its canvases open in the drawer, ⧉ pops the doc out. */
export function DocTab({ work, state, onOpenKey }: { work: Task; state: AppState; onOpenKey: (key: string) => void }) {
  const doc = state.docs[work.id]
  const { projectCanvases } = useWorkCanvases(work, state)
  return (
    <div className="tabin">
      {doc ? (
        <>
          <div className="tabtools"><button className="link" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'doc', taskId: work.id })}>⧉ Open in window</button></div>
          <Markdown className="md docmd" text={doc} canvases={projectCanvases} onOpenTask={onOpenKey} />
        </>
      ) : <p className="muted">No document yet: the owner writes it while planning.</p>}
    </div>
  )
}

/** A review's page: the report, its fact and diagrams. */
export function ReviewTab({ work, state, onOpenKey, onDeleted }: { work: Task; state: AppState; onOpenKey: (key: string) => void; onDeleted: () => void }) {
  const now = useNow(15_000)
  const project = state.projects.find((p) => p.id === work.projectId)
  if (!project) return null
  return <div className="tabin"><ReviewView key={work.id} work={work} project={project} state={state} onOpenKey={onOpenKey} onDeleted={onDeleted} now={now} /></div>
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

/** The agents that worked on a work (its own sessions). */
export const workSessions = (work: Task, state: AppState) => state.sessions.filter((s) => s.taskId === work.id)

/**
 * Per step its worktrees, branches, PRs and agents; an agent opens as its log. The user never writes there: questions
 * go through the owner, who passes them on with message_agent.
 */
export function AgentsTab({ work, state, onOpenKey }: { work: Task; state: AppState; onOpenKey: (key: string) => void }) {
  const [shownId, setShownId] = useState<string | null>(null)
  const tasks = state.tasks.filter((t) => t.projectId === work.projectId)
  const steps = isLegacy(work) ? [] : subtasksOf(work.id, tasks)
  const sessions = workSessions(work, state)
  const shown = sessions.find((s) => s.id === shownId)
  if (shown) return <AgentLog session={shown} work={work} state={state} onBack={() => setShownId(null)} onOpenKey={onOpenKey} />
  const groups = sessionGroups(steps, sessions)
  const anyPr = taskPrs(work, steps).length > 0
  return (
    <div className="tabin">
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
    </div>
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
