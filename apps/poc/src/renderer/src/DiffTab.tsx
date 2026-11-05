import { useState } from 'react'
import { diagramGroups, diagramSummary, prHeads, repoNames, reportLine, setOf, subtasksOf, type Project, type Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import { DIAGRAM_NAMES } from './diagrams/DiagramView'
import { Changes, DiffSetView, setContext, type DiagramCanvas } from './DiffSetView'
import { FactPanel } from './FactPanel'
import { ReportView } from './ReportView'
import { SubtaskIcon } from './Tasks'

const mag = window.mag

/** Diagram canvases among `canvases`, in the order they were drawn. */
export function diagramsOf(canvases: AppState['canvases']): DiagramCanvas[] {
  return canvases.filter((c): c is DiagramCanvas => c.kind === 'diagram' && !!c.diagram)
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

/** A step has a fact to show: an open PR, or the fact mag recorded at its review. */
const hasFact = (step: Task) => !!step.fact || Object.keys(prHeads(step.work)).length > 0

/**
 * The diagrams of a work by their place (T-55.3): Options side by side → Plan by step and repository, with plan ↔ fact
 * of the step's PRs (T-57.5) → the rest. Options fold once there is a plan. Click a diagram to open its whole set here
 * (DiffSetView), ⧉ in its own window.
 */
export function DiffTab({ task, tasks, project, diagrams }: { task: Task; tasks: Task[]; project: Project | undefined; diagrams: DiagramCanvas[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const repos = project?.repos ?? []
  const steps = subtasksOf(task.id, tasks)
  const groups = diagramGroups(diagrams, steps, repos)
  // Steps with diagrams, and steps with a fact but no diagram (everything they change is unplanned), in step order.
  const plan = steps.flatMap((step) => {
    const g = groups.plan.find((p) => p.step.id === step.id)
    return g ? [g] : hasFact(step) ? [{ step, repos: [] }] : []
  })
  const [optionsOpen, setOptionsOpen] = useState<boolean | null>(null)
  const showOptions = optionsOpen ?? !plan.length
  const open = diagrams.find((d) => d.id === openId)
  if (!diagrams.length && !plan.length) return <p className="muted">No diagrams yet. The groomer draws the change here: modules, scenarios, states, algorithms and data.</p>
  if (open) {
    // The whole set of the diagram in one window: its option, its step's plan or fact (povnyi-diff-nabir-pov-iazanykh.2).
    const set = setOf(open, diagrams)
    return <DiffSetView key={set[0].id} set={set} current={open.id} {...setContext(set, tasks)} onClose={() => setOpenId(null)} />
  }
  const from = (d: DiagramCanvas) => (d.taskId === task.id ? null : (tasks.find((t) => t.id === d.taskId)?.key ?? 'another task'))
  const repoName = (r: string | null) => (r === null ? 'Whole step' : (repoNames({ repos })[repos.indexOf(r)] ?? r))
  const grouped = groups.options.length > 0 || plan.length > 0
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
      {plan.length > 0 && (
        <section>
          <div className="diffhead">Plan</div>
          {plan.map((p) => (
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
              {hasFact(p.step) && <FactPanel step={p.step} diagramsKey={p.repos.flatMap((r) => r.diagrams.map((d) => `${d.id}@${d.version}`)).join(',')} />}
              {p.step.review?.report && (
                <details className="reportfold">
                  <summary>Agent review: {reportLine(p.step.review.report, 'step')}</summary>
                  <ReportView report={p.step.review.report} fact={p.step.fact} kind="step" onView={setOpenId} />
                </details>
              )}
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
