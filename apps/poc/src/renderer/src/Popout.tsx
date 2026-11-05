import { useEffect, useMemo, useState } from 'react'
import { setOf } from '@mag/core'
import type { AppState, WindowTarget } from '../../preload/api'
import { Architecture } from './Architecture'
import { CanvasFrame, Markdown } from './Chat'
import { diagramsOf } from './DiffTab'
import { DiffSetView, setContext } from './DiffSetView'
import { useRenderReviewExport } from './ReviewExport'
import { ReviewWindow } from './ReviewWindow'
import { useTheme } from './useTheme'

const mag = window.mag

/** The target of a pop-out window from its location hash (`#popout?kind=…&id=…`), or null in the main window. */
export function popoutTarget(hash: string): WindowTarget | null {
  const m = /^#popout\?(.*)$/.exec(hash)
  if (!m) return null
  const q = new URLSearchParams(m[1])
  const id = q.get('id')
  if (!id) return null
  switch (q.get('kind')) {
    case 'architecture': return { kind: 'architecture', projectId: id }
    case 'canvas': return { kind: 'canvas', canvasId: id }
    case 'doc': return { kind: 'doc', taskId: id }
    case 'review': return { kind: 'review', taskId: id }
    default: return null
  }
}

/** One artifact in its own window: no rail, tabs or chat. It follows the live state like the main window. */
export function Popout({ target }: { target: WindowTarget }) {
  const [state, setState] = useState<AppState | null>(null)
  useTheme()
  useRenderReviewExport(state)

  useEffect(() => {
    mag.getState().then(setState)
    return mag.onState(setState)
  }, [])

  if (!state) return null
  return (
    <div className="popout">
      {target.kind === 'architecture' && <ArchitectureWindow state={state} projectId={target.projectId} />}
      {target.kind === 'canvas' && <CanvasWindow state={state} canvasId={target.canvasId} />}
      {target.kind === 'doc' && <DocWindow state={state} taskId={target.taskId} />}
      {target.kind === 'review' && <ReviewWindow state={state} taskId={target.taskId} />}
    </div>
  )
}

function useTitle(title: string) {
  useEffect(() => {
    document.title = title
  }, [title])
}

function Missing() {
  useTitle('Not available')
  return <p className="muted page">Not available. It may have been deleted.</p>
}

function ArchitectureWindow({ state, projectId }: { state: AppState; projectId: string }) {
  const project = state.projects.find((p) => p.id === projectId)
  useTitle(project ? `Architecture · ${project.name}` : 'Architecture')
  if (!project) return <Missing />
  return <Architecture key={project.id} project={project} inWindow />
}

function CanvasWindow({ state, canvasId }: { state: AppState; canvasId: string }) {
  // Metadata from the state, not from the opener: a new version shows up by itself.
  const canvas = state.canvases.find((c) => c.id === canvasId)
  // The task's diagrams: a diagram opens with its whole set (povnyi-diff-nabir-pov-iazanykh.2).
  const taskId = canvas?.taskId
  const siblings = useMemo(() => (taskId ? diagramsOf(state.canvases.filter((c) => c.taskId === taskId)) : []), [state.canvases, taskId])
  useTitle(canvas ? `${canvas.title} · v${canvas.version}` : 'Canvas')
  if (!canvas) return <Missing />
  const own = siblings.find((c) => c.id === canvas.id)
  if (own) {
    const set = setOf(own, siblings)
    return (
      <div className="popcanvas popset">
        <DiffSetView key={set[0].id} set={set} current={own.id} {...setContext(set, state.tasks)} />
      </div>
    )
  }
  return (
    <div className="popcanvas">
      <div className="canvashead">
        <span className="title">{canvas.title}</span>
        <span className="muted small">v{canvas.version}</span>
      </div>
      <CanvasFrame canvas={canvas} height="100%" />
    </div>
  )
}

function DocWindow({ state, taskId }: { state: AppState; taskId: string }) {
  const task = state.tasks.find((t) => t.id === taskId)
  const projectId = task?.projectId
  const canvases = useMemo(() => state.canvases.filter((c) => c.projectId === projectId), [state.canvases, projectId])
  useTitle(task ? `${task.key} ${task.title}` : 'Document')
  if (!task) return <Missing />
  const doc = state.docs[task.id]
  const openKey = (key: string) => {
    const t = state.tasks.find((x) => x.projectId === task.projectId && x.key === key)
    if (t) void mag.openTask(t.id)
  }
  return (
    <div className="page popdoc">
      <div className="taskrow">
        <span className="key">{task.key}</span>
        <span className="title">{task.title}</span>
        <span className={`status s-${task.status}`}>{task.status.replace('_', ' ')}</span>
      </div>
      {doc ? <Markdown className="md docmd" text={doc} canvases={canvases} onOpenTask={openKey} /> : <p className="muted">No document yet.</p>}
    </div>
  )
}
