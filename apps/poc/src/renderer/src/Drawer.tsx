import { useEffect, useMemo } from 'react'
import { setOf } from '@mag/core'
import type { AppState } from '../../preload/api'
import { CanvasFrame } from './Chat'
import { DiffSetView, setContext } from './DiffSetView'
import { diagramsOf } from './DiffTab'

const mag = window.mag

/** The canvas open in a screen's drawer, and the node of a diagram to show. */
export interface DrawerCanvas {
  id: string
  focus?: string
}

/**
 * A canvas at the right of a work's or a discussion's screen (redesign-start-screen-big-composer.3): it opens when you
 * click a diagram, ✕ (or Esc) closes it, ⧉ pops it out. A task's diagram opens with its whole linked set
 * (DiffSetView: levels, trail, links, a fact's files and hunks), as in its own window; any other canvas alone. The
 * latest version shows; a canvas deleted meanwhile closes the drawer.
 */
export function DiagramDrawer({ open, state, onClose }: { open: DrawerCanvas; state: AppState; onClose: () => void }) {
  const canvas = state.canvases.find((c) => c.id === open.id)
  const taskId = canvas?.taskId
  // The task's diagrams: a diagram of them opens with its set (povnyi-diff-nabir-pov-iazanykh.2).
  const siblings = useMemo(() => (taskId ? diagramsOf(state.canvases.filter((c) => c.taskId === taskId)) : []), [state.canvases, taskId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (!canvas) onClose()
  }, [canvas, onClose])
  if (!canvas) return null
  const own = siblings.find((c) => c.id === canvas.id)
  if (own) {
    const set = setOf(own, siblings)
    return (
      <aside className="drawer set" aria-label={`Diagrams: ${canvas.title}`}>
        <div className="drawerhead">
          <span className="title">Diagrams · {set.length}</span>
          <button className="iconbtn" title="Close (Esc)" aria-label="Close the drawer" onClick={onClose}>✕</button>
        </div>
        <div className="drawerbody">
          <DiffSetView key={set[0].id} set={set} current={own.id} {...setContext(set, state.tasks)} />
        </div>
      </aside>
    )
  }
  return (
    <aside className="drawer" aria-label={`Canvas: ${canvas.title}`}>
      <div className="drawerhead">
        <span className="title" title={canvas.title}>{canvas.title}</span>
        <span className="muted small">v{canvas.version}</span>
        <button className="iconbtn" title="Open in a separate window" aria-label="Pop out" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: canvas.id })}>⧉</button>
        <button className="iconbtn" title="Close (Esc)" aria-label="Close the drawer" onClick={onClose}>✕</button>
      </div>
      <div className="drawerbody">
        <CanvasFrame key={canvas.id + canvas.version} canvas={canvas} height="100%" focus={open.focus} />
      </div>
    </aside>
  )
}
