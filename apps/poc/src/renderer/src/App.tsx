import { useEffect, useState } from 'react'
import {
  DEFAULT_TEMPLATES,
  PLAN_STATUSES,
  planBlockers,
  type Project,
  type Task,
  type TaskType,
} from '@mag/core'
import type { AppState } from '../../preload/api'
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
const TYPES: TaskType[] = ['dev', 'design', 'spike', 'research', 'story']
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
      <nav className="sidebar">
        <div className="brand">mag <span>PoC</span></div>
        <div className="label">Projects</div>
        {state.projects.map((p) => (
          <button key={p.id} className={`nav ${p.id === project?.id ? 'on' : ''}`} onClick={() => { setProjectId(p.id); setTaskId(null) }}>
            {p.name}
          </button>
        ))}
        <NewProject onCreate={(p) => { setProjectId(p.id); setTab('settings') }} />
        {!state.claudeBin && <div className="warn">Claude Code CLI not found. Set MAG_CLAUDE_BIN or install claude.</div>}
      </nav>

      {project ? (
        <div className="workspace">
        <main className="main">
          <header className="tabs">
            <button className={tab === 'needs' && !task ? 'on' : ''} onClick={() => { setTab('needs'); setTaskId(null) }}>
              Needs you {needsCount > 0 && <span className="badge">{needsCount}</span>}
            </button>
            <button className={tab === 'backlog' && !task ? 'on' : ''} onClick={() => { setTab('backlog'); setTaskId(null) }}>Backlog</button>
            <button className={tab === 'plan' && !task ? 'on' : ''} onClick={() => { setTab('plan'); setTaskId(null) }}>Plan</button>
            <button className={tab === 'architecture' && !task ? 'on' : ''} onClick={() => { setTab('architecture'); setTaskId(null) }}>Architecture</button>
            <button className={tab === 'settings' && !task ? 'on' : ''} onClick={() => { setTab('settings'); setTaskId(null) }}>Settings</button>
            <div className="grow" />
            <ThemeSwitch mode={theme} onChange={setTheme} />
            {!chatOpen && <button onClick={() => toggleChat(true)}>Chat {chatBusy && <span className="dot inline" />}</button>}
          </header>
          {task ? (
            <TaskView task={task} tasks={tasks} state={state} onBack={() => setTaskId(null)} onOpen={setTaskId} onOpenKey={openKey} />
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
        {chatOpen && <ProjectChat key={project.id} projectId={project.id} state={state} onOpenTask={openKey} onClose={() => toggleChat(false)} />}
        </div>
      ) : (
        <main className="main empty">Create a project to start.</main>
      )}
    </div>
  )
}

function needsYou(t: Task) {
  return !!t.needsInput || t.status === 'groomed' || (t.status === 'in_review' && !!t.work?.prUrl)
}

function needsLabel(t: Task): [string, string, string] {
  if (t.needsInput) return ['amber', 'Input needed', t.needsInput]
  if (t.status === 'in_review') return ['green', 'Ready to merge', 'PR is open. Merge it yourself; comments go back to the agent.']
  return ['violet', 'Review grooming', 'Groomed, ready to add to the plan']
}

function NewProject({ onCreate }: { onCreate: (p: Project) => void }) {
  const [name, setName] = useState('')
  return (
    <form className="newproject" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; onCreate(await mag.createProject(name.trim())); setName('') }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="+ New project" aria-label="New project name" />
    </form>
  )
}

function NeedsYou({ tasks, state, onOpen }: { tasks: Task[]; state: AppState; onOpen: (id: string) => void }) {
  const items = tasks.filter(needsYou)
  const running = state.sessions.filter((s) => s.status === 'running' && tasks.some((t) => t.id === s.taskId))
  const devs = running.filter((s) => s.role === 'developer').length
  const pool = state.projects.find((p) => p.id === tasks[0]?.projectId)?.devPoolSize ?? 1
  return (
    <section className="page">
      <h1>Needs you</h1>
      <p className="muted">
        {items.length ? `${items.length} item(s) waiting on you` : 'Nothing is waiting on you.'} · developers {devs}/{pool} busy · {running.length} agent(s) working{' '}
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

const roots = (tasks: Task[], inPlan: boolean) =>
  tasks.filter((t) => !t.parentId && PLAN_STATUSES.includes(t.status) === inPlan)

function PlanView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  return (
    <section className="page">
      <h1>Plan</h1>
      <TaskTree roots={roots(tasks, true)} all={tasks} onOpen={onOpen} empty="Nothing planned yet. Groom tasks from the backlog and add them here." />
    </section>
  )
}

function BacklogView({ project, tasks, onOpen }: { project: Project; tasks: Task[]; onOpen: (id: string) => void }) {
  return (
    <section className="page">
      <h1>Backlog</h1>
      <NewTask projectId={project.id} />
      <TaskTree roots={roots(tasks, false)} all={tasks} onOpen={onOpen} empty="Backlog is empty." />
    </section>
  )
}

function TaskTree({ roots, all, onOpen, empty }: { roots: Task[]; all: Task[]; onOpen: (id: string) => void; empty: string }) {
  if (!roots.length) return <p className="muted">{empty}</p>
  const row = (t: Task, depth: number): React.ReactNode => (
    <div key={t.id}>
      <button className="row" style={{ paddingLeft: 12 + depth * 20 }} onClick={() => onOpen(t.id)}>
        <span className="key">{t.key}</span>
        <span className="title grow">{t.title}</span>
        {t.needsInput && <span className="dot" title={t.needsInput} />}
        <span className="type">{t.type}</span>
        <span className={`status s-${t.status}`}>{t.status.replace('_', ' ')}</span>
        <span className="deps">{t.dependsOn === null ? 'deps ?' : t.dependsOn.length ? `after ${t.dependsOn.map((d) => all.find((x) => x.id === d)?.key ?? '?').join(', ')}` : 'no deps'}</span>
      </button>
      {all.filter((c) => c.parentId === t.id).map((c) => row(c, depth + 1))}
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

function TaskView({ task, tasks, state, onBack, onOpen, onOpenKey }: { task: Task; tasks: Task[]; state: AppState; onBack: () => void; onOpen: (id: string) => void; onOpenKey: (key: string) => void }) {
  const sessions = state.sessions.filter((s) => s.taskId === task.id)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const session = sessions.find((s) => s.id === sessionId) ?? sessions[sessions.length - 1] ?? null
  const doc = state.docs[task.id]
  const canvases = state.canvases.filter((c) => c.taskId === task.id)
  const [canvasId, setCanvasId] = useState<string | null>(null)
  const canvas = canvases.find((c) => c.id === canvasId)
  const blockers = planBlockers(task)
  const parent = tasks.find((t) => t.id === task.parentId)
  const children = tasks.filter((t) => t.parentId === task.id)
  const anyRunning = sessions.some((s) => s.status === 'running')
  const canGroom = !anyRunning && !PLAN_STATUSES.includes(task.status)
  const canDevelop = !anyRunning && (task.status === 'planned' || task.status === 'in_progress') && task.type !== 'story'

  return (
    <section className="taskview">
      <div className="taskhead">
        <button className="link" onClick={onBack}>← Back</button>
        <span className="key">{task.key}</span>
        <h1>{task.title}</h1>
        <span className="type">{task.type}</span>
        <span className={`status s-${task.status}`}>{task.status.replace('_', ' ')}</span>
        <div className="grow" />
        {canGroom && <button onClick={() => mag.groom(task.id)}>{task.status === 'backlog' ? 'Groom' : 'Re-groom'}</button>}
        {canDevelop && (
          <button onClick={() => mag.develop(task.id)} title="Normally the developer pool picks ready tasks by itself">
            {task.status === 'planned' ? 'Start developer now' : 'Restart developer'}
          </button>
        )}
        {!PLAN_STATUSES.includes(task.status) && (
          <button className="primary" disabled={blockers.length > 0} title={blockers.join(', ')} onClick={() => mag.addToPlan(task.id)}>
            Add to plan
          </button>
        )}
      </div>
      {task.needsInput && <div className="banner">Agent needs you: {task.needsInput}</div>}
      {!PLAN_STATUSES.includes(task.status) && blockers.length > 0 && <div className="muted small">Before planning: {blockers.join(' · ')}</div>}

      <div className="meta">
        {parent && <span>Part of <button className="link" onClick={() => onOpen(parent.id)}>{parent.key} {parent.title}</button></span>}
        {children.length > 0 && <span>Subtasks: {children.map((c) => <button key={c.id} className="link" onClick={() => onOpen(c.id)}>{c.key}</button>)}</span>}
      </div>
      <Deps task={task} tasks={tasks} />
      {task.work && (
        <div className="meta">
          <span>Branch <code>{task.work.branch}</code></span>
          <button className="link" onClick={() => mag.open(task.work!.worktree)}>open worktree</button>
          {task.work.prUrl && <button className="link" onClick={() => mag.open(task.work!.prUrl!)}>open PR ↗</button>}
          {task.work.prUrl && <button className="link" onClick={() => mag.checkPrs()}>check now</button>}
          {task.work.checkError && <span className="pill amber" title={task.work.checkError}>PR check failed: {task.work.checkError.slice(0, 80)}</span>}
        </div>
      )}

      <div className="split">
        <div className="doc">
          <div className="label">Task document {task.description && <span className="muted">· brief: {task.description}</span>}</div>
          {canvases.length > 0 && (
            <div className="chips canvaschips">
              {canvases.map((c) => (
                <button key={c.id} className={c.id === canvasId ? 'on' : ''} onClick={() => setCanvasId(c.id === canvasId ? null : c.id)}>▣ {c.title}</button>
              ))}
            </div>
          )}
          {canvas && <CanvasCard key={canvas.id + canvas.version} canvas={canvas} />}
          {doc ? <Markdown className="md docmd" text={doc} onOpenTask={onOpenKey} /> : <p className="muted">No document yet. Groom the task and the agent will write it.</p>}
        </div>
        <div className="chat">
          <div className="label">
            Agent
            {sessions.length > 1 && (
              <select value={session?.id} onChange={(e) => setSessionId(e.target.value)} aria-label="Session">
                {sessions.map((s, i) => <option key={s.id} value={s.id}>#{i + 1} {s.role}</option>)}
              </select>
            )}
          </div>
          {session ? <Chat session={session} onOpenTask={onOpenKey} /> : <p className="muted">No agent has worked on this task yet.</p>}
        </div>
      </div>
    </section>
  )
}

function Deps({ task, tasks }: { task: Task; tasks: Task[] }) {
  const others = tasks.filter((t) => t.id !== task.id && t.parentId === task.parentId)
  const set = (dependsOn: string[] | null) => mag.updateTask(task.id, { dependsOn })
  return (
    <div className="deps-edit">
      <span className="label">Depends on</span>
      <label><input type="radio" checked={task.dependsOn === null} onChange={() => set(null)} /> not set</label>
      <label><input type="radio" checked={task.dependsOn?.length === 0} onChange={() => set([])} /> nothing</label>
      {others.map((o) => (
        <label key={o.id}>
          <input
            type="checkbox"
            checked={!!task.dependsOn?.includes(o.id)}
            onChange={(e) => set(e.target.checked ? [...(task.dependsOn ?? []), o.id] : (task.dependsOn ?? []).filter((d) => d !== o.id))}
          />{' '}
          {o.key} {o.title}
        </label>
      ))}
    </div>
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
        <label className="field">Developer agents in parallel<input type="number" min={0} max={8} defaultValue={project.devPoolSize} onChange={(e) => update({ devPoolSize: Math.max(0, Number(e.target.value) || 0) })} /></label>
        <label className="field">Base branch<input defaultValue={project.baseBranch} onChange={(e) => update({ baseBranch: e.target.value.trim() || 'main' })} /></label>
      </div>
      <label className="check">
        <input type="checkbox" checked={project.enforceArchitecture} onChange={(e) => update({ enforceArchitecture: e.target.checked })} />
        Enforce core architecture (lib / clients / services) for agents
      </label>
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
