import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_TEMPLATES,
  PLAN_STATUSES,
  SETTABLE_ROLES,
  canMoveInPlan,
  canMoveSubtask,
  planBlockers,
  planQueue,
  resolveChoice,
  subtasksOf,
  type AgentSession,
  type Project,
  type Task,
  type TaskType,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { ModelPicker, agentName, useAgents } from './Agents'
import { Architecture } from './Architecture'
import { CanvasCard, Chat, Markdown, ProjectChat } from './Chat'
import { useTheme, type ThemeMode } from './useTheme'

const loadFlag = (k: string, d: boolean) => {
  try {
    const v = localStorage.getItem(k)
    return v === null ? d : v === '1'
  } catch {
    return d
  }
}

const mag = window.mag
const TYPES: TaskType[] = ['dev', 'design', 'spike', 'research']
type Tab = 'needs' | 'backlog' | 'plan' | 'architecture' | 'settings'

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('needs')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(() => loadFlag('mag.chatOpen', true))
  const [theme, setTheme] = useTheme()
  const toggleChat = (v: boolean) => {
    setChatOpen(v)
    try { localStorage.setItem('mag.chatOpen', v ? '1' : '0') } catch { /* ignore */ }
  }

  useEffect(() => {
    mag.getState().then(setState)
    return mag.onState(setState)
  }, [])

  if (!state) return null
  const project = state.projects.find((p) => p.id === projectId) ?? state.projects[0] ?? null
  const tasks = project ? state.tasks.filter((t) => t.projectId === project.id) : []
  const task = tasks.find((t) => t.id === taskId) ?? null
  const needsCount = tasks.filter(needsYou).length
  const openKey = (key: string) => setTaskId(tasks.find((t) => t.key === key)?.id ?? null)
  const chatBusy = state.sessions.some((s) => s.projectId === project?.id && s.role === 'chat' && s.status === 'running')

  return (
    <div className="app">
      <nav className="rail" aria-label="Projects">
        {state.projects.map((p) => (
          <button key={p.id} className={`railbtn ${p.id === project?.id ? 'on' : ''}`} title={p.name} aria-label={p.name} aria-current={p.id === project?.id} onClick={() => { setProjectId(p.id); setTaskId(null) }}>
            {initials(p.name)}
          </button>
        ))}
        <NewProject onCreate={(p) => { setProjectId(p.id); setTaskId(null); setTab('settings') }} />
        <div className="grow" />
        {!state.claudeBin && <span className="railwarn" role="img" aria-label="Warning" title="Claude Code CLI not found. Set MAG_CLAUDE_BIN or install claude.">⚠</span>}
      </nav>

      {project ? (
        <div className="workspace">
        <main className="main">
          <header className="tabs">
            <span className="brand">mag <span>PoC</span></span>
            <button className={tab === 'needs' && !task ? 'on' : ''} onClick={() => { setTab('needs'); setTaskId(null) }}>
              Needs you {needsCount > 0 && <span className="badge">{needsCount}</span>}
            </button>
            <button className={tab === 'backlog' && !task ? 'on' : ''} onClick={() => { setTab('backlog'); setTaskId(null) }}>Backlog</button>
            <button className={tab === 'plan' && !task ? 'on' : ''} onClick={() => { setTab('plan'); setTaskId(null) }}>Plan</button>
            <button className={tab === 'architecture' && !task ? 'on' : ''} onClick={() => { setTab('architecture'); setTaskId(null) }}>Architecture</button>
            <button className={tab === 'settings' && !task ? 'on' : ''} onClick={() => { setTab('settings'); setTaskId(null) }}>Settings</button>
            <div className="grow" />
            <ThemeSwitch mode={theme} onChange={setTheme} />
            {!chatOpen && !task && <button onClick={() => toggleChat(true)}>Chat {chatBusy && <span className="dot inline" />}</button>}
          </header>
          {task ? (
            <TaskView key={task.id} task={task} tasks={tasks} state={state} onNav={(t) => { setTab(t); setTaskId(null) }} onOpen={setTaskId} onOpenKey={openKey} />
          ) : tab === 'needs' ? (
            <NeedsYou tasks={tasks} state={state} onOpen={setTaskId} />
          ) : tab === 'backlog' ? (
            <BacklogView project={project} tasks={tasks} onOpen={setTaskId} />
          ) : tab === 'plan' ? (
            <PlanView tasks={tasks} onOpen={setTaskId} />
          ) : tab === 'architecture' ? (
            <Architecture key={project.id} project={project} />
          ) : (
            <Settings project={project} />
          )}
        </main>
        {chatOpen && !task && <ProjectChat key={project.id} projectId={project.id} state={state} onOpenTask={openKey} onClose={() => toggleChat(false)} />}
        </div>
      ) : (
        <main className="main empty">Create a project to start.</main>
      )}
    </div>
  )
}

function needsYou(t: Task) {
  return !!t.needsInput || (t.status === 'groomed' && !t.parentId) || (t.status === 'in_review' && !!t.work?.prUrl)
}

function needsLabel(t: Task): [string, string, string] {
  if (t.needsInput) return ['amber', 'Input needed', t.needsInput]
  if (t.status === 'in_review') return ['green', 'Ready to merge', 'PR is open. Merge it yourself; comments go back to the agent.']
  return ['violet', 'Review grooming', 'Groomed, ready to add to the plan']
}

/** "My project" -> "MP", "mag" -> "MA". */
function initials(name: string) {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase()
}

function NewProject({ onCreate }: { onCreate: (p: Project) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const close = () => { setOpen(false); setName('') }
  return (
    <div className="menu">
      <button className="railbtn add" title="New project" aria-label="New project" aria-expanded={open} onClick={() => setOpen((o) => !o)}>+</button>
      {open && (
        <>
          <div className="menuscrim" onClick={close} />
          <form className="popover" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; onCreate(await mag.createProject(name.trim())); close() }}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && close()} placeholder="New project name" aria-label="New project name" />
            <button type="submit" className="primary">Create</button>
          </form>
        </>
      )}
    </div>
  )
}

function NeedsYou({ tasks, state, onOpen }: { tasks: Task[]; state: AppState; onOpen: (id: string) => void }) {
  const items = tasks.filter(needsYou)
  const running = state.sessions.filter((s) => s.status === 'running' && tasks.some((t) => t.id === s.taskId))
  const devTasks = running.filter((s) => s.role === 'developer').map((s) => tasks.find((t) => t.id === s.taskId)?.key)
  return (
    <section className="page">
      <h1>Needs you</h1>
      <p className="muted">
        {items.length ? `${items.length} item(s) waiting on you` : 'Nothing is waiting on you.'} · developer: {devTasks.length ? `busy (${devTasks.join(', ')})` : 'idle'} · {running.length} agent(s) working{' '}
        <button className="link" onClick={() => mag.checkPrs()}>check PRs now</button>
      </p>
      <div className="list">
        {items.map((t) => {
          const [color, label, text] = needsLabel(t)
          return (
            <button key={t.id} className="item" onClick={() => onOpen(t.id)}>
              <span className={`pill ${color}`}>{label}</span>
              <span className="key">{t.key}</span>
              <span className="title">{t.title}</span>
              <span className="muted grow">{text}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

const THEMES: [ThemeMode, string, string][] = [['light', '☀︎', 'Light'], ['dark', '☾', 'Dark'], ['system', 'Auto', 'Follow the system']]

function ThemeSwitch({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  return (
    <div className="seg" role="group" aria-label="Theme">
      {THEMES.map(([m, label, title]) => (
        <button key={m} className={m === mode ? 'on' : ''} aria-pressed={m === mode} title={title} onClick={() => onChange(m)}>{label}</button>
      ))}
    </div>
  )
}

function PlanView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  return (
    <section className="page">
      <h1>Plan</h1>
      <p className="muted">Runs top to bottom, one task at a time: subtasks one by one, the next task after the previous one is merged.</p>
      <TaskTree roots={planQueue(tasks)} all={tasks} onOpen={onOpen} plan empty="Nothing planned yet. Groom tasks from the backlog and add them here." />
    </section>
  )
}

function BacklogView({ project, tasks, onOpen }: { project: Project; tasks: Task[]; onOpen: (id: string) => void }) {
  const roots = tasks.filter((t) => !t.parentId && !PLAN_STATUSES.includes(t.status)).sort((a, b) => a.createdAt - b.createdAt)
  return (
    <section className="page">
      <h1>Backlog</h1>
      <NewTask projectId={project.id} />
      <TaskTree roots={roots} all={tasks} onOpen={onOpen} empty="Backlog is empty." />
    </section>
  )
}

/** Top-level tasks with their subtasks nested; `plan` adds ▲▼. */
function TaskTree({ roots, all, onOpen, empty, plan }: { roots: Task[]; all: Task[]; onOpen: (id: string) => void; empty: string; plan?: boolean }) {
  if (!roots.length) return <p className="muted">{empty}</p>
  const row = (t: Task, depth: number): React.ReactNode => (
    <div key={t.id}>
      <div className="rowwrap">
        <button className="row" style={{ paddingLeft: 12 + depth * 20 }} onClick={() => onOpen(t.id)}>
          <span className="key">{t.key}</span>
          <span className="title grow">{t.title}</span>
          {t.needsInput && <span className="dot" title={t.needsInput} />}
          <span className="type">{t.type}</span>
          <span className={`status s-${t.status}`}>{t.status.replace('_', ' ')}</span>
        </button>
        {plan && (
          <span className="moves">
            {depth === 0 && (['up', 'down'] as const).map((dir) => (
              <button key={dir} className="icon" disabled={!canMoveInPlan(t, all, dir)} aria-label={`Move ${t.key} ${dir}`} onClick={() => mag.move(t.id, dir)}>
                {dir === 'up' ? '▲' : '▼'}
              </button>
            ))}
          </span>
        )}
      </div>
      {subtasksOf(t.id, all).map((c) => row(c, depth + 1))}
    </div>
  )
  return <div className="tree">{roots.map((t) => row(t, 0))}</div>
}

function NewTask({ projectId }: { projectId: string }) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<TaskType>('dev')
  const [description, setDescription] = useState('')
  return (
    <form className="newtask" onSubmit={async (e) => { e.preventDefault(); if (!title.trim()) return; await mag.createTask({ projectId, title: title.trim(), type, description }); setTitle(''); setDescription('') }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title" aria-label="Task title" />
      <select value={type} onChange={(e) => setType(e.target.value as TaskType)} aria-label="Task type">
        {TYPES.map((t) => <option key={t}>{t}</option>)}
      </select>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What and why, as briefly as you like" aria-label="Task description" rows={2} />
      <button type="submit">Add to backlog</button>
    </form>
  )
}

type TaskTab = 'document' | 'subtasks' | 'canvases' | 'work'
type ChatMode = 'task' | 'project'

const ago = (ts: number) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  return m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 60 / 24)}d`
}
const prLabel = (url: string) => `PR #${url.match(/\/pull\/(\d+)/)?.[1] ?? '?'} ↗`
const sessionCost = (s: AgentSession) => s.items.reduce((sum, i) => sum + (i.kind === 'result' ? (i.costUsd ?? 0) : 0), 0)

function TaskView({ task, tasks, state, onNav, onOpen, onOpenKey }: { task: Task; tasks: Task[]; state: AppState; onNav: (tab: Tab) => void; onOpen: (id: string) => void; onOpenKey: (key: string) => void }) {
  const sessions = state.sessions.filter((s) => s.taskId === task.id)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const session = sessions.find((s) => s.id === sessionId) ?? sessions[sessions.length - 1] ?? null
  const doc = state.docs[task.id]
  // The doc may link any canvas of the project (e.g. one drawn in the project chat); the tab lists the task's own.
  const projectCanvases = useMemo(() => state.canvases.filter((c) => c.projectId === task.projectId), [state.canvases, task.projectId])
  const canvases = useMemo(
    () => projectCanvases.filter((c) => c.taskId === task.id).sort((a, b) => b.updatedAt - a.updatedAt),
    [projectCanvases, task.id],
  )
  const blockers = planBlockers(task)
  const parent = tasks.find((t) => t.id === task.parentId)
  const children = subtasksOf(task.id, tasks)
  const anyRunning = sessions.some((s) => s.status === 'running')
  const inPlan = PLAN_STATUSES.includes(task.status)
  const canGroom = !anyRunning && !task.parentId && !inPlan
  const canDevelop = !anyRunning && !children.length && (task.status === 'planned' || task.status === 'in_progress')
  const [tab, setTab] = useState<TaskTab>('document')
  const shownTab = tab === 'subtasks' && !children.length ? 'document' : tab
  const [fullBrief, setFullBrief] = useState(false)
  const [chatMode, setChatModeState] = useState<ChatMode>(() => (loadFlag('mag.taskChatProject', false) ? 'project' : 'task'))
  const setChatMode = (m: ChatMode) => {
    setChatModeState(m)
    try { localStorage.setItem('mag.taskChatProject', m === 'project' ? '1' : '0') } catch { /* ignore */ }
  }
  const tabs: [TaskTab, string][] = [
    ['document', 'Document'],
    ...(children.length ? [['subtasks', `Subtasks · ${children.length}`] as [TaskTab, string]] : []),
    ['canvases', `Canvases · ${canvases.length}`],
    ['work', 'Work'],
  ]

  return (
    <section className="taskview">
      <div className="taskmain">
        <div className="taskhead">
          <div className="taskrow">
            {parent ? (
              <button className="crumb" onClick={() => onOpen(parent.id)}>{parent.key} {parent.title} ›</button>
            ) : (
              <button className="crumb" onClick={() => onNav(inPlan ? 'plan' : 'backlog')}>{inPlan ? 'Plan' : 'Backlog'} ›</button>
            )}
            <span className="key">{task.key}</span>
            <span className="type">{task.type}</span>
            <span className={`status s-${task.status}`}>
              {task.status.replace('_', ' ')}
              {children.length > 0 && ` · ${children.filter((c) => c.status === 'done').length}/${children.length}`}
            </span>
            <div className="grow" />
            {canGroom && <button onClick={() => mag.groom(task.id)}>{task.status === 'backlog' ? 'Groom' : 'Re-groom'}</button>}
            {canDevelop && (
              <button onClick={() => mag.develop(task.id)} title="Normally the plan starts the next task by itself">
                {task.status === 'planned' ? 'Start developer now' : 'Restart developer'}
              </button>
            )}
            {!task.parentId && !inPlan && (
              <button className="primary" disabled={blockers.length > 0} title={blockers.join(', ')} onClick={() => mag.addToPlan(task.id)}>
                Add to plan
              </button>
            )}
          </div>
          <h1>{task.title}</h1>
          {task.description && (
            <div className={`brief ${fullBrief ? 'full' : ''}`}>
              <span className="brieftext">{task.description}</span>
              <button className="link" onClick={() => setFullBrief((f) => !f)}>{fullBrief ? 'Less' : 'Full brief'}</button>
            </div>
          )}
          {task.needsInput && <div className="banner">Agent needs you: {task.needsInput}</div>}
          {!task.parentId && !inPlan && blockers.length > 0 && <div className="muted small">Before planning: {blockers.join(' · ')}</div>}
        </div>

        <div className="tasktabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={shownTab === id} className={shownTab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        <div className="taskbody">
          {shownTab === 'document' &&
            (doc ? <Markdown className="md docmd" text={doc} canvases={projectCanvases} onOpenTask={onOpenKey} /> : <p className="muted">No document yet. Groom the task and the agent will write it.</p>)}
          {shownTab === 'subtasks' && <SubtaskList parent={task} subs={children} tasks={tasks} state={state} onOpen={onOpen} />}
          {shownTab === 'canvases' &&
            (canvases.length ? (
              <div className="canvaslist">{canvases.map((c) => <CanvasCard key={c.id + c.version} canvas={c} />)}</div>
            ) : (
              <p className="muted">No canvases yet. Agents draw mockups and diagrams here.</p>
            ))}
          {shownTab === 'work' && <WorkTab task={task} sessions={sessions} onShow={(id) => { setSessionId(id); setChatMode('task') }} />}
        </div>
      </div>

      <div className="chatpanel">
        <div className="chathead">
          <div className="seg" role="group" aria-label="Chat">
            <button className={chatMode === 'task' ? 'on' : ''} aria-pressed={chatMode === 'task'} onClick={() => setChatMode('task')}>Task agent</button>
            <button className={chatMode === 'project' ? 'on' : ''} aria-pressed={chatMode === 'project'} onClick={() => setChatMode('project')}>Project</button>
          </div>
          {chatMode === 'task' && sessions.length > 1 && (
            <select value={session?.id} onChange={(e) => setSessionId(e.target.value)} aria-label="Session">
              {sessions.map((s, i) => <option key={s.id} value={s.id}>#{i + 1} {s.role}</option>)}
            </select>
          )}
          {chatMode === 'task' && session && <span className="chatmodel">{session.role} · {session.activeModel ?? 'default'}</span>}
        </div>
        {chatMode === 'project' ? (
          <ProjectChat key={task.projectId} projectId={task.projectId} state={state} onOpenTask={onOpenKey} embedded />
        ) : session ? (
          <Chat session={session} onOpenTask={onOpenKey} />
        ) : (
          <p className="muted pad">No agent has worked on this task yet.</p>
        )}
      </div>
    </section>
  )
}

/** Subtasks in run order with status, PR and ▲▼ to reorder the ones not started yet. */
function SubtaskList({ parent, subs, tasks, state, onOpen }: { parent: Task; subs: Task[]; tasks: Task[]; state: AppState; onOpen: (id: string) => void }) {
  const move = (i: number, dir: 'up' | 'down') => {
    const ids = subs.map((t) => t.id)
    const j = dir === 'up' ? i - 1 : i + 1
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void mag.reorderSubtasks(parent.id, ids)
  }
  const subline = (t: Task, i: number): React.ReactNode => {
    const run = state.sessions.find((s) => s.taskId === t.id && s.status === 'running')
    if (run) {
      const started = [...run.items].reverse().find((x) => x.kind === 'user')?.at ?? run.createdAt
      return <><span className="dot live" />{run.role} working · {ago(started)}</>
    }
    if (t.status === 'done') return `merged · ${ago(t.updatedAt)} ago`
    if (t.status === 'in_review') return 'waiting for review'
    if (t.status === 'in_progress') return 'started, no agent running'
    return i > 0 ? `next after ${subs[i - 1].key}` : 'first in line'
  }
  return (
    <>
      <div className="sublist">
        {subs.map((t, i) => (
          <div key={t.id} className="subrow" onClick={() => onOpen(t.id)}>
            <span className="ord">
              {(['up', 'down'] as const).map((dir) => (
                <button key={dir} className="icon" disabled={!canMoveSubtask(t, tasks, dir)} aria-label={`Move ${t.key} ${dir}`} onClick={(e) => { e.stopPropagation(); move(i, dir) }}>
                  {dir === 'up' ? '▲' : '▼'}
                </button>
              ))}
            </span>
            <span className="key">{t.key}</span>
            <div className="subtitle">
              <button className="link" onClick={(e) => { e.stopPropagation(); onOpen(t.id) }}>{t.title}</button>
              <div className="muted small">{subline(t, i)}</div>
            </div>
            {t.work?.prUrl ? (
              <button className="link small" onClick={(e) => { e.stopPropagation(); mag.open(t.work!.prUrl!) }}>{prLabel(t.work.prUrl)}</button>
            ) : (
              <span className="muted">—</span>
            )}
            <span className={`status s-${t.status}`}>{t.status.replace('_', ' ')}</span>
            <span className="no">{i + 1}</span>
          </div>
        ))}
      </div>
      <p className="muted small">Subtasks run in this order.</p>
    </>
  )
}

/** Branch, worktree and PR of the task, and every agent session that worked on it. */
function WorkTab({ task, sessions, onShow }: { task: Task; sessions: AgentSession[]; onShow: (sessionId: string) => void }) {
  const agents = useAgents()
  return (
    <>
      {task.work ? (
        <div className="meta">
          <span>Branch <code>{task.work.branch}</code></span>
          <button className="link" onClick={() => mag.open(task.work!.worktree)}>open worktree</button>
          {task.work.prUrl && <button className="link" onClick={() => mag.open(task.work!.prUrl!)}>open PR ↗</button>}
          {task.work.prUrl && <button className="link" onClick={() => mag.checkPrs()}>check now</button>}
          {task.work.checkError && <span className="pill amber" title={task.work.checkError}>PR check failed: {task.work.checkError.slice(0, 80)}</span>}
        </div>
      ) : (
        <p className="muted">No developer has started on this task yet.</p>
      )}
      <h2>Sessions</h2>
      {sessions.length ? (
        <div className="sessionlist">
          {sessions.map((s, i) => (
            <button key={s.id} className="sessionrow" onClick={() => onShow(s.id)} title="Show in the chat panel">
              <span className="no">#{i + 1}</span>
              <span>{s.role}</span>
              <span className="muted grow">{agentName(agents, s.agent)} · {s.activeModel ?? 'default'}</span>
              <span className={`status ${s.status === 'running' ? 's-in_progress' : ''}`}>{s.status}</span>
              <span className="muted small">${sessionCost(s).toFixed(2)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">No agent sessions yet.</p>
      )}
    </>
  )
}

function RepoStatus({ path }: { path: string }) {
  const [info, setInfo] = useState<{ git: boolean; origin: string | null } | null>(null)
  useEffect(() => {
    mag.repoInfo(path).then(setInfo)
  }, [path])
  if (!info) return null
  if (!info.git) return <span className="pill amber">not a git repo</span>
  if (!info.origin) return <span className="pill amber">no origin remote</span>
  return <span className="muted small">{info.origin}</span>
}

const ROLE_LABELS: Record<string, string> = { chat: 'Project chat', groomer: 'Groomer', developer: 'Developer', architect: 'Architect' }

function AgentSettings({ project }: { project: Project }) {
  const agents = useAgents()
  return (
    <div className="field">
      Agents
      <div className="agentroles">
        {SETTABLE_ROLES.map((role) => (
          <div key={role} className="agentrole">
            <span>{ROLE_LABELS[role] ?? role}</span>
            <ModelPicker
              agents={agents}
              label={ROLE_LABELS[role] ?? role}
              choice={resolveChoice(project, role)}
              onChange={(c) => mag.updateProject(project.id, { agents: { ...project.agents, [role]: c } })}
            />
          </div>
        ))}
      </div>
      <span className="muted small">Reviewer uses the Developer choice. Changes apply to the next agent turn; switching the provider starts a fresh agent session.</span>
    </div>
  )
}

function Settings({ project }: { project: Project }) {
  const update = (patch: Partial<Project>) => mag.updateProject(project.id, patch)
  return (
    <section className="page">
      <h1>Settings</h1>
      <label className="field">Name<input defaultValue={project.name} onChange={(e) => update({ name: e.target.value })} /></label>
      <div className="field">
        Repositories
        {project.repos.map((r) => (
          <div key={r} className="repo">
            <code>{r}</code>
            <RepoStatus path={r} />
            <button className="link" onClick={() => update({ repos: project.repos.filter((x) => x !== r) })}>remove</button>
          </div>
        ))}
        <button onClick={async () => { const d = await mag.pickDir(); if (d && !project.repos.includes(d)) update({ repos: [...project.repos, d] }) }}>+ Add repository</button>
        <form onSubmit={(e) => { e.preventDefault(); const input = e.currentTarget.elements.namedItem('repoPath') as HTMLInputElement; const d = input.value.trim(); if (d && !project.repos.includes(d)) update({ repos: [...project.repos, d] }); input.value = '' }}>
          <input name="repoPath" placeholder="…or paste an absolute path and press Enter" aria-label="Repository path" style={{ width: '100%' }} />
        </form>
        <span className="muted small">The first repository is the agent's working directory; the rest are added with --add-dir.</span>
      </div>
      <div className="row2">
        <label className="field">Base branch<input defaultValue={project.baseBranch} onChange={(e) => update({ baseBranch: e.target.value.trim() || 'main' })} /></label>
      </div>
      <label className="check">
        <input type="checkbox" checked={project.enforceArchitecture} onChange={(e) => update({ enforceArchitecture: e.target.checked })} />
        Enforce core architecture (lib / clients / services) for agents
      </label>
      <AgentSettings project={project} />
      <label className="field">Notes for agents<textarea defaultValue={project.notes} rows={4} onChange={(e) => update({ notes: e.target.value })} /></label>
      <h2>Doc templates</h2>
      {TYPES.map((t) => (
        <label key={t} className="field">{t}
          <textarea rows={6} defaultValue={project.templates[t] ?? DEFAULT_TEMPLATES[t]} onChange={(e) => update({ templates: { ...project.templates, [t]: e.target.value } })} />
        </label>
      ))}
    </section>
  )
}
