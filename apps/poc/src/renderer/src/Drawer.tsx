import { useEffect, useMemo } from 'react'
import { setOf, type AgentSession } from '@mag/core'
import type { AppState } from '../../preload/api'
import { TaskArtifact, taskArtifactHead } from './ArtifactPane'
import type { ArtifactTarget } from './artifacts'
import { CanvasFrame, Chat, SessionModelChip } from './Chat'
import { DiffSetView, setContext } from './DiffSetView'
import { diagramsOf } from './DiffTab'
import type { Selection } from './WorkList'

const mag = window.mag

/**
 * An artifact at the right of a topic's screen (redesign-start-screen-big-composer.3, topics-a-tree-of-agent.3): it
 * opens when you click a canvas in the chat or an artifact in the list, ✕ (or Esc) closes it, ⧉ pops it out. A task's
 * diagram opens with its whole linked set (DiffSetView: levels, trail, links, a fact's files and hunks), as in its own
 * window; any other canvas alone; a work's card, its doc or a review as ArtifactPane draws them. The latest version
 * shows; an artifact deleted meanwhile closes the drawer.
 */
export function ArtifactDrawer({ open, state, onClose, onGone, onOpenKey, onSelect }: {
  open: ArtifactTarget
  state: AppState
  onClose: () => void
  /** The work or review shown was closed or deleted from its menu. */
  onGone: () => void
  onOpenKey: (key: string) => void
  onSelect: (s: Selection) => void
}) {
  const task = 'taskId' in open ? state.tasks.find((t) => t.id === open.taskId) : undefined
  const canvas = open.kind === 'canvas' ? state.canvases.find((c) => c.id === open.id) : undefined
  const agent = open.kind === 'agent' ? state.sessions.find((s) => s.id === open.sessionId) : undefined
  const gone = !task && !canvas && !agent
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])
  if (open.kind === 'canvas') return canvas ? <CanvasDrawer canvas={canvas} focus={open.focus} state={state} onClose={onClose} /> : null
  if (open.kind === 'agent') return agent ? <AgentDrawer session={agent} state={state} onClose={onClose} onOpenKey={onOpenKey} /> : null
  if (!task || !('taskId' in open)) return null
  const head = taskArtifactHead(open, task)
  return (
    <aside className={`drawer${open.kind === 'doc' ? '' : ' set'}`} aria-label={head.title}>
      <div className="drawerhead">
        <span className="title" title={head.title}>{head.title}</span>
        {head.window && <button className="iconbtn" title="Open in a separate window" aria-label="Pop out" onClick={head.window}>⧉</button>}
        <button className="iconbtn" title="Close (Esc)" aria-label="Close the drawer" onClick={onClose}>✕</button>
      </div>
      <div className="drawerbody">
        <TaskArtifact key={`${open.kind}:${task.id}`} target={open} task={task} state={state} onOpenKey={onOpenKey} onSelect={onSelect} onDeleted={onGone} />
      </div>
    </aside>
  )
}

/**
 * The chat of a work's agent (topic-screen-one-new-compact.2), opened from the topic's Agents: a log, Stop while it
 * runs. The user writes to the work's owner, who passes things on.
 */
function AgentDrawer({ session, state, onClose, onOpenKey }: { session: AgentSession; state: AppState; onClose: () => void; onOpenKey: (key: string) => void }) {
  const on = state.tasks.find((t) => t.id === (session.stepId ?? session.taskId))
  const title = [session.role ?? 'agent', on?.title].filter(Boolean).join(' · ')
  const project = state.projects.find((p) => p.id === session.projectId)
  return (
    <aside className="drawer" aria-label={`Agent: ${title}`}>
      <div className="drawerhead">
        <span className="title" title={on ? `${title} · ${on.key}` : title}>{title}</span>
        {project && <SessionModelChip project={project} session={session} tasks={state.tasks.filter((t) => t.projectId === session.projectId)} />}
        <span className="muted small">{session.status}</span>
        {session.status === 'running' && <button className="small" onClick={() => void mag.stop(session.id).catch((e: Error) => alert(e.message))}>Stop</button>}
        <button className="iconbtn" title="Close (Esc)" aria-label="Close the drawer" onClick={onClose}>✕</button>
      </div>
      <div className="drawerbody">
        <p className="muted small">An agent's chat is a log: write to the owner in the conversation, it passes things on.</p>
        <Chat session={session} sessions={state.sessions} canvases={state.canvases} onOpenTask={onOpenKey} readOnly />
      </div>
    </aside>
  )
}

function CanvasDrawer({ canvas, focus, state, onClose }: { canvas: AppState['canvases'][number]; focus?: string; state: AppState; onClose: () => void }) {
  const taskId = canvas.taskId
  // The task's diagrams: a diagram of them opens with its set (povnyi-diff-nabir-pov-iazanykh.2).
  const siblings = useMemo(() => (taskId ? diagramsOf(state.canvases.filter((c) => c.taskId === taskId)) : []), [state.canvases, taskId])
  const own = siblings.find((c) => c.id === canvas.id)
  if (own) {
    const set = setOf(own, siblings)
    return (
      <aside className="drawer set" aria-label={`Diagrams: ${canvas.title}`}>
        <div className="drawerhead">
          <span className="title">Diagrams · {set.length}</span>
          <button className="iconbtn" title="Open in a separate window" aria-label="Pop out" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: canvas.id })}>⧉</button>
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
        <CanvasFrame key={canvas.id + canvas.version} canvas={canvas} height="100%" focus={focus} />
      </div>
    </aside>
  )
}
