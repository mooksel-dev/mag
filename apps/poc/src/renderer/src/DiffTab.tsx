import { useState } from 'react'
import { diagramGroups, diagramSummary, repoNames, subtasksOf, type DiffCount, type Project, type Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import { DIAGRAM_NAMES, DiagramView } from './diagrams/DiagramView'
import { SubtaskIcon } from './Tasks'

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

/** Rows of diagrams; `from` names the task that owns a diagram the doc links. */
function Rows({ diagrams, onOpen, from }: { diagrams: DiagramCanvas[]; onOpen: (id: string) => void; from: (d: DiagramCanvas) => string | null }) {
  return (
    <div className="difflistrows">
      {diagrams.map((d) => (
        <div key={d.id} role="button" tabIndex={0} className="diffrow" onClick={() => onOpen(d.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(d.id)}>
          <span className="type">{DIAGRAM_NAMES[d.diagram.type]}</span>
          <span className="title">{d.title}</span>
          {from(d) && <span className="muted small">from {from(d)}</span>}
          <Changes count={diagramSummary(d.diagram)} />
          <span className="muted small">v{d.version}</span>
          <OpenWindow id={d.id} />
        </div>
      ))}
    </div>
  )
}

/**
 * The diagrams of a work by their place (T-55.3): Options side by side → Plan by step and repository → the rest.
 * Options fold once there is a plan. Click a diagram to open it here, ⧉ in its own window.
 */
export function DiffTab({ task, tasks, project, diagrams }: { task: Task; tasks: Task[]; project: Project | undefined; diagrams: DiagramCanvas[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const repos = project?.repos ?? []
  const groups = diagramGroups(diagrams, subtasksOf(task.id, tasks), repos)
  const [optionsOpen, setOptionsOpen] = useState<boolean | null>(null)
  const showOptions = optionsOpen ?? !groups.plan.length
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
  const from = (d: DiagramCanvas) => (d.taskId === task.id ? null : (tasks.find((t) => t.id === d.taskId)?.key ?? 'another task'))
  const repoName = (r: string | null) => (r === null ? 'Whole step' : (repoNames({ repos })[repos.indexOf(r)] ?? r))
  const grouped = groups.options.length > 0 || groups.plan.length > 0
  if (!grouped) return <Rows diagrams={groups.other} onOpen={setOpenId} from={from} />
  return (
    <div className="diffgroups">
      {groups.options.length > 0 && (
        <section>
          <button className="link diffhead" onClick={() => setOptionsOpen(!showOptions)}>
            {showOptions ? '▾' : '▸'} Options · {groups.options.length}
          </button>
          {showOptions && (
            <div className="diffoptions">
              {groups.options.map((o) => (
                <div key={o.option} className="diffoption">
                  <div className="diffsub">Option {o.option}</div>
                  <Rows diagrams={o.diagrams} onOpen={setOpenId} from={from} />
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {groups.plan.length > 0 && (
        <section>
          <div className="diffhead">Plan</div>
          {groups.plan.map((p) => (
            <div key={p.step.id} className="diffstep">
              <div className="diffsub">
                <SubtaskIcon status={p.step.status} /> {p.step.key} · {p.step.title}
              </div>
              {p.repos.map((r) => (
                <div key={r.repo ?? ''} className="diffrepo">
                  <div className="muted small">{repoName(r.repo)}</div>
                  <Rows diagrams={r.diagrams} onOpen={setOpenId} from={from} />
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      {groups.other.length > 0 && (
        <section>
          <div className="diffhead">Not placed</div>
          <Rows diagrams={groups.other} onOpen={setOpenId} from={from} />
        </section>
      )}
    </div>
  )
}
