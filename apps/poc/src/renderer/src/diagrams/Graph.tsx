import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DiffMark, FlowchartDiagram, StateDiagram } from '@mag/core'
import { FONT, LABEL_LINE, LINE, layoutGraph, pathOf, type GraphEdge, type GraphLayout, type GraphNode, type PlacedNode } from '../graphLayout'

type Marked<T> = T & { diff?: DiffMark }

const DIFF_NAMES: Record<DiffMark, string> = { add: 'added', mod: 'changed', del: 'removed' }
const SEVS = ['d-add', 'd-mod', 'd-del', 'd-none'] as const

// Pseudo-states of a state machine; agent ids are kebab-case, so these cannot clash.
const INITIAL = '@initial'
const FINAL = '@final'

/** Steps, branches and loops of a flow, top-down. */
export function FlowchartView({ diagram, focus }: { diagram: FlowchartDiagram; focus?: string }) {
  const nodes = diagram.nodes.map((n): Marked<GraphNode> => ({ id: n.id, label: n.label, shape: n.shape, diff: n.diff }))
  const edges = diagram.edges.map((e, i): Marked<GraphEdge> => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label, diff: e.diff }))
  return <GraphView nodes={nodes} edges={edges} direction="DOWN" focus={focus} />
}

/**
 * States of an entity, left to right. A dot points at the initial states, final states lead to a bullseye; those
 * pseudo-arrows take the change of their state.
 */
export function StateView({ diagram, focus }: { diagram: StateDiagram; focus?: string }) {
  const nodes: Marked<GraphNode>[] = diagram.states.map((s) => ({ id: s.id, label: s.label, shape: 'state', diff: s.diff }))
  const edges: Marked<GraphEdge>[] = diagram.transitions.map((t, i) => ({
    id: `t${i}`,
    from: t.from,
    to: t.to,
    label: t.guard ? `${t.event} [${t.guard}]` : t.event,
    diff: t.diff,
  }))
  const initial = diagram.states.filter((s) => s.initial)
  const final = diagram.states.filter((s) => s.final)
  if (initial.length) {
    nodes.unshift({ id: INITIAL, label: 'initial', shape: 'initial' })
    initial.forEach((s, i) => edges.push({ id: `i${i}`, from: INITIAL, to: s.id, diff: s.diff === 'mod' ? undefined : s.diff }))
  }
  if (final.length) {
    nodes.push({ id: FINAL, label: 'final', shape: 'final' })
    final.forEach((s, i) => edges.push({ id: `f${i}`, from: s.id, to: FINAL, diff: s.diff === 'mod' ? undefined : s.diff }))
  }
  return (
    <>
      <div className="muted small graphentity">States of <b>{diagram.entity}</b></div>
      <GraphView nodes={nodes} edges={edges} direction="RIGHT" focus={focus} finals={new Set(final.map((s) => s.id))} />
    </>
  )
}

/**
 * A node-and-arrow diagram laid out by elkjs. Hover or click a node to see its arrows; `focus` (a #node link) selects
 * a node and scrolls to it. `finals`: states drawn with a double border.
 */
function GraphView({ nodes, edges, direction, focus, finals }: {
  nodes: Marked<GraphNode>[]
  edges: Marked<GraphEdge>[]
  direction: 'DOWN' | 'RIGHT'
  focus?: string
  finals?: Set<string>
}) {
  const [layout, setLayout] = useState<GraphLayout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  const svg = useRef<SVGSVGElement>(null)
  const uid = useId()

  // The diagram arrives as fresh objects on every render; lay it out again only when its content changes.
  const key = JSON.stringify([nodes, edges, direction])
  const diffs = useMemo(() => new Map<string, DiffMark | undefined>([...nodes, ...edges].map((x) => [x.id, x.diff])), [key])
  useEffect(() => {
    let live = true
    layoutGraph(nodes, edges, direction).then(
      (l) => live && (setLayout(l), setError(null)),
      (e: unknown) => live && setError(String(e instanceof Error ? e.message : e)),
    )
    return () => {
      live = false
    }
  }, [key])

  useEffect(() => {
    if (focus) setSelected(focus)
  }, [focus])
  useEffect(() => {
    if (!selected || !layout) return
    svg.current?.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, layout])

  const on = hover ?? selected
  const touches = (e: GraphEdge) => !on || e.from === on || e.to === on
  const near = (id: string) => !on || id === on || edges.some((e) => (e.from === on && e.to === id) || (e.to === on && e.from === id))
  const sev = (id: string) => `d-${diffs.get(id) ?? 'none'}`
  const marker = (s: string) => `${uid}-${s}`

  return (
    <div className="graphview">
      <div className="archlegend muted small">
        <span>Hover or click a node to see its arrows.</span>
        <span><i className="sw d-add" /> added</span>
        <span><i className="sw d-mod" /> changed</span>
        <span><i className="sw d-del" /> removed</span>
        <span><i className="sw d-none" /> unchanged</span>
      </div>
      {error && <div className="violation error">Layout failed: {error}</div>}
      {!layout && !error && <p className="muted small">Laying out…</p>}
      {layout && (
        <svg ref={svg} className="graph" width={layout.w} height={layout.h} viewBox={`0 0 ${layout.w} ${layout.h}`} onClick={() => setSelected(null)}>
          <defs>
            {SEVS.map((s) => (
              <marker key={s} id={marker(s)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 1 L9 5 L0 9 Z" className={s} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e) => (
            <path key={e.id} className={`gedge ${sev(e.id)}${touches(e) ? '' : ' dim'}`} d={pathOf(e.points)} markerEnd={`url(#${marker(sev(e.id))})`} />
          ))}
          {layout.edges.map((e) =>
            e.labelAt ? (
              <g key={e.id} className={`glabel ${sev(e.id)}${touches(e) ? '' : ' dim'}`}>
                <rect x={e.labelAt.x} y={e.labelAt.y} width={e.labelAt.w} height={e.labelAt.h} rx={3} />
                {e.labelAt.lines.map((l, i) => (
                  <text key={i} x={e.labelAt!.x + e.labelAt!.w / 2} y={e.labelAt!.y + 2 + LABEL_LINE * (i + 0.5)}>{l}</text>
                ))}
              </g>
            ) : null,
          )}
          {layout.nodes.map((n) => {
            const mark = diffs.get(n.id)
            const pseudo = n.shape === 'initial' || n.shape === 'final'
            return (
              <g
                key={n.id}
                data-id={n.id}
                className={`gnode ${n.shape} diff-${mark ?? 'none'}${n.id === selected ? ' on' : ''}${near(n.id) ? '' : ' dim'}`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                onClick={(ev) => (ev.stopPropagation(), setSelected((s) => (s === n.id ? null : n.id)))}
              >
                <title>{pseudo ? `${n.label} state` : `${mark ? `${DIFF_NAMES[mark]} · ` : ''}${n.label}`}</title>
                <Shape n={n} final={finals?.has(n.id)} />
                {n.lines.map((l, i) => (
                  <text key={i} x={n.x + n.w / 2} y={n.y + n.h / 2 + LINE * (i - (n.lines.length - 1) / 2)} fontSize={FONT}>{l}</text>
                ))}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

function Shape({ n, final }: { n: PlacedNode; final?: boolean }) {
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  switch (n.shape) {
    case 'decision':
      return <polygon className="shape" points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`} />
    case 'initial':
      return <circle className="shape solid" cx={cx} cy={cy} r={n.w / 2} />
    case 'final':
      return (
        <>
          <circle className="shape" cx={cx} cy={cy} r={n.w / 2} />
          <circle className="shape solid" cx={cx} cy={cy} r={n.w / 2 - 5} />
        </>
      )
    case 'start':
    case 'end':
      return <rect className="shape" x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} />
    default: {
      const r = n.shape === 'state' ? 10 : 4
      return (
        <>
          <rect className="shape" x={n.x} y={n.y} width={n.w} height={n.h} rx={r} />
          {final && <rect className="shape inner" x={n.x + 3} y={n.y + 3} width={n.w - 6} height={n.h - 6} rx={r - 3} />}
        </>
      )
    }
  }
}
