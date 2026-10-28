import { useEffect, useMemo, useState } from 'react'
import {
  BACKLOG_STATUSES,
  DEFAULT_TEMPLATES,
  PLAN_STATUSES,
  PROJECT_COLORS,
  SETTABLE_ROLES,
  canMoveInPlan,
  canMoveSubtask,
  inbox,
  integrationMode,
  planBlockers,
  planQueue,
  projectColor,
  repoWorkName,
  resolveChoice,
  subtaskProgress,
  subtasksOf,
  taskPrs,
  type AgentRole,
  type AgentSession,
  type Integration,
  type IntegrationMode,
  type Project,
  type Task,
  type TaskStatus,
  type TaskType,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { ModelPicker, agentName, useAgents } from './Agents'
import { Architecture } from './Architecture'
import { CanvasCard, Chat, Markdown, ProjectChat } from './Chat'
import { ago, prLabel } from './format'
import { ErrorBoundary } from './ErrorBoundary'
import { Home, StatusChip } from './Home'
import { Logo } from './Logo'
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
type Tab = 'home' | 'backlog' | 'plan' | 'architecture' | 'settings'
const TAB_NAMES: Record<Tab, string> = { home: 'Home', backlog: 'Backlog', plan: 'Plan', architecture: 'Architecture', settings: 'Settings' }

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('home')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(null)
  const [focusNewTask, setFocusNewTask] = useState(false)
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

  // A pop-out asked to show a task (a task key clicked in a doc window).
  useEffect(
    () =>
      mag.onOpenTask((pid, tid) => {
        setProjectId(pid)
        setTaskId(tid)
      }),
    [],
  )

  if (!state) return null
  const project = state.projects.find((p) => p.id === projectId) ?? state.projects[0] ?? null
  const tasks = project ? state.tasks.filter((t) => t.projectId === project.id) : []
  // Subtasks are steps of their task's plan, not pages: a subtask (e.g. a clicked T-12.3) shows its task.
  const picked = tasks.find((t) => t.id === taskId)
  const task = (picked?.parentId ? tasks.find((t) => t.id === picked.parentId) : picked) ?? null
  const inboxCount = project ? inbox(project.id, tasks, state.sessions).length : 0
  const roots = tasks.filter((t) => !t.parentId)
  const backlogCount = roots.filter((t) => BACKLOG_STATUSES.includes(t.status)).length
  const planCount = roots.length - backlogCount
  /** Leaving a tab drops its status filter and the new-task focus. */
  const go = (t: Tab) => { setTab(t); setTaskId(null); setStatusFilter(null); setFocusNewTask(false) }
  const filterBy = (s: TaskStatus) => { go(BACKLOG_STATUSES.includes(s) ? 'backlog' : 'plan'); setStatusFilter(s) }
  const openKey = (key: string) => setTaskId(tasks.find((t) => t.key === key)?.id ?? null)
  const screen = task ? `Task ${task.key}` : TAB_NAMES[tab]
  const chatBusy = state.sessions.some((s) => s.projectId === project?.id && s.role === 'chat' && s.status === 'running')

  return (
    <div className="app">
      <nav className="rail" aria-label="Projects">
        {state.projects.map((p) => (
          <button key={p.id} className={`railbtn ${p.id === project?.id ? 'on' : ''}`} title={p.name} aria-label={p.name} aria-current={p.id === project?.id} onClick={() => { setProjectId(p.id); setTaskId(null); setStatusFilter(null) }}>
            {initials(p.name)}
          </button>
        ))}
        <NewProject onCreate={(p) => { setProjectId(p.id); go('settings') }} />
        <div className="grow" />
        {!state.claudeBin && <span className="railwarn" role="img" aria-label="Warning" title="Claude Code CLI not found. Set MAG_CLAUDE_BIN or install claude.">⚠</span>}
      </nav>

      {project ? (
        <div className="workspace">
        <main className="main">
          <header className="tabs">
            <span className="brand"><Logo size={22} />mag <span>PoC</span></span>
            <button className={tab === 'home' && !task ? 'on' : ''} onClick={() => go('home')}>
              Home {inboxCount > 0 && <span className="badge">{inboxCount}</span>}
            </button>
            <button className={tab === 'backlog' && !task ? 'on' : ''} onClick={() => go('backlog')}>Backlog <span className="cnt">{backlogCount}</span></button>
            <button className={tab === 'plan' && !task ? 'on' : ''} onClick={() => go('plan')}>Plan <span className="cnt">{planCount}</span></button>
            <button className={tab === 'architecture' && !task ? 'on' : ''} onClick={() => go('architecture')}>Architecture</button>
            <button className={tab === 'settings' && !task ? 'on' : ''} onClick={() => go('settings')}>Settings</button>
            <div className="grow" />
            <ThemeSwitch mode={theme} onChange={setTheme} />
            {!chatOpen && !task && <button onClick={() => toggleChat(true)}>Chat {chatBusy && <span className="dot inline" />}</button>}
          </header>
          <ErrorBoundary key={`${project.id}:${screen}`} screen={screen} appVersion={state.appVersion} onHome={() => go('home')}>
            {task ? (
              <TaskView key={task.id} task={task} tasks={tasks} state={state} onNav={go} onOpenKey={openKey} />
            ) : tab === 'home' ? (
              <Home project={project} tasks={tasks} state={state} onOpen={setTaskId} onOpenKey={openKey} onFilter={filterBy} onNewTask={() => { go('backlog'); setFocusNewTask(true) }} />
            ) : tab === 'backlog' ? (
              <BacklogView project={project} tasks={tasks} onOpen={setTaskId} statusFilter={statusFilter} onClearFilter={() => setStatusFilter(null)} focusNewTask={focusNewTask} />
            ) : tab === 'plan' ? (
              <PlanView tasks={tasks} onOpen={setTaskId} statusFilter={statusFilter} onClearFilter={() => setStatusFilter(null)} />
            ) : tab === 'architecture' ? (
              <Architecture key={project.id} project={project} />
            ) : (
              <Settings project={project} integrations={state.integrations} />
            )}
          </ErrorBoundary>
        </main>
        {chatOpen && !task && (
          <ErrorBoundary key={project.id} screen="Project chat" appVersion={state.appVersion}>
            <ProjectChat projectId={project.id} state={state} onOpenTask={openKey} onClose={() => toggleChat(false)} />
          </ErrorBoundary>
        )}
        </div>
      ) : (
        <main className="main empty">Create a project to start.</main>
      )}
    </div>
  )
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

interface StatusFilterProps {
  /** Only top-level tasks in this status. */
  statusFilter: TaskStatus | null
  onClearFilter: () => void
}

function PlanView({ tasks, onOpen, statusFilter, onClearFilter }: { tasks: Task[]; onOpen: (id: string) => void } & StatusFilterProps) {
  const roots = planQueue(tasks).filter((t) => !statusFilter || t.status === statusFilter)
  return (
    <section className="page">
      <h1>Plan</h1>
      <p className="muted">Runs top to bottom, one task at a time: the next task starts after every PR of the previous one is merged.</p>
      {statusFilter && <StatusChip status={statusFilter} onClear={onClearFilter} />}
      <TaskTree roots={roots} all={tasks} onOpen={onOpen} plan empty={statusFilter ? 'No plan tasks in this status.' : 'Nothing planned yet. Groom tasks from the backlog and add them here.'} />
    </section>
  )
}

function BacklogView({ project, tasks, onOpen, statusFilter, onClearFilter, focusNewTask }: { project: Project; tasks: Task[]; onOpen: (id: string) => void; focusNewTask: boolean } & StatusFilterProps) {
  const roots = tasks
    .filter((t) => !t.parentId && !PLAN_STATUSES.includes(t.status) && (!statusFilter || t.status === statusFilter))
    .sort((a, b) => a.createdAt - b.createdAt)
  return (
    <section className="page">
      <h1>Backlog</h1>
      <NewTask projectId={project.id} autoFocus={focusNewTask} />
      {statusFilter && <StatusChip status={statusFilter} onClear={onClearFilter} />}
      <TaskTree roots={roots} all={tasks} onOpen={onOpen} empty={statusFilter ? 'No backlog tasks in this status.' : 'Backlog is empty.'} />
    </section>
  )
}

/** Top-level tasks with their subtask progress (3/5); `plan` adds ▲▼. */
function TaskTree({ roots, all, onOpen, empty, plan }: { roots: Task[]; all: Task[]; onOpen: (id: string) => void; empty: string; plan?: boolean }) {
  if (!roots.length) return <p className="muted">{empty}</p>
  const row = (t: Task): React.ReactNode => {
    const progress = subtaskProgress(t.id, all)
    return (
      <div key={t.id} className="rowwrap">
        <button className="row" onClick={() => onOpen(t.id)}>
          <span className="key">{t.key}</span>
          <span className="title grow">{t.title}</span>
          {t.needsInput && <span className="dot" title={t.needsInput} />}
          {progress.total > 0 && <span className="muted small" title="Subtasks done">{progress.done}/{progress.total}</span>}
          <span className="type">{t.type}</span>
          <span className={`status s-${t.status}`}>{t.status.replace('_', ' ')}</span>
        </button>
        {plan && (
          <span className="moves">
            {(['up', 'down'] as const).map((dir) => (
              <button key={dir} className="icon" disabled={!canMoveInPlan(t, all, dir)} aria-label={`Move ${t.key} ${dir}`} onClick={() => mag.move(t.id, dir)}>
                {dir === 'up' ? '▲' : '▼'}
              </button>
            ))}
          </span>
        )}
      </div>
    )
  }
  return <div className="tree">{roots.map(row)}</div>
}

function NewTask({ projectId, autoFocus }: { projectId: string; autoFocus?: boolean }) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState<TaskType>('dev')
  const [description, setDescription] = useState('')
  return (
    <form className="newtask" onSubmit={async (e) => { e.preventDefault(); if (!title.trim()) return; await mag.createTask({ projectId, title: title.trim(), type, description }); setTitle(''); setDescription('') }}>
      <input autoFocus={autoFocus} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task title" aria-label="Task title" />
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

const sessionCost = (s: AgentSession) => s.items.reduce((sum, i) => sum + (i.kind === 'result' ? (i.costUsd ?? 0) : 0), 0)

function TaskView({ task, tasks, state, onNav, onOpenKey }: { task: Task; tasks: Task[]; state: AppState; onNav: (tab: Tab) => void; onOpenKey: (key: string) => void }) {
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
  const children = subtasksOf(task.id, tasks)
  const progress = subtaskProgress(task.id, tasks)
  const anyRunning = sessions.some((s) => s.status === 'running')
  const inPlan = PLAN_STATUSES.includes(task.status)
  const canGroom = !anyRunning && !inPlan
  const canDevelop = !anyRunning && (task.status === 'planned' || task.status === 'in_progress')
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
    ...(children.length ? [['subtasks', `Subtasks · ${progress.done}/${progress.total}`] as [TaskTab, string]] : []),
    ['canvases', `Canvases · ${canvases.length}`],
    ['work', 'Work'],
  ]

  return (
    <section className="taskview">
      <div className="taskmain">
        <div className="taskhead">
          <div className="taskrow">
            <button className="crumb" onClick={() => onNav(inPlan ? 'plan' : 'backlog')}>{inPlan ? 'Plan' : 'Backlog'} ›</button>
            <span className="key">{task.key}</span>
            <span className="type">{task.type}</span>
            <span className={`status s-${task.status}`}>
              {task.status.replace('_', ' ')}
              {progress.total > 0 && ` · ${progress.done}/${progress.total}`}
            </span>
            <div className="grow" />
            {canGroom && <button onClick={() => mag.groom(task.id)}>{task.status === 'backlog' ? 'Groom' : 'Re-groom'}</button>}
            {canDevelop && (
              <button onClick={() => mag.develop(task.id)} title="Normally the plan starts the next task by itself">
                {task.status === 'planned' ? 'Start developer now' : 'Restart developer'}
              </button>
            )}
            {!inPlan && (
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
          {!inPlan && blockers.length > 0 && <div className="muted small">Before planning: {blockers.join(' · ')}</div>}
        </div>

        <div className="tasktabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={shownTab === id} className={shownTab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
          {shownTab === 'document' && doc && (
            <button className="link popbtn" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'doc', taskId: task.id })}>
              ⧉ Open in window
            </button>
          )}
        </div>

        <div className="taskbody">
          {shownTab === 'document' &&
            (doc ? <Markdown className="md docmd" text={doc} canvases={projectCanvases} onOpenTask={onOpenKey} /> : <p className="muted">No document yet. Groom the task and the agent will write it.</p>)}
          {shownTab === 'subtasks' && <SubtaskList parent={task} subs={children} tasks={tasks} />}
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
          <Chat session={session} sessions={state.sessions} onOpenTask={onOpenKey} />
        ) : (
          <p className="muted pad">No agent has worked on this task yet.</p>
        )}
      </div>
    </section>
  )
}

/** The task's plan as a checklist: the developer ticks steps off as it goes; the user can tick, edit and reorder too. */
function SubtaskList({ parent, subs, tasks }: { parent: Task; subs: Task[]; tasks: Task[] }) {
  const move = (i: number, dir: 'up' | 'down') => {
    const ids = subs.map((t) => t.id)
    const j = dir === 'up' ? i - 1 : i + 1
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void mag.reorderSubtasks(parent.id, ids)
  }
  const { done, total } = subtaskProgress(parent.id, tasks)
  return (
    <>
      <div className="sublist">
        {subs.map((t, i) => (
          <SubtaskRow key={t.id} sub={t} canMove={(dir) => canMoveSubtask(t, tasks, dir)} onMove={(dir) => move(i, dir)} />
        ))}
      </div>
      <p className="muted small">{done}/{total} done. A plan, not a queue: one developer works through it in one session.</p>
    </>
  )
}

function SubtaskRow({ sub, canMove, onMove }: { sub: Task; canMove: (dir: 'up' | 'down') => boolean; onMove: (dir: 'up' | 'down') => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(sub.title)
  const [note, setNote] = useState(sub.description)
  const done = sub.status === 'done'
  const edit = () => {
    setTitle(sub.title)
    setNote(sub.description)
    setEditing(true)
  }
  const save = () => {
    if (title.trim()) void mag.updateTask(sub.id, { title: title.trim(), description: note.replace(/\s+/g, ' ').trim() })
    setEditing(false)
  }
  return (
    <div className={`subrow ${done ? 'done' : ''}`}>
      <span className="ord">
        {(['up', 'down'] as const).map((dir) => (
          <button key={dir} className="icon" disabled={!canMove(dir)} aria-label={`Move ${sub.key} ${dir}`} onClick={() => onMove(dir)}>
            {dir === 'up' ? '▲' : '▼'}
          </button>
        ))}
      </span>
      <input type="checkbox" checked={done} aria-label={`${sub.key} done`} onChange={(e) => mag.updateTask(sub.id, { status: e.target.checked ? 'done' : 'todo' })} />
      <span className="key">{sub.key}</span>
      {editing ? (
        <form className="subedit" onSubmit={(e) => { e.preventDefault(); save() }} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Subtask title" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional, one line)" aria-label="Subtask note" />
          <button type="submit" className="primary">Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <>
          <div className="subtitle" onDoubleClick={edit}>
            <div className="subname">{sub.title}</div>
            {sub.description && <div className="muted small">{sub.description}</div>}
          </div>
          <button className="link small" onClick={edit}>Edit</button>
        </>
      )}
    </div>
  )
}

/** Task dir, and per repo its branch, worktree and PR; then every agent session that worked on the task. */
function WorkTab({ task, sessions, onShow }: { task: Task; sessions: AgentSession[]; onShow: (sessionId: string) => void }) {
  const agents = useAgents()
  const work = task.work
  return (
    <>
      {work ? (
        <>
          <div className="meta">
            <button className="link" onClick={() => mag.open(work.dir)}>open task folder</button>
            {taskPrs(task).length > 0 && <button className="link" onClick={() => mag.checkPrs()}>check PRs now</button>}
          </div>
          <div className="repolist">
            {work.repos.map((r) => (
              <div key={r.repo} className="reporow">
                <span className="reponame">{repoWorkName(work, r)}</span>
                <code className="grow">{r.branch}</code>
                <button className="link" onClick={() => mag.open(r.worktree)}>worktree</button>
                {r.prUrl ? <button className="link" onClick={() => mag.open(r.prUrl!)}>{prLabel(r.prUrl)}</button> : <span className="muted">no PR</span>}
                {r.prState && <span className={`status ${r.prState === 'merged' ? 's-done' : r.prState === 'open' ? 's-in_review' : ''}`}>{r.prState}</span>}
                {r.checkError && <span className="pill amber" title={r.checkError}>check failed: {r.checkError.slice(0, 60)}</span>}
              </div>
            ))}
          </div>
        </>
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

const MODES: [IntegrationMode, string][] = [['off', 'Off'], ['ask', 'Ask'], ['auto', 'Auto']]

/** Off / Ask / Auto per integration and role. Codex has no integrations; the architect has no chat to ask in. */
function IntegrationSettings({ project, integrations }: { project: Project; integrations: Integration[] }) {
  const set = (role: AgentRole, id: string, mode: IntegrationMode) =>
    mag.updateProject(project.id, { integrations: { ...project.integrations, [role]: { ...project.integrations[role], [id]: mode } } })
  return (
    <div className="field">
      Integrations
      {integrations.length ? (
        <div className="integrations" style={{ gridTemplateColumns: `minmax(0, max-content) repeat(${SETTABLE_ROLES.length}, max-content)` }}>
          <span />
          {SETTABLE_ROLES.map((role) => <span key={role} className="muted small">{ROLE_LABELS[role] ?? role}</span>)}
          {integrations.map((i) => (
            <div key={i.id} style={{ display: 'contents' }}>
              <span title={i.id}>{i.name}</span>
              {SETTABLE_ROLES.map((role) =>
                resolveChoice(project, role).agent !== 'claude-code' ? (
                  <span key={role} className="muted small" title="Only Claude Code agents use integrations">n/a</span>
                ) : (
                  <select key={role} value={integrationMode(project, role, i.id)} aria-label={`${i.name} for ${ROLE_LABELS[role] ?? role}`} onChange={(e) => set(role, i.id, e.target.value as IntegrationMode)}>
                    {MODES.map(([m, label]) => (
                      <option key={m} value={m} disabled={m === 'ask' && role === 'architect'}>{label}</option>
                    ))}
                  </select>
                ),
              )}
            </div>
          ))}
        </div>
      ) : (
        <span className="muted small">Run any Claude Code agent to detect integrations.</span>
      )}
      <span className="muted small">Off hides the integration from the agent, Ask waits for your Allow in Home or the chat, Auto lets it run. Reviewer uses the Developer setting; the architect cannot ask.</span>
    </div>
  )
}

function Settings({ project, integrations }: { project: Project; integrations: Integration[] }) {
  const update = (patch: Partial<Project>) => mag.updateProject(project.id, patch)
  return (
    <section className="page">
      <h1>Settings</h1>
      <label className="field">Name<input defaultValue={project.name} onChange={(e) => update({ name: e.target.value })} /></label>
      <div className="field">
        Color
        <div className="swatches" role="radiogroup" aria-label="Project color">
          <button role="radio" aria-checked={!project.color} className={`swatch auto ${!project.color ? 'on' : ''}`} title="Auto: picked from the project id" onClick={() => update({ color: null })}>
            <span style={{ background: projectColor({ id: project.id }) }} />Auto
          </button>
          {PROJECT_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={project.color === c} aria-label={c} className={`swatch ${project.color === c ? 'on' : ''}`} onClick={() => update({ color: c })}>
              <span style={{ background: c }} />
            </button>
          ))}
        </div>
      </div>
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
      <IntegrationSettings project={project} integrations={integrations} />
      <label className="field">Notes for agents<textarea defaultValue={project.notes} rows={4} onChange={(e) => update({ notes: e.target.value })} /></label>
      <h2>Doc templates</h2>
      {TYPES.map((t) => (
        <label key={t} className="field">{t}
          <textarea rows={6} defaultValue={project.templates[t] ?? DEFAULT_TEMPLATES[t]} onChange={(e) => update({ templates: { ...project.templates, [t]: e.target.value } })} />
        </label>
      ))}
      <h2>Diagnostics</h2>
      <div className="field">
        <div><button onClick={() => mag.openLogs()}>Open logs folder</button></div>
        <span className="muted small">mag's logs and crash reports. The project chat can read them: ask it to look at the last crash.</span>
      </div>
    </section>
  )
}
