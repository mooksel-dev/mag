import { useEffect, useState } from 'react'
import { projectInbox, projectColor, projectState, type Project } from '@mag/core'
import type { AppState, PickerMode } from '../../preload/api'
import { Logo } from './Logo'
import { useTheme } from './useTheme'

const mag = window.mag

/** The square of the project's color next to its name. */
export function ProjectSquare({ project }: { project: Project }) {
  return <span className="psq" style={{ background: projectColor(project) }} aria-hidden />
}

function stateText(project: Project, state: AppState): string {
  const s = projectState(project.id, state.tasks, state.sessions)
  if (s === 'waiting') return `${projectInbox(project.id, state.tasks.filter((t) => t.projectId === project.id), state.sessions).length} waiting on you`
  return s === 'in_review' ? 'in review' : 'idle'
}

/** One project in the picker or on Welcome: color, name, state, and whether it is this window or open elsewhere. */
function ProjectRow({ project, state, current, active, onPick, onHover }: { project: Project; state: AppState; current?: boolean; active: boolean; onPick: () => void; onHover: () => void }) {
  const waiting = projectState(project.id, state.tasks, state.sessions) === 'waiting'
  return (
    <button role="option" aria-selected={active} className={`prow ${active ? 'on' : ''}`} onClick={onPick} onMouseEnter={onHover}>
      <ProjectSquare project={project} />
      <span className="pname">{project.name}</span>
      {current ? <span className="ptag">this window</span> : state.openProjects.includes(project.id) && <span className="ptag">open</span>}
      <span className={`pstate ${waiting ? 'waiting' : ''}`}>{stateText(project, state)}</span>
    </button>
  )
}

/** Creates a project and opens it in its own window. */
function NewProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  return (
    <form
      className="pnew"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!name.trim()) return
        const p = await mag.createProject(name.trim())
        await mag.openProject(p.id)
        onDone()
      }}
    >
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} placeholder="New project name" aria-label="New project name" />
      <button type="submit" className="primary">Create</button>
    </form>
  )
}

/** Searchable project list; Enter or a click opens the project (or focuses its window). */
function ProjectList({ state, currentId, mode, onClose }: { state: AppState; currentId: string | null; mode: PickerMode; onClose?: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [creating, setCreating] = useState(mode === 'new')
  useEffect(() => setCreating(mode === 'new'), [mode])
  const q = query.trim().toLowerCase()
  const list = state.projects.filter((p) => p.name.toLowerCase().includes(q))
  const pick = (p: Project | undefined) => {
    if (!p) return
    if (p.id !== currentId) void mag.openProject(p.id)
    onClose?.()
  }
  if (creating) return <NewProjectForm onDone={() => (onClose ? onClose() : setCreating(false))} />
  return (
    <>
      <input
        className="psearch"
        autoFocus
        value={query}
        placeholder="Search projects"
        aria-label="Search projects"
        onChange={(e) => { setQuery(e.target.value); setActive(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, list.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') pick(list[active])
          else if (e.key === 'Escape') onClose?.()
        }}
      />
      <div className="plist" role="listbox" aria-label="Projects">
        {list.map((p, i) => (
          <ProjectRow key={p.id} project={p} state={state} current={p.id === currentId} active={i === active} onPick={() => pick(p)} onHover={() => setActive(i)} />
        ))}
        {!list.length && <p className="muted small pempty">{state.projects.length ? 'No project matches.' : 'No projects yet.'}</p>}
      </div>
      <button className="pfoot" onClick={() => setCreating(true)}>+ New project…</button>
    </>
  )
}

/** Popover under the project name in the header. */
export function ProjectPicker({ state, currentId, mode, onClose }: { state: AppState; currentId: string | null; mode: PickerMode; onClose: () => void }) {
  return (
    <>
      <div className="menuscrim" onClick={onClose} />
      <div className="picker" role="dialog" aria-label="Open project">
        <ProjectList state={state} currentId={currentId} mode={mode} onClose={onClose} />
      </div>
    </>
  )
}

/** The window shown when no project is open. */
export function Welcome() {
  const [state, setState] = useState<AppState | null>(null)
  const [mode, setMode] = useState<PickerMode>('open')
  useTheme()
  useEffect(() => {
    document.title = 'mag'
    mag.getState().then(setState)
    return mag.onState(setState)
  }, [])
  useEffect(() => mag.onOpenPicker(setMode), [])
  if (!state) return null
  return (
    <div className="welcome">
      <div className="dragbar" />
      <div className="wbody">
        <h1><Logo size={30} />mag</h1>
        <p className="muted">Open a workspace or a project, or start a new one.</p>
        {state.workspaces.length > 0 && (
          <div className="wspaces" aria-label="Workspaces">
            {state.workspaces.map((w) => <button key={w.id} onClick={() => void mag.openWorkspace(w.id)}>{w.name}</button>)}
          </div>
        )}
        <div className="wlist">
          <ProjectList key={mode} state={state} currentId={null} mode={mode} onClose={mode === 'new' ? () => setMode('open') : undefined} />
        </div>
      </div>
    </div>
  )
}
