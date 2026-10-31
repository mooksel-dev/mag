import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_TEMPLATES,
  PROJECT_COLORS,
  SETTABLE_ROLES,
  SUBTASK_STATUSES,
  STATUS_LABELS,
  agentState,
  canMoveSubtask,
  currentStep,
  inbox,
  integrationMode,
  isLegacy,
  openPrs,
  projectColor,
  repoWorkName,
  resolveChoice,
  runningAgents,
  subtaskProgress,
  subtasksOf,
  taskPrs,
  taskView,
  viewCounts,
  type AgentRole,
  type AgentSession,
  type Integration,
  type IntegrationMode,
  type PipelineStage,
  type Project,
  type SubtaskStatus,
  type Task,
  type TaskType,
  type TasksView,
  type TaskWork,
  type TrackerKind,
  type TrackerScope,
} from '@mag/core'
import type { AppState, PickerMode } from '../../preload/api'
import { ModelPicker, agentName, useAgents } from './Agents'
import { Architecture } from './Architecture'
import { CanvasCard, Chat, Markdown, ProjectChat } from './Chat'
import { prLabel } from './format'
import { ErrorBoundary } from './ErrorBoundary'
import { Home } from './Home'
import { Logo } from './Logo'
import { ProjectPicker, ProjectSquare } from './Picker'
import { AgentDot, ArchiveButton, CancelButton, MoveToTodoButton, PrBadges, StatusPill, SubtaskIcon, TasksPage, TicketChip, useNow, type NewTaskFocus } from './Tasks'
import { scopeKey, scopeWarning } from './trackers'
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
type Tab = 'home' | 'tasks' | 'architecture' | 'settings'
const TAB_NAMES: Record<Tab, string> = { home: 'Home', tasks: 'Tasks', architecture: 'Architecture', settings: 'Settings' }
const VIEW_NAMES: Record<TasksView, string> = { active: 'Active', backlog: 'Backlog', archive: 'Archive' }

/** One project's window; the project is fixed for the window's lifetime. */
export function App({ projectId }: { projectId: string }) {
  const [state, setState] = useState<AppState | null>(null)
  const [tab, setTab] = useState<Tab>('home')
  const [picker, setPicker] = useState<PickerMode | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [view, setView] = useState<TasksView>('active')
  const [focusNewTask, setFocusNewTask] = useState<NewTaskFocus>(null)
  const [chatOpen, setChatOpen] = useState(() => loadFlag('mag.chatOpen', true))
  const [theme, setTheme] = useTheme()
  const toggleChat = (v: boolean) => {
    setChatOpen(v)
    try { localStorage.setItem('mag.chatOpen', v ? '1' : '0') } catch { /* ignore */ }
  }

  useEffect(() => {
    mag.getState().then((s) => {
      setState(s)
      // A new project has nothing to show until it has repositories.
      if (s.projects.find((p) => p.id === projectId)?.repos.length === 0) setTab('settings')
    })
    return mag.onState(setState)
  }, [projectId])

  // A pop-out or a notification asked to show a task; main sends it to this project's window only.
  useEffect(() => mag.onOpenTask((_, tid) => setTaskId(tid)), [])
  // ⌘O, File → Open Project… / New Project…, the dock menu.
  useEffect(() => mag.onOpenPicker(setPicker), [])

  const project = state?.projects.find((p) => p.id === projectId) ?? null
  useEffect(() => {
    document.title = project?.name ?? 'mag'
  }, [project?.name])

  if (!state) return null
  if (!project) return <div className="app"><main className="main empty">This project no longer exists.</main></div>
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const color = projectColor(project)
  // Subtasks are steps of their task's plan, not pages: a subtask (e.g. a clicked T-12.3) shows its task.
  const picked = tasks.find((t) => t.id === taskId)
  const task = (picked?.parentId ? tasks.find((t) => t.id === picked.parentId) : picked) ?? null
  const inboxCount = inbox(project.id, tasks, state.sessions).length
  const activeCount = viewCounts(tasks).active
  /** Leaving a tab drops the new-task focus. */
  const go = (t: Tab) => { setTab(t); setTaskId(null); setFocusNewTask(null) }
  const showView = (v: TasksView) => { go('tasks'); setView(v) }
  const openStage = (s: PipelineStage) => showView(s === 'backlog' ? 'backlog' : 'active')
  const openKey = (key: string) => setTaskId(tasks.find((t) => t.key === key)?.id ?? null)
  const screen = task ? `Task ${task.key}` : tab === 'tasks' ? `Tasks · ${VIEW_NAMES[view]}` : TAB_NAMES[tab]
  const chatBusy = state.sessions.some((s) => s.projectId === project.id && s.role === 'chat' && s.status === 'running')

  return (
    <div className="app" style={{ '--pc': color } as React.CSSProperties}>
      <div className="titlebar">
        <div className="projmenu">
          <button className="projbtn" aria-haspopup="dialog" aria-expanded={!!picker} title="Switch project (⌘O)" onClick={() => setPicker(picker ? null : 'open')}>
            <ProjectSquare project={project} />
            <span className="pname">{project.name}</span>
            <span className="caret" aria-hidden>▾</span>
          </button>
          {picker && <ProjectPicker key={picker} state={state} currentId={project.id} mode={picker} onClose={() => setPicker(null)} />}
        </div>
        <span className="brand"><Logo size={16} />mag <span>PoC</span></span>
        <div className="grow" />
        <AgentCounter state={state} />
        {!state.claudeBin && <span className="clawarn" role="img" aria-label="Warning" title="Claude Code CLI not found. Set MAG_CLAUDE_BIN or install claude.">⚠ Claude CLI not found</span>}
      </div>
        <div className="workspace">
        <main className="main">
          <header className="tabs">
            <button className={tab === 'home' && !task ? 'on' : ''} onClick={() => go('home')}>
              Home {inboxCount > 0 && <span className="badge">{inboxCount}</span>}
            </button>
            <button className={tab === 'tasks' && !task ? 'on' : ''} onClick={() => go('tasks')}>Tasks <span className="cnt">{activeCount}</span></button>
            <button className={tab === 'architecture' && !task ? 'on' : ''} onClick={() => go('architecture')}>Architecture</button>
            <button className={tab === 'settings' && !task ? 'on' : ''} onClick={() => go('settings')}>Settings</button>
            <div className="grow" />
            <ThemeSwitch mode={theme} onChange={setTheme} />
            {!chatOpen && !task && <button onClick={() => toggleChat(true)}>Chat {chatBusy && <span className="dot inline" />}</button>}
          </header>
          <ErrorBoundary key={`${project.id}:${screen}`} screen={screen} appVersion={state.appVersion} onHome={() => go('home')}>
            {task ? (
              <TaskView key={task.id} task={task} tasks={tasks} state={state} onNav={showView} onOpenKey={openKey} />
            ) : tab === 'home' ? (
              <Home project={project} tasks={tasks} state={state} onOpen={setTaskId} onOpenKey={openKey} onStage={openStage} onNewTask={() => { showView('backlog'); setFocusNewTask('task') }} onImport={() => { showView('backlog'); setFocusNewTask('import') }} />
            ) : tab === 'tasks' ? (
              <TasksPage project={project} tasks={tasks} sessions={state.sessions} view={view} onView={setView} onOpen={setTaskId} focusNewTask={focusNewTask} />
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
    </div>
  )
}

const THEMES: [ThemeMode, string, string][] = [['light', '☀︎', 'Light'], ['dark', '☾', 'Dark'], ['system', 'Auto', 'Follow the system']]

/** Agents running now across all projects; there is no limit on how many. */
function AgentCounter({ state }: { state: AppState }) {
  const running = runningAgents(state.sessions)
  if (!running.length) return null
  const line = (s: AgentSession) => {
    const project = state.projects.find((p) => p.id === s.projectId)?.name ?? '?'
    const key = s.taskId ? state.tasks.find((t) => t.id === s.taskId)?.key ?? '?' : 'chat'
    return `${project} · ${key} · ${s.role}`
  }
  return (
    <span className="agentcount" title={running.map(line).join('\n')}>
      ● {running.length} {running.length === 1 ? 'agent' : 'agents'}
    </span>
  )
}

function ThemeSwitch({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  return (
    <div className="seg" role="group" aria-label="Theme">
      {THEMES.map(([m, label, title]) => (
        <button key={m} className={m === mode ? 'on' : ''} aria-pressed={m === mode} title={title} onClick={() => onChange(m)}>{label}</button>
      ))}
    </div>
  )
}

type TaskTab = 'document' | 'subtasks' | 'canvases' | 'work'
type ChatMode = 'task' | 'project'

const sessionCost = (s: AgentSession) => s.items.reduce((sum, i) => sum + (i.kind === 'result' ? (i.costUsd ?? 0) : 0), 0)

/** A group of a task's sessions: grooming, one step's developer, or a legacy task's developer. */
interface SessionGroup {
  label: string
  step?: Task
  sessions: AgentSession[]
}

/** Sessions by what they worked on: grooming first, then each step in order; legacy developer sessions last. */
function sessionGroups(steps: Task[], sessions: AgentSession[]): SessionGroup[] {
  const groups: SessionGroup[] = [
    { label: 'Grooming', sessions: sessions.filter((s) => s.role === 'groomer') },
    ...steps.map((step) => ({ label: `${step.key} · developer`, step, sessions: sessions.filter((s) => s.stepId === step.id) })),
    { label: 'Developer', sessions: sessions.filter((s) => s.role !== 'groomer' && !steps.some((st) => st.id === s.stepId)) },
  ]
  return groups.filter((g) => g.sessions.length || g.step)
}

function TaskView({ task, tasks, state, onNav, onOpenKey }: { task: Task; tasks: Task[]; state: AppState; onNav: (view: TasksView) => void; onOpenKey: (key: string) => void }) {
  const sessions = state.sessions.filter((s) => s.taskId === task.id)
  const children = subtasksOf(task.id, tasks)
  const legacy = isLegacy(task)
  // Steps (T-28): each with its own developer session and PRs. A legacy task's subtasks are a checklist.
  const stepMode = !legacy && children.length > 0
  const singleStep = stepMode && children.length === 1
  const step = legacy ? null : currentStep(task.id, tasks)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // The current step's session by default, else the latest one.
  const session = sessions.find((s) => s.id === sessionId) ?? (step && sessions.filter((s) => s.stepId === step.id).at(-1)) ?? sessions.at(-1) ?? null
  const doc = state.docs[task.id]
  // The doc may link any canvas of the project (e.g. one drawn in the project chat); the tab lists the task's own.
  const projectCanvases = useMemo(() => state.canvases.filter((c) => c.projectId === task.projectId), [state.canvases, task.projectId])
  const canvases = useMemo(
    () => projectCanvases.filter((c) => c.taskId === task.id).sort((a, b) => b.updatedAt - a.updatedAt),
    [projectCanvases, task.id],
  )
  const progress = subtaskProgress(task.id, tasks)
  const anyRunning = sessions.some((s) => s.status === 'running')
  const canGroom = !anyRunning && !task.work && ['backlog', 'grooming', 'todo'].includes(task.status)
  // A step that starts manually is started from the banner.
  const manualNext = task.status === 'in_progress' && step?.status === 'todo' && !!step.startManually
  const canDevelop = !anyRunning && (task.status === 'todo' || (task.status === 'in_progress' && (legacy || (!!step && !manualNext))))
  const developLabel = task.status === 'todo' ? 'Start' : step?.status === 'todo' ? `Start ${step.key}` : 'Restart developer'
  const canRegroomRemaining = !anyRunning && !legacy && task.status === 'in_progress'
  // An import that ended without a brief (T-10); the inbox shows it as Import failed.
  const lastTracker = sessions.filter((s) => s.role === 'tracker').at(-1)
  const importFailed = !!task.tracker && !task.tracker.importedAt && lastTracker?.status === 'error' && !anyRunning
  const view = taskView(task)
  const now = useNow(15_000)
  const prs = openPrs(task, tasks)
  const stepPrs = step?.status === 'in_progress' ? openPrs(step) : []
  const [tab, setTab] = useState<TaskTab>(() => (stepMode && !singleStep ? 'subtasks' : 'document'))
  const shownTab = tab === 'subtasks' && (!children.length || singleStep) ? 'document' : tab
  const [fullBrief, setFullBrief] = useState(false)
  const [chatMode, setChatModeState] = useState<ChatMode>(() => (loadFlag('mag.taskChatProject', false) ? 'project' : 'task'))
  const setChatMode = (m: ChatMode) => {
    setChatModeState(m)
    try { localStorage.setItem('mag.taskChatProject', m === 'project' ? '1' : '0') } catch { /* ignore */ }
  }
  const subtasksTab: [TaskTab, string] = ['subtasks', `Subtasks · ${progress.done}/${progress.total}`]
  const tabs: [TaskTab, string][] = [
    // Steps come first; a single step shows in the header instead.
    ...(stepMode && !singleStep ? [subtasksTab] : []),
    ['document', 'Document'],
    ...(legacy && children.length ? [subtasksTab] : []),
    ['canvases', `Canvases · ${canvases.length}`],
    ['work', 'Work'],
  ]
  const groups = stepMode ? sessionGroups(children, sessions) : null

  return (
    <section className="taskview">
      <div className="taskmain">
        <div className="taskhead">
          <div className="taskrow">
            <button className="crumb" onClick={() => onNav(view)}>Tasks · {VIEW_NAMES[view]} ›</button>
            <span className="key">{task.key}</span>
            <TicketChip task={task} />
            <span className="type">{task.type}</span>
            <StatusPill status={task.status} />
            {progress.total > 1 && <span className="muted small" title="Steps done">{progress.done}/{progress.total}</span>}
            {task.status === 'in_progress' && prs.length > 0 && <span className="pill green">PR open</span>}
            {task.archivedAt && <span className="pill">archived</span>}
            <AgentDot state={agentState(task, sessions, tasks)} now={now} />
            <div className="grow" />
            {canGroom && <button onClick={() => mag.groom(task.id)}>{task.status === 'backlog' ? 'Groom' : 'Re-groom'}</button>}
            {(task.status === 'backlog' || task.status === 'grooming') && <MoveToTodoButton task={task} tasks={tasks} sessions={sessions} />}
            {canDevelop && <button onClick={() => mag.develop(task.id)}>{developLabel}</button>}
            <ArchiveButton task={task} />
            <CancelButton task={task} />
          </div>
          <h1>{task.title}</h1>
          {task.description && (
            <div className={`brief ${fullBrief ? 'full' : ''}`}>
              <span className="brieftext">{task.description}</span>
              <button className="link" onClick={() => setFullBrief((f) => !f)}>{fullBrief ? 'Less' : 'Full brief'}</button>
            </div>
          )}
          {singleStep && (
            <div className="sublist stepline">
              <SubtaskRow sub={children[0]} steps canMove={() => false} onMove={() => {}} />
            </div>
          )}
          {task.needsInput && (
            <div className="banner">
              Agent needs you: {task.needsInput}
              {canRegroomRemaining && <button className="small" onClick={() => mag.regroomRemaining(task.id)}>Re-groom remaining</button>}
            </div>
          )}
          {importFailed && (
            <div className="banner">
              Import of {task.tracker!.key} failed: the tracker agent wrote no brief. See its session in the chat panel.
              <button className="primary small" onClick={() => mag.retryImport(task.id)}>Retry import</button>
            </div>
          )}
          {!task.needsInput && !anyRunning && manualNext && step && (
            <div className="banner">
              {step.key} waits for Start
              <button className="primary small" onClick={() => mag.startStep(task.id)}>Start</button>
            </div>
          )}
          {!task.needsInput && !anyRunning && step && stepPrs.length > 0 && (
            <div className="banner info">Step {step.key}: {stepPrs.length > 1 ? `${stepPrs.length} PRs wait` : 'PR waits'} for merge</div>
          )}
          {task.status === 'canceled' && (
            <div className="muted small">
              Canceled{task.cancelReason ? `: ${task.cancelReason}` : '.'}
              {prs.length > 0 && <> Its PRs are still open; close them on GitHub: {prs.map((r) => <button key={r.prUrl} className="link" onClick={() => mag.open(r.prUrl!)}>{prLabel(r.prUrl!)}</button>)}</>}
            </div>
          )}
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
          {shownTab === 'subtasks' && <SubtaskList parent={task} subs={children} tasks={tasks} steps={stepMode} />}
          {shownTab === 'canvases' &&
            (canvases.length ? (
              <div className="canvaslist">{canvases.map((c) => <CanvasCard key={c.id + c.version} canvas={c} />)}</div>
            ) : (
              <p className="muted">No canvases yet. Agents draw mockups and diagrams here.</p>
            ))}
          {shownTab === 'work' && (
            <WorkTab task={task} groups={groups} sessions={sessions} onShow={(id) => { setSessionId(id); setChatMode('task') }} />
          )}
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
              {groups
                ? groups.filter((g) => g.sessions.length).map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.sessions.map((s, i) => <option key={s.id} value={s.id}>{g.label}{g.sessions.length > 1 ? ` #${i + 1}` : ''}</option>)}
                    </optgroup>
                  ))
                : sessions.map((s, i) => <option key={s.id} value={s.id}>#{i + 1} {s.role}</option>)}
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

/**
 * The task's steps in order. Steps: status follows the lifecycle (read-only icon); todo steps can be edited and swap
 * places. A legacy checklist: the user can tick, edit and reorder any step.
 */
function SubtaskList({ parent, subs, tasks, steps }: { parent: Task; subs: Task[]; tasks: Task[]; steps: boolean }) {
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
          <SubtaskRow key={t.id} sub={t} steps={steps} canMove={(dir) => canMoveSubtask(t, tasks, dir)} onMove={(dir) => move(i, dir)} />
        ))}
      </div>
      <p className="muted small">
        {done}/{total} done.{' '}
        {steps
          ? 'Steps run one after another, each in a new developer session with its own branch and PRs. A step is done when its PRs are merged; the next one starts on its own unless it starts manually.'
          : 'A plan: one developer works through it in one session and marks each step ◐ in progress, then ● done. Click an icon to change it.'}
      </p>
    </>
  )
}

/** Clicking a checklist subtask's status icon steps todo → in progress → done → todo. */
const nextStatus = (s: Task['status']): SubtaskStatus => SUBTASK_STATUSES[(SUBTASK_STATUSES.indexOf(s as SubtaskStatus) + 1) % SUBTASK_STATUSES.length]

function SubtaskRow({ sub, steps, canMove, onMove }: { sub: Task; steps: boolean; canMove: (dir: 'up' | 'down') => boolean; onMove: (dir: 'up' | 'down') => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(sub.title)
  const [note, setNote] = useState(sub.description)
  const [manual, setManual] = useState(!!sub.startManually)
  const done = sub.status === 'done'
  // A step that started keeps its plan; a checklist step can always be edited.
  const editable = !steps || sub.status === 'todo'
  const edit = () => {
    if (!editable) return
    setTitle(sub.title)
    setNote(sub.description)
    setManual(!!sub.startManually)
    setEditing(true)
  }
  const save = () => {
    if (title.trim()) void mag.updateTask(sub.id, { title: title.trim(), description: note.replace(/\s+/g, ' ').trim(), ...(steps && { startManually: manual }) })
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
      {steps ? (
        <span className="substatus"><SubtaskIcon status={sub.status} /></span>
      ) : (
        <button
          className="icon substatus"
          title={`${STATUS_LABELS[sub.status]}: click for ${STATUS_LABELS[nextStatus(sub.status)].toLowerCase()}`}
          aria-label={`${sub.key}: ${STATUS_LABELS[sub.status]}`}
          onClick={() => mag.setSubtaskStatus(sub.id, nextStatus(sub.status))}
        >
          <SubtaskIcon status={sub.status} />
        </button>
      )}
      <span className="key">{sub.key}</span>
      {editing ? (
        <form className="subedit" onSubmit={(e) => { e.preventDefault(); save() }} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Subtask title" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional, one line)" aria-label="Subtask note" />
          {steps && <label className="check small"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />start manually</label>}
          <button type="submit" className="primary">Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <>
          <div className="subtitle" onDoubleClick={edit}>
            <div className="subname">{sub.title}</div>
            {sub.description && <div className="muted small">{sub.description}</div>}
          </div>
          <span className="subextra">
            {steps && sub.startManually && <span className="pill" title="Waits for your Start when the previous step is done">start manually</span>}
            {steps && <PrBadges task={sub} />}
            {/* Sub-ticket of a tracker (T-10) goes here. */}
            {steps && <span className="subticket" />}
            {editable && <button className="link small" onClick={edit}>Edit</button>}
          </span>
        </>
      )}
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
          <button className="link" onClick={() => mag.open(r.worktree)}>worktree</button>
          {r.prUrl ? <button className="link" onClick={() => mag.open(r.prUrl!)}>{prLabel(r.prUrl)}</button> : <span className="muted">no PR</span>}
          {r.prState && <span className={`status ${r.prState === 'merged' ? 's-done' : r.prState === 'open' ? 's-in_progress' : ''}`}>{r.prState}</span>}
          {r.checkError && <span className="pill amber" title={r.checkError}>check failed: {r.checkError.slice(0, 60)}</span>}
        </div>
      ))}
    </div>
  )
}

function SessionList({ sessions, all, onShow }: { sessions: AgentSession[]; all: AgentSession[]; onShow: (sessionId: string) => void }) {
  const agents = useAgents()
  return (
    <div className="sessionlist">
      {sessions.map((s) => (
        <button key={s.id} className="sessionrow" onClick={() => onShow(s.id)} title="Show in the chat panel">
          <span className="no">#{all.indexOf(s) + 1}</span>
          <span>{s.role}</span>
          <span className="muted grow">{agentName(agents, s.agent)} · {s.activeModel ?? 'default'}</span>
          <span className={`status ${s.status === 'running' ? 's-in_progress' : ''}`}>{s.status}</span>
          <span className="muted small">${sessionCost(s).toFixed(2)}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Steps: per step its worktrees, branches, PRs and sessions, after the grooming sessions. A legacy task: its task
 * dir, repos and every session.
 */
function WorkTab({ task, groups, sessions, onShow }: { task: Task; groups: SessionGroup[] | null; sessions: AgentSession[]; onShow: (sessionId: string) => void }) {
  const work = task.work
  const anyPr = taskPrs(task, groups?.flatMap((g) => (g.step ? [g.step] : [])) ?? []).length > 0
  if (groups) {
    return (
      <>
        {anyPr && <div className="meta"><button className="link" onClick={() => mag.checkPrs()}>check PRs now</button></div>}
        {groups.map((g) => (
          <div key={g.label} className="workgroup">
            <h2>
              {g.step ? <><SubtaskIcon status={g.step.status} /> {g.step.key} · {g.step.title}</> : g.label}
              {g.step?.work && <button className="link small" onClick={() => mag.open(g.step!.work!.dir)}>open step folder</button>}
            </h2>
            {g.step && (g.step.work ? <RepoList work={g.step.work} /> : <p className="muted small">Not started yet.</p>)}
            {g.sessions.length > 0 && <SessionList sessions={g.sessions} all={sessions} onShow={onShow} />}
          </div>
        ))}
      </>
    )
  }
  return (
    <>
      {work ? (
        <>
          <div className="meta">
            <button className="link" onClick={() => mag.open(work.dir)}>open task folder</button>
            {anyPr && <button className="link" onClick={() => mag.checkPrs()}>check PRs now</button>}
          </div>
          <RepoList work={work} />
        </>
      ) : (
        <p className="muted">No developer has started on this task yet.</p>
      )}
      <h2>Sessions</h2>
      {sessions.length ? <SessionList sessions={sessions} all={sessions} onShow={onShow} /> : <p className="muted">No agent sessions yet.</p>}
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

const ROLE_LABELS: Record<string, string> = { chat: 'Project chat', groomer: 'Groomer', developer: 'Developer', architect: 'Architect', tracker: 'Tracker' }

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

const KINDS: [TrackerKind, string, string][] = [['jira', 'Jira', 'Project key'], ['linear', 'Linear', 'Team key']]

/** Tracker projects / teams tickets are imported from, each read through a T-13 integration (T-10). */
function TrackerSettings({ project, integrations }: { project: Project; integrations: Integration[] }) {
  const scopes = project.trackers ?? []
  const [integrationId, setIntegrationId] = useState('')
  const [kind, setKind] = useState<TrackerKind>('jira')
  const [scope, setScope] = useState('')
  const key = scopeKey(scope)
  const chosen = integrations.some((i) => i.id === integrationId) ? integrationId : (integrations[0]?.id ?? '')
  const taken = !!key && scopes.some((s) => s.scope.toUpperCase() === key)
  const save = (list: TrackerScope[]) => mag.updateProject(project.id, { trackers: list })
  const nameOf = (id: string) => integrations.find((i) => i.id === id)?.name ?? id
  return (
    <div className="field">
      Trackers
      {scopes.length > 0 && (
        <div className="trackerlist">
          {scopes.map((s, i) => {
            const warning = scopeWarning(project, s, integrations)
            return (
              <div key={`${s.kind}:${s.scope}:${i}`} className="trackerrow">
                <code>{s.scope}</code>
                <span>{KINDS.find(([k]) => k === s.kind)?.[1]}</span>
                <span className="muted small" title={s.integrationId}>via {nameOf(s.integrationId)}</span>
                {warning && <span className="pill amber">{warning}</span>}
                <button className="link" onClick={() => save(scopes.filter((_, j) => j !== i))}>remove</button>
              </div>
            )
          })}
        </div>
      )}
      {integrations.length ? (
        <form
          className="trackeradd"
          onSubmit={(e) => { e.preventDefault(); if (!key || taken || !chosen) return; void save([...scopes, { integrationId: chosen, kind, scope: key }]); setScope('') }}
        >
          <select value={chosen} onChange={(e) => setIntegrationId(e.target.value)} aria-label="Tracker integration">
            {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value as TrackerKind)} aria-label="Tracker kind">
            {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder={KINDS.find(([k]) => k === kind)![2]} aria-label="Project or team key" aria-invalid={!!scope.trim() && !key} />
          <button type="submit" disabled={!key || taken}>+ Add tracker</button>
          {taken && <span className="muted small">{key} is already added.</span>}
        </form>
      ) : (
        <span className="muted small">Run any Claude Code agent to detect integrations, then pick the Jira (Atlassian) or Linear one here.</span>
      )}
      <span className="muted small">
        Import a ticket from Tasks by its URL, or by its key when its prefix is a key here (ABC-12 for ABC). The tracker agent reads it through the
        integration: turn that integration on for Tracker in Integrations above (Ask or Auto). mag never writes to the tracker.
      </span>
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
      <label className="field">
        Auto-archive after (days)
        <input type="number" min={0} style={{ width: 100 }} defaultValue={project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS} onChange={(e) => { const n = Math.floor(Number(e.target.value)); if (e.target.value !== '' && n >= 0) update({ autoArchiveDays: n }) }} />
        <span className="muted small">Done and canceled tasks move to the Archive this many days after they finished; 0 turns it off.</span>
      </label>
      <AgentSettings project={project} />
      <IntegrationSettings project={project} integrations={integrations} />
      <TrackerSettings project={project} integrations={integrations} />
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
