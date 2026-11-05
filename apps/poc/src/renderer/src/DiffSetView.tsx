import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  diagramSummary,
  findNode,
  findingPlace,
  linksAt,
  nodeFiles,
  parseFlowRef,
  setLevels,
  setRoot,
  setTrail,
  type Diagram,
  type DiffCount,
  type LinkKind,
  type ReviewFinding,
  type SetLevelKey,
  type Task,
  type TrailStep,
  shownResult,
} from '@mag/core'
import type { FileChange } from '@mag/diff/types'
import type { AppState, FactView } from '../../preload/api'
import { FileLink, useHunks, type Hunks } from './FactPanel'
import { DIAGRAM_NAMES, DiagramView } from './diagrams/DiagramView'
import { fileKey } from './factView'

const mag = window.mag

/** A diagram canvas of the state, with its data. */
export type DiagramCanvas = AppState['canvases'][number] & { diagram: NonNullable<AppState['canvases'][number]['diagram']> }

/** Changes of a diagram by mark, or "no changes". */
export function Changes({ count }: { count: DiffCount }) {
  if (!count.add && !count.mod && !count.del && !count.move) return <span className="muted small">no changes</span>
  return (
    <span className="diffcount">
      <span className="d-add">+{count.add}</span> <span className="d-mod">~{count.mod}</span> <span className="d-del">−{count.del}</span>
      {count.move > 0 && <> <span className="d-move">↷{count.move}</span></>}
    </span>
  )
}

export const LEVEL_NAMES: Record<SetLevelKey, string> = { system: 'System', modules: 'Modules', data: 'Data', scenarios: 'Scenarios', logic: 'Logic of methods' }
const LINK_NAMES: Record<LinkKind, string> = { detail: 'inside', data: 'data', scenario: 'scenario', logic: 'logic' }

/** The name of a node of a diagram: a module, entity, participant, state or step; its id when the diagram has none. */
export function nodeLabel(d: Diagram, id: string): string {
  switch (d.type) {
    case 'component': return findNode(d.modules, id)?.name ?? id
    case 'data': return d.entities.find((e) => e.id === id)?.name ?? id
    case 'sequence': return d.participants.find((p) => p.id === id)?.label ?? id
    case 'state': return d.states.find((s) => s.id === id)?.label ?? id
    case 'flowchart': return d.nodes.find((n) => n.id === id)?.label ?? id
  }
}

/** Where a link starts, in words: the module, `module · method`, `module → module`. */
function fromLabel(d: Diagram, from: string): string {
  const use = from.split(' -> ')
  if (use.length === 2) return `${nodeLabel(d, use[0])} → ${nodeLabel(d, use[1])}`
  const [node, method] = from.split('#')
  return method ? `${nodeLabel(d, node)} · ${method}` : nodeLabel(d, node)
}

/** The step (or review) whose fact a set is, and the findings of its review; nothing for an option or a plan. */
export function setContext(set: DiagramCanvas[], tasks: Task[]): { step?: Task; findings?: ReviewFinding[] } {
  const c = set[0]
  if (c?.role !== 'fact') return {}
  const step = tasks.find((t) => t.id === (c.stepId ?? c.taskId))
  return { step, findings: shownResult(step?.prReview)?.findings ?? step?.review?.findings }
}

/** The FactView of a fact set's step, loaded once the set opens. */
function useFact(step: Task | undefined, key: string): FactView | null {
  const [view, setView] = useState<FactView | null>(null)
  useEffect(() => {
    if (!step) return
    let gone = false
    mag.stepFact(step.id).then((v) => !gone && setView(v), () => !gone && setView(null))
    return () => void (gone = true)
  }, [step?.id, key])
  return view
}

const fileOf = (files: FileChange[], p: string) => files.find((f) => f.path === p || `${f.repo}:${f.path}` === p || f.oldPath === p)

/**
 * One window over a set of diagrams (povnyi-diff-nabir-pov-iazanykh.2, Decision 6): on the left its levels (system →
 * modules → data → scenarios → logic of methods) with their changes, in the middle the diagram open, breadcrumbs from
 * the root above it; a node with links opens the diagram (and node) they lead to. On the right the node selected: its
 * links, and on a fact set its files with their hunks and the review's findings. The same window in a step's Diff
 * tab (plan, fact), on a review's page, for options and in its own window.
 */
export function DiffSetView({ set, current, step, findings = [], onClose, inline, onNode }: {
  set: DiagramCanvas[]
  /** The diagram to open first; the root by default. */
  current?: string
  /** The step (or review) whose fact the set is: its files, hunks and findings. */
  step?: Task
  findings?: ReviewFinding[]
  /** Back to where the window opened from. */
  onClose?: () => void
  /**
   * Drawn inline on the review window's page (review-v2-part-2-v1-2.2): no diagram opens a separate window; links go on
   * within the set.
   */
  inline?: boolean
  /** Told the node selected on the diagram open (null: none), e.g. to expand its hunks in place. */
  onNode?: (node: string | null, diagram: DiagramCanvas) => void
}) {
  const start = current ?? setRoot(set)?.id ?? set[0]?.id
  const [trail, setTrailState] = useState<TrailStep[]>(() => (start ? setTrail(set, start) : []))
  const [node, setNode] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | undefined>(undefined)
  const levels = useMemo(() => setLevels(set), [set])
  const open = set.find((c) => c.id === trail.at(-1)?.id) ?? set.find((c) => c.id === start)
  const view = useFact(step, set.map((d) => `${d.id}@${d.version}`).join(','))
  const hunks = useHunks(step?.id ?? '', view)

  // Opened from outside on another diagram (a pop-out window's canvas, a click in the list).
  useEffect(() => {
    if (current) go(setTrail(set, current))
  }, [current])

  const go = (t: TrailStep[], at?: string) => {
    setTrailState(t)
    setNode(at ?? null)
    setFocus(at)
    const to = set.find((c) => c.id === t.at(-1)?.id)
    if (to) onNode?.(at ?? null, to)
  }
  const select = (n: string | null) => {
    setNode(n)
    if (open) onNode?.(n, open)
  }
  /** Follows a link from the open diagram: the trail goes on from here, or back to the target when it is on it. */
  const follow = (to: string, at: string | undefined, via: string) => {
    const i = trail.findIndex((s) => s.id === to)
    go(i >= 0 ? trail.slice(0, i + 1) : [...trail, { id: to, via }], at)
  }
  const onFlow = (module: string, method: string) => {
    const f = set.find((c) => c.diagram.type === 'flowchart' && c.diagram.of && parseFlowRef(c.diagram.of)?.module === module && parseFlowRef(c.diagram.of)?.method === method)
    if (f) follow(f.id, undefined, `${module}#${method}`)
  }

  if (!open) return <p className="muted">No diagrams in this set.</p>
  const byId = (id: string) => set.find((c) => c.id === id)
  return (
    <div className="diffset">
      <div className="canvashead">
        {onClose && <button className="link" onClick={onClose}>‹ All diagrams</button>}
        <nav className="setcrumbs">
          {trail.map((s, i) => {
            const c = byId(s.id)
            const prev = i > 0 ? byId(trail[i - 1].id) : undefined
            return (
              <Fragment key={`${s.id}${i}`}>
                {i > 0 && <span className="muted">›</span>}
                {s.via && prev && <span className="muted small">{fromLabel(prev.diagram, s.via)}:</span>}
                <button className="link" disabled={i === trail.length - 1} onClick={() => go(trail.slice(0, i + 1))}>{c?.title ?? s.id}</button>
              </Fragment>
            )
          })}
        </nav>
        <div className="grow" />
        <span className="muted small">{DIAGRAM_NAMES[open.diagram.type]}</span>
        <Changes count={diagramSummary(open.diagram)} />
        <span className="muted small">v{open.version}</span>
        {!inline && <button className="link" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: open.id })}>⧉</button>}
      </div>
      <div className="setbody">
        <nav className="setlevels">
          {levels.map((l) => (
            <div key={l.level}>
              <div className="setlevel">{LEVEL_NAMES[l.level]}</div>
              {l.diagrams.map(({ canvas, count }) => (
                <button key={canvas.id} className={`setitem${canvas.id === open.id ? ' on' : ''}`} title={canvas.title} onClick={() => go(setTrail(set, canvas.id))}>
                  <span className="title">{canvas.title}</span>
                  <Changes count={count} />
                </button>
              ))}
            </div>
          ))}
          {set.length > levels.reduce((n, l) => n + l.diagrams.length, 0) && <p className="muted small">Diagrams without changes are not listed; their links still open them.</p>}
        </nav>
        <div className="setmain">
          <DiagramView key={open.id + open.version} diagram={open.diagram} focus={focus} siblings={set} onSelect={select} onFlow={onFlow} />
        </div>
        <NodePanel set={set} open={open} node={node} view={view} hunks={hunks} findings={findings} onFollow={follow} />
      </div>
    </div>
  )
}

/** The node selected: the links it opens, and on a fact set its files (with hunks) and the findings on it. */
function NodePanel({ set, open, node, view, hunks, findings, onFollow }: {
  set: DiagramCanvas[]
  open: DiagramCanvas
  node: string | null
  view: FactView | null
  hunks: Hunks
  findings: ReviewFinding[]
  onFollow: (to: string, at: string | undefined, via: string) => void
}) {
  const d = open.diagram
  const links = linksAt(set, open.id, node ?? undefined)
  // The files its lines rest on, then the PR's other files of the module; paths the PR does not change as they are.
  const drawn = node ? nodeFiles(d, node) : []
  const owned = node && d.type === 'component' ? (view?.files.filter((f) => f.module === node) ?? []) : []
  const changes = [...drawn.flatMap((p) => (view && fileOf(view.files, p)) || []), ...owned].filter((f, i, all) => all.findIndex((x) => fileKey(x) === fileKey(f)) === i)
  const loose = drawn.filter((p) => !view || !fileOf(view.files, p))
  const paths = new Set([...changes.map((f) => f.path), ...loose])
  const here = node
    ? findings.filter((f) => f.node === `canvas:${open.id}#${node}` || (f.where && paths.has(findingPlace(f.where)?.path ?? f.where.split(':')[0])))
    : findings.filter((f) => f.node?.startsWith(`canvas:${open.id}`))
  return (
    <aside className="setside">
      <div className="label">{node ? nodeLabel(d, node) : 'This diagram'}</div>
      {!node && <p className="muted small">Click a node: what it links to, its files and findings.</p>}
      {links.length > 0 && (
        <>
          <div className="label">Links</div>
          {links.map((l, i) => {
            const to = set.find((c) => c.id === l.link.to)
            return (
              <div key={i} className="small">
                <span className="muted">{fromLabel(d, l.from)} · {LINK_NAMES[l.link.kind]}</span>{' '}
                {to ? (
                  <button className="link" onClick={() => onFollow(to.id, l.link.node, l.from)}>
                    {to.title}{l.link.node ? ` · ${nodeLabel(to.diagram, l.link.node)}` : ''} →
                  </button>
                ) : (
                  <span className="muted">{l.link.to}: not in this set</span>
                )}
              </div>
            )
          })}
        </>
      )}
      {node && links.length === 0 && <p className="muted small">No links from here.</p>}
      {paths.size > 0 && (
        <>
          <div className="label">Files</div>
          {changes.map((f) => <FileLink key={fileKey(f)} f={f} hunks={hunks} />)}
          {loose.map((p) => <div key={p} className="small"><code>{p}</code></div>)}
        </>
      )}
      {here.length > 0 && (
        <>
          <div className="label">Findings</div>
          {here.map((f, i) => (
            <div key={i} className="small setfinding">
              {f.level && <span className="muted">{f.level.replace('_', ' ')} · </span>}
              {f.text} {f.where && <code>{f.where}</code>}
            </div>
          ))}
        </>
      )}
    </aside>
  )
}
