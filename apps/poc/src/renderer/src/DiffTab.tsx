import { useState } from 'react'
import { diagramSummary, type DiffCount } from '@mag/core'
import type { AppState } from '../../preload/api'
import { DIAGRAM_NAMES, DiagramView } from './diagrams/DiagramView'

const mag = window.mag

type DiagramCanvas = AppState['canvases'][number] & { diagram: NonNullable<AppState['canvases'][number]['diagram']> }

/** Diagram canvases among `canvases`, in the order they were drawn. */
export function diagramsOf(canvases: AppState['canvases']): DiagramCanvas[] {
  return canvases.filter((c): c is DiagramCanvas => c.kind === 'diagram' && !!c.diagram)
}

function Changes({ count }: { count: DiffCount }) {
  if (!count.add && !count.mod && !count.del && !count.move) return <span className="muted small">no changes</span>
  return (
    <span className="diffcount">
      <span className="d-add">+{count.add}</span> <span className="d-mod">~{count.mod}</span> <span className="d-del">−{count.del}</span>
      {count.move > 0 && <> <span className="d-move">↷{count.move}</span></>}
    </span>
  )
}

const OpenWindow = ({ id }: { id: string }) => (
  <button className="link" title="Open in a separate window" onClick={(e) => (e.stopPropagation(), mag.openWindow({ kind: 'canvas', canvasId: id }))}>
    ⧉
  </button>
)

/** The task's diagrams of its change; click one to open it here, ⧉ in its own window. */
export function DiffTab({ diagrams }: { diagrams: DiagramCanvas[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const open = diagrams.find((d) => d.id === openId)
  if (!diagrams.length) return <p className="muted">No diagrams yet. The groomer draws the change here: modules, scenarios, states, algorithms and data.</p>
  if (open)
    return (
      <div className="diffopen">
        <div className="canvashead">
          <button className="link" onClick={() => setOpenId(null)}>‹ All diagrams</button>
          <span className="muted small">{DIAGRAM_NAMES[open.diagram.type]}</span>
          <span className="title">{open.title}</span>
          <Changes count={diagramSummary(open.diagram)} />
          <div className="grow" />
          <span className="muted small">v{open.version}</span>
          <OpenWindow id={open.id} />
        </div>
        <DiagramView key={open.id + open.version} diagram={open.diagram} siblings={diagrams} />
      </div>
    )
  return (
    <div className="difflistrows">
      {diagrams.map((d) => (
        <div key={d.id} role="button" tabIndex={0} className="diffrow" onClick={() => setOpenId(d.id)} onKeyDown={(e) => e.key === 'Enter' && setOpenId(d.id)}>
          <span className="type">{DIAGRAM_NAMES[d.diagram.type]}</span>
          <span className="title">{d.title}</span>
          <Changes count={diagramSummary(d.diagram)} />
          <span className="muted small">v{d.version}</span>
          <OpenWindow id={d.id} />
        </div>
      ))}
    </div>
  )
}
