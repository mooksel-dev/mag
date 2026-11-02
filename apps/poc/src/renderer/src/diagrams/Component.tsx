import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { BOX_LINES, boxLines, callersOf, componentSummary, edgesAt, findNode, flowDiff, flowsSummary, formatDiffCount, innerSummary, layerRule, methodName, moves, nodeDiff, parseFlowRef, pathTo, type ArchEdge, type ArchLayer, type BoxLine, type ComponentDiagram, type DiffCount, type DNode, type DiffMark, type FlowView, type LineMark } from '@mag/core'
import { routeEdges, type Box } from '../archEdges'
import { callGroups, edgePill, flowLines, flowOf, methodCallers, moveEdges, relatedFlows, unchangedAt, type CallGroup, type FlowItem, type FlowLink } from '../componentDiff'
import { DiffLegend } from './DiffLegend'
import { FlowchartView } from './Graph'

const LANES: { layer: ArchLayer; label: string; hint: string }[] = [
  { layer: 'app', label: 'App layer', hint: 'UI, handlers, workers' },
  { layer: 'service', label: 'Services', hint: 'business logic' },
  { layer: 'client', label: 'Clients', hint: 'other runtimes' },
  { layer: 'lib', label: 'Lib', hint: 'project libraries' },
]

interface Lane {
  key: string
  label: string
  hint: string
  nodes: DNode[]
  ports?: boolean
}

/** Layered modules go in lanes by layer, the rest in one lane; modules outside the level in a lane of ports. */
function lanesFor(nodes: DNode[], ports: DNode[], top: boolean): Lane[] {
  const layered = nodes.some((n) => n.layer)
  const lanes: Lane[] = layered ? LANES.map((l) => ({ key: l.layer, label: l.label, hint: l.hint, nodes: nodes.filter((n) => n.layer === l.layer) })) : []
  const rest = nodes.filter((n) => !n.layer)
  if (rest.length || !layered)
    lanes.push(top ? { key: 'top', label: 'Modules', hint: 'apps and outside runtimes', nodes: rest } : { key: 'other', label: 'Other', hint: 'no layer', nodes: rest })
  if (ports.length) lanes.push({ key: 'ports', label: 'Outside', hint: 'modules this level calls or is called by', nodes: ports, ports: true })
  return lanes
}

/** Layering error on a use; modules without a layer follow no rules. */
function ruleOf(all: DNode[], from: DNode, to: string) {
  const t = findNode(all, to)
  return from.layer && t?.layer ? layerRule(from.layer, t.layer) : null
}

/** Diff class of an element; in a diff diagram an unmarked one is context. */
const diffCls = (on: boolean, m: LineMark | undefined) => (on ? ` diff-${m ?? 'none'}` : '')

const DIFF_NAMES: Record<DiffMark, string> = { add: 'added', mod: 'changed', del: 'removed' }
const SIGNS: Record<LineMark, string> = { add: '+', mod: '~', del: '−', move: '↷' }

/** The signature of an interface line, without its description: "name(args): Result - what it does" → "name(args): Result". */
const signature = (text: string) => text.split(/\s[-–—]\s/)[0]

/** The lane a module goes in, as lanesFor places it. */
const laneKey = (n: DNode, top: boolean) => n.layer ?? (top ? 'top' : 'other')

/** A box gets the "!" mark when the agent flagged it or one of its uses breaks the layering rules. */
const flagged = (all: DNode[], n: DNode) => !!n.concern || n.uses.some((u) => ruleOf(all, n, u.to)?.severity === 'error')

const NO_FLOWS: FlowItem[] = []

/** Opens the flow of a method: the module's id and the method. */
export type OpenFlow = (module: string, method: string) => void

/**
 * One level of a module tree: click a module with inner modules to go inside, breadcrumbs lead back. Arrows carry
 * the number of calls; modules outside the level that it calls or is called by show as ports. `diff`: a task diagram,
 * colored by its diff marks instead of layering. `focus`: a module to show on its level and select (a #node link).
 * `flows`: the task's flows of methods; a method with one gets "flow ›", which opens the flow in place.
 */
export function ComponentView({ modules, diff = false, summary, focus, flows = NO_FLOWS, onSelect, onFlow }: {
  modules: DNode[]
  diff?: boolean
  summary?: string
  focus?: string
  flows?: FlowItem[]
  /** Told the module selected, null when none. */
  onSelect?: (id: string | null) => void
  /** Opens a method's flow somewhere else (the diff window's next diagram) instead of in place. */
  onFlow?: OpenFlow
}) {
  const at = (id: string | undefined) => (id ? pathTo(modules, id) : [])
  const [level, setLevel] = useState<string | null>(() => at(focus).at(-2)?.id ?? null)
  const [selected, setSelected] = useState<string | null>(() => (at(focus).length ? focus! : null))
  // A hovered module of a diff shows in the side panel until the pointer leaves it; a click fixes the selection.
  const [hover, setHover] = useState<string | null>(null)
  const crumbs = level ? pathTo(modules, level) : []
  // The tree may change under us (a new architect run): fall back to the top when the level is gone.
  const parentId = level && crumbs.length ? level : null
  const sel = selected ? findNode(modules, selected) : undefined
  const shown = (diff && hover ? findNode(modules, hover) : undefined) ?? sel
  // The open flow of a method, in place of the modules; gone with its diagram or module.
  const [flowId, setFlowId] = useState<string | null>(null)
  const flow = diff ? flows.find((f) => f.id === flowId) : undefined
  const flowNode = flow ? findNode(modules, parseFlowRef(flow.diagram.of)!.module) : undefined

  useEffect(() => {
    if (!sel || flowNode) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, flowNode])
  // Esc leaves a flow for the modules, unless it only cleared a node of the flow.
  useEffect(() => {
    if (!flowNode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setFlowId(null)
      setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flowNode])

  const go = (id: string | null) => {
    setLevel(id)
    setSelected(null)
    setHover(null)
  }
  /** Shows a module on its own level and selects it. */
  const reveal = (id: string) => {
    setLevel(pathTo(modules, id).at(-2)?.id ?? null)
    setSelected(id)
    setFlowId(null)
  }
  useEffect(() => onSelect?.(selected), [selected])
  /** Opens the flow of a method in place; its module stays selected on its level for the way back. */
  const openFlow: OpenFlow | undefined = diff && flows.length
    ? onFlow ?? ((module, method) => {
        const f = flowOf(flows, module, method)
        if (!f || !pathTo(modules, module).length) return
        reveal(module)
        setHover(null)
        setFlowId(f.id)
      })
    : undefined
  // A new anchor on the same view (another #node link to it).
  useEffect(() => {
    if (focus && pathTo(modules, focus).length) reveal(focus)
  }, [focus])

  if (flow && flowNode)
    return (
      <>
        <SummaryHeader modules={modules} summary={summary} flows={flows} />
        <FlowLevel key={flow.id} all={modules} flows={flows} item={flow} node={flowNode} onTop={() => (setFlowId(null), go(null))} onModule={reveal} onFlow={openFlow!} />
      </>
    )

  return (
    <>
      {diff && <SummaryHeader modules={modules} summary={summary} flows={flows} />}
      <nav className="archcrumbs">
        <button className="link" disabled={!parentId} onClick={() => go(null)}>All modules</button>
        {crumbs.map((n) => (
          <Fragment key={n.id}>
            <span className="muted">›</span>
            <button className="link" disabled={n.id === parentId} onClick={() => go(n.id)}>{n.name}</button>
          </Fragment>
        ))}
      </nav>
      <div className="archlegend muted small">
        <span>
          {diff
            ? 'Click a module with ▸ to go inside. Hover or click a box to see its calls; Esc clears.'
            : 'Click a module with ▸ to go inside. Hover or select a box to see its links; hover an arrow label for the calls.'}
        </span>
        {diff ? (
          <DiffLegend move />
        ) : (
          <>
            <span><i className="sw error" /> breaks layering</span>
            <span><i className="sw warning" /> app uses a client directly</span>
          </>
        )}
      </div>
      <div className="archbody">
        <Level key={parentId ?? ''} all={modules} diff={diff} flows={flows} parentId={parentId} selected={selected} hover={hover} onHover={setHover} onSelect={setSelected} onOpen={go} onReveal={reveal} onFlow={openFlow} />
        {diff ? (
          // A diff keeps the panel in place, so hovering a box does not reflow the diagram under the pointer.
          <aside className="archside">
            {shown ? (
              <>
                {shown === sel && <button className="icon close" title="Close (Esc)" onClick={() => setSelected(null)}>✕</button>}
                <DiffDetails all={modules} flows={flows} node={shown} onReveal={reveal} onOpen={go} onFlow={openFlow} />
              </>
            ) : (
              <p className="muted small">Hover or click a module to see what it calls and who calls it.</p>
            )}
          </aside>
        ) : (
          sel && (
            <aside className="archside">
              <button className="icon close" title="Close (Esc)" onClick={() => setSelected(null)}>✕</button>
              <NodeDetails all={modules} node={sel} onReveal={reveal} onOpen={go} />
            </aside>
          )
        )}
      </div>
    </>
  )
}

function Level({ all, diff, flows, parentId, selected, hover, onHover: setHover, onSelect, onOpen, onReveal, onFlow }: {
  all: DNode[]
  diff: boolean
  flows: FlowItem[]
  parentId: string | null
  selected: string | null
  hover: string | null
  onHover: Dispatch<SetStateAction<string | null>>
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onReveal: (id: string) => void
  onFlow?: OpenFlow
}) {
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map())
  // Unchanged modules of a diff the user unfolded back into their lanes.
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set())
  // Boxes opened in full by their "+N more": every changed line, not only the first ones.
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const toggleOpened = (id: string) =>
    setOpened((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const wrap = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const uid = useId()

  const nodes = useMemo(() => (parentId ? findNode(all, parentId)?.children ?? [] : all), [all, parentId])
  const edges = useMemo(() => edgesAt(all, parentId), [all, parentId])
  const ports = useMemo(() => {
    const ids = [...new Set(edges.flatMap((e) => (e.port === 'in' ? [e.from] : e.port === 'out' ? [e.to] : [])))]
    return ids.map((id) => findNode(all, id)).filter((n): n is DNode => !!n)
  }, [all, edges])
  const diagram = useMemo((): ComponentDiagram => ({ type: 'component', modules: all }), [all])
  const folded = useMemo(() => (diff ? unchangedAt(diagram, nodes, flows) : new Set<string>()), [diff, diagram, nodes, flows])
  const collapsed = (id: string) => folded.has(id) && !unfolded.has(id)
  const top = !parentId
  // A lane whose modules all fold into "Без змін" goes away; one that was empty anyway stays.
  const lanes = lanesFor(nodes.filter((n) => !collapsed(n.id)), ports, top).filter(
    (l) => l.ports || l.nodes.length || !nodes.some((n) => laneKey(n, top) === l.key),
  )
  const unchanged = nodes.filter((n) => folded.has(n.id))
  const toggle = (id: string) =>
    setUnfolded((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const moved = useMemo(() => (diff ? moveEdges(diagram, parentId) : []), [diff, diagram, parentId])

  // Box positions drive the arrows; they change whenever the diagram reflows (window resize, drawer open, new data).
  useLayoutEffect(() => {
    const root = wrap.current
    if (!root) return
    const measure = () => {
      const o = root.getBoundingClientRect()
      const next = new Map<string, Box>()
      for (const [id, el] of els.current) {
        const r = el.getBoundingClientRect()
        next.set(id, { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height })
      }
      setBoxes(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    return () => ro.disconnect()
  }, [nodes, ports, folded, unfolded, opened])

  const focus = (hover && boxes.has(hover) ? hover : null) ?? (selected && boxes.has(selected) ? selected : null)
  const near = (id: string) =>
    !focus || id === focus || [...edges, ...moved].some((e) => (e.from === focus && e.to === id) || (e.to === focus && e.from === id))

  const routes = useMemo(() => {
    const shown = edges
      .filter((e) => !focus || e.from === focus || e.to === focus)
      .map((e) => {
        const from = findNode(all, e.from)
        // In a diff diagram arrows are colored by their change, not by layering.
        const sev = diff ? `d-${e.diff ?? 'none'}` : from?.layer ? (ruleOf(all, from, e.to)?.severity ?? 'ok') : 'ok'
        return { ...e, sev } as ArchEdge & { sev: string; moved?: string[] }
      })
    const shownMoves = moved
      .filter((m) => !focus || m.from === focus || m.to === focus)
      .map((m): ArchEdge & { sev: string; moved?: string[] } => ({ from: m.from, to: m.to, calls: [], sev: 'd-move', moved: m.names }))
    return routeEdges([...shown, ...shownMoves], boxes)
  }, [all, diff, edges, moved, focus, boxes])

  const marker = (sev: string) => `${uid}-${sev}`
  const ref = (id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }
  const hoverProps = (id: string) => ({
    onMouseEnter: () => setHover(id),
    onMouseLeave: () => setHover((h) => (h === id ? null : h)),
  })

  return (
    <div className="archdiagram" ref={wrap}>
      {lanes.map((lane) => (
        <div key={lane.key} className={`archlane${lane.ports ? ' ports' : ''}`}>
          <div className="archlanehead">
            <div>{lane.label}</div>
            <div className="muted small">{lane.hint}</div>
          </div>
          <div className="archboxes">
            {lane.nodes.length === 0 && <span className="muted small">none</span>}
            {lane.nodes.map((n) => {
              const cls = `archbox ${n.layer ? `layer-${n.layer}` : 'nolayer'}${diffCls(diff, nodeDiff(n))}${n.id === selected ? ' on' : ''}${near(n.id) ? '' : ' dim'}`
              if (lane.ports) {
                const where = pathTo(all, n.id).slice(0, -1).map((a) => a.name).join(' › ')
                return (
                  <button key={n.id} ref={ref(n.id)} className={`${cls} port`} title={`Outside this level. Click to show it in place.\n${n.description}`} onClick={() => onReveal(n.id)} {...hoverProps(n.id)}>
                    <span className="name">{n.name}</span>
                    <span className="desc">{where ? `in ${where}` : n.kind ?? 'top level'}</span>
                  </button>
                )
              }
              const inner = n.children?.length ?? 0
              const changes = diff && inner ? formatDiffCount(innerSummary(n, all)) : ''
              const mark = diff ? nodeDiff(n) : undefined
              const full = opened.has(n.id)
              const changed = diff ? cardLines(n, diagram, flows, full) : null
              return (
                <div
                  key={n.id}
                  ref={ref(n.id)}
                  role="button"
                  tabIndex={0}
                  className={`${cls}${inner ? ' nested' : ''}${changed?.shown.length ? ' withlines' : ''}`}
                  title={`${mark ? `${DIFF_NAMES[mark]} · ` : ''}${n.name}\n${n.description}`}
                  onClick={() => (inner ? onOpen(n.id) : onSelect(n.id))}
                  onKeyDown={(e) => e.key === 'Enter' && (inner ? onOpen(n.id) : onSelect(n.id))}
                  {...hoverProps(n.id)}
                >
                  <span className="name">{n.name}</span>
                  {n.kind && <span className="kind">{n.kind}</span>}
                  {!diff && <span className="desc">{n.description}</span>}
                  {changed && changed.shown.length > 0 && (
                    <span className="lines">
                      {changed.shown.map((l, i) => <BoxLineView key={i} all={all} line={l} onFlow={flowFor(flows, n.id, l, onFlow)} />)}
                      {(changed.more > 0 || full) && (
                        <button
                          className="more link muted"
                          title={full ? 'Show the first lines only' : 'Show every changed line of this module'}
                          onClick={(e) => (e.stopPropagation(), toggleOpened(n.id))}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {full ? 'show less' : `+${changed.more} more`}
                        </button>
                      )}
                    </span>
                  )}
                  {inner > 0 && (
                    <span className="inside">
                      ▸ {inner} inside
                      {changes && <span className="changes" title="Changes inside">{changes}</span>}
                      <button className="link" title="Details" onClick={(e) => (e.stopPropagation(), onSelect(n.id))}>details</button>
                    </span>
                  )}
                  {flagged(all, n) && <span className="flag">!</span>}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {unchanged.length > 0 && (
        <div className="archlane unchanged">
          <div className="archlanehead">
            <div>Без змін</div>
            <div className="muted small">click to show the box</div>
          </div>
          <div className="archboxes">
            {unchanged.map((n) => {
              const shut = collapsed(n.id)
              return (
                <button
                  key={n.id}
                  ref={shut ? ref(n.id) : undefined}
                  className={`archchip${shut ? '' : ' on'}${near(n.id) ? '' : ' dim'}`}
                  title={`${shut ? 'Show' : 'Hide'} the box\n${n.description}`}
                  onClick={() => toggle(n.id)}
                  {...(shut ? hoverProps(n.id) : {})}
                >
                  {n.name}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <svg className="archarrows" aria-hidden="true">
        <defs>
          {(diff ? ['d-add', 'd-mod', 'd-del', 'd-none', 'd-move'] : ['ok', 'warning', 'error']).map((sev) => (
            <marker key={sev} id={marker(sev)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 1 L9 5 L0 9 Z" className={sev} />
            </marker>
          ))}
        </defs>
        {routes.map((r) => (
          <path key={`${r.moved ? 'move:' : ''}${r.from}>${r.to}`} d={r.d} className={r.sev} markerEnd={`url(#${marker(r.sev)})`} />
        ))}
      </svg>
      <div className="archbadges">
        {routes.filter((r) => r.moved).map((r) => (
          <span key={`move:${r.from}>${r.to}`} className="archbadge pill d-move" style={{ left: r.mid.x, top: r.mid.y }} title={`moved ${findNode(all, r.from)?.name} → ${findNode(all, r.to)?.name}\n${r.moved!.join('\n')}`}>
            ↷{r.moved!.length}
          </span>
        ))}
        {routes.filter((r) => r.calls.length).map((r) => {
          // A diff arrow carries only the count of its changed calls, colored by the main change; the calls are in the side panel.
          if (diff) {
            const pill = edgePill(r)
            return pill && (
              <span key={r.from + '>' + r.to} className={`archbadge pill d-${pill.mark}`} style={{ left: r.mid.x, top: r.mid.y }}>
                {formatDiffCount(pill.count)}
              </span>
            )
          }
          return (
            <span key={r.from + '>' + r.to} className={`archbadge ${r.sev}`} style={{ left: r.mid.x, top: r.mid.y }}>
              {r.calls.length}
              <span className="calls">
                <span className="muted">{findNode(all, r.from)?.name} → {findNode(all, r.to)?.name}</span>
                {r.calls.map((c) => <code key={c}>{c}</code>)}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** The side panel of the architecture view (no diff): interface, calls, callers and layering. */
function NodeDetails({ all, node, onReveal, onOpen }: { all: DNode[]; node: DNode; onReveal: (id: string) => void; onOpen: (id: string) => void }) {
  const path = pathTo(all, node.id).slice(0, -1)
  const callers = callersOf(all, node.id)
  const lines = node.interface ?? []
  const names = new Set(lines.map((l) => methodName(l.text)))
  // With an interface: callers of a method not in it or with no calls recorded; without one: every caller.
  const others = lines.length ? callers.filter((c) => !c.calls.length || c.calls.some((x) => !names.has(methodName(x)))) : callers
  const issues = node.uses.map((u) => ({ to: u.to, r: ruleOf(all, node, u.to) })).filter((x) => x.r)
  const link = (id: string, title?: string) => {
    const n = findNode(all, id)
    return n ? <button key={id} className="link" title={title} onClick={() => onReveal(id)}>{n.name}</button> : null
  }
  const meta = [path.map((a) => a.name).join(' › '), node.kind, LANES.find((l) => l.layer === node.layer)?.label, node.paths?.join(', ') ?? node.path].filter(Boolean)

  return (
    <div className="moddetails">
      {meta.length > 0 && <div className="muted small">{meta.join(' · ')}</div>}
      <h2>{node.name}</h2>
      <p>{node.description}</p>
      {node.concern && <div className="violation error">{node.concern}</div>}
      {!!node.children?.length && (
        <>
          <div className="label">Inside <button className="link" onClick={() => onOpen(node.id)}>open ▸</button></div>
          <div className="chips">{node.children.map((c) => link(c.id))}</div>
        </>
      )}
      <div className="label">Calls</div>
      {node.uses.length ? (
        <ul className="archcalls">
          {node.uses.map((u) => (
            <li key={u.to}>
              {link(u.to)}
              {u.calls.map((c, i) => <code key={i}>{c.text}</code>)}
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted small">nothing</span>
      )}
      {lines.length > 0 && (
        <>
          <div className="label">Interface · who calls</div>
          <ul className="archcalls">
            {lines.map((line, i) => {
              const by = callers.filter((c) => c.calls.some((x) => methodName(x) === methodName(line.text)))
              return (
                <li key={i}>
                  <code>{line.text}</code>
                  {by.length > 0 && <span className="chips">{by.map((c) => link(c.node.id))}</span>}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {(!lines.length || others.length > 0) && (
        <>
          <div className="label">{lines.length ? 'Other callers' : 'Used by'}</div>
          <div className="chips">
            {others.length ? others.map((c) => link(c.node.id, c.calls.join('\n') || undefined)) : <span className="muted small">nobody</span>}
          </div>
        </>
      )}
      {issues.length > 0 && (
        <>
          <div className="label">Layering</div>
          {issues.map(({ to, r }) => (
            <div key={to} className={`violation ${r!.severity}`}>{r!.rule}: → {findNode(all, to)?.name}</div>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * The side panel of a diff: the module, its whole interface diff, then every call it makes by target ("Викликає →")
 * and every call made to it by caller ("← Хто викликає"), one per line with its mark.
 */
function DiffDetails({ all, flows, node, onReveal, onOpen, onFlow }: {
  all: DNode[]
  flows: FlowItem[]
  node: DNode
  onReveal: (id: string) => void
  onOpen: (id: string) => void
  onFlow?: OpenFlow
}) {
  const path = pathTo(all, node.id).slice(0, -1)
  const mark = nodeDiff(node)
  const lines = node.interface ?? []
  const withFlow = flowLines(node, flows)
  const movedOut = moves({ type: 'component', modules: all }).filter((m) => m.from === node.id)
  const { calls, callers } = callGroups(all, node)
  const link = (id: string) => {
    const n = findNode(all, id)
    return n ? <button className="link" onClick={() => onReveal(id)}>{n.name}</button> : <span>{id}</span>
  }
  const meta = [path.map((a) => a.name).join(' › '), node.kind, LANES.find((l) => l.layer === node.layer)?.label, node.paths?.join(', ') ?? node.path].filter(Boolean)
  const groups = (list: CallGroup[], arrow: 'in' | 'out') =>
    list.length ? (
      list.map((g) => (
        <div key={g.id} className={`callgroup${diffCls(true, g.diff)}`}>
          <div className="callhead">{arrow === 'out' ? <>→ {link(g.id)}</> : <>← {link(g.id)}</>}</div>
          {g.calls.length ? (
            g.calls.map((c, i) => <CallLine key={i} text={c.text} mark={c.diff} onFlow={flowFor(flows, arrow === 'out' ? g.id : node.id, c, onFlow)} />)
          ) : (
            <span className="muted small">no calls recorded</span>
          )}
        </div>
      ))
    ) : (
      <span className="muted small">nobody</span>
    )

  return (
    <div className="moddetails">
      {meta.length > 0 && <div className="muted small">{meta.join(' · ')}</div>}
      <h2>
        {node.name}
        {mark && <span className={`diffpill${diffCls(true, mark)}`}>{DIFF_NAMES[mark]}</span>}
      </h2>
      <p>{node.description}</p>
      {node.concern && <div className="violation error">{node.concern}</div>}
      {!!node.children?.length && (
        <>
          <div className="label">Inside <button className="link" onClick={() => onOpen(node.id)}>open ▸</button></div>
          <div className="chips">{node.children.map((c) => <Fragment key={c.id}>{link(c.id)}</Fragment>)}</div>
        </>
      )}
      {(lines.some((l) => l.diff) || movedOut.length > 0 || withFlow.length > 0) && (
        <>
          <div className="label">Інтерфейс</div>
          {lines.filter((l) => l.diff).map((l, i) => (
            <CallLine key={i} text={l.text} mark={l.diff} note={l.diff === 'move' && l.from ? <>← {link(l.from)}</> : undefined} onFlow={flowFor(flows, node.id, l, onFlow)} />
          ))}
          {movedOut.map((m, i) => <CallLine key={`out${i}`} text={m.line.text} mark="move" note={<>→ {link(m.to)}</>} />)}
          {withFlow.map((l, i) => <CallLine key={`flow${i}`} text={l.text} onFlow={flowFor(flows, node.id, l, onFlow)} />)}
        </>
      )}
      <div className="label">Викликає → Ціль</div>
      {node.uses.length ? groups(calls, 'out') : <span className="muted small">nothing</span>}
      <div className="label">← Хто викликає</div>
      {groups(callers, 'in')}
    </div>
  )
}

/**
 * The lines on a diff box: its changed lines (boxLines), then the lines of methods with a flow, at most BOX_LINES
 * unless the box is opened in full; `more` counts the rest.
 */
function cardLines(n: DNode, d: ComponentDiagram, flows: FlowItem[], full = false): { shown: BoxLine[]; more: number } {
  const limit = full ? Infinity : BOX_LINES
  const changed = boxLines(n, d, limit)
  const all = [...changed.shown, ...flowLines(n, flows)]
  return { shown: all.slice(0, limit), more: changed.more + Math.max(0, all.length - limit) }
}

/** Opens the flow of the method on a line of `module`, when it has one; a line that moved out has none here. */
function flowFor(flows: FlowItem[], module: string, line: { text: string; to?: string }, onFlow?: OpenFlow): (() => void) | undefined {
  const method = methodName(line.text)
  return onFlow && !line.to && flowOf(flows, module, method) ? () => onFlow(module, method) : undefined
}

/** "flow ›": opens the flow of a method, without selecting or opening the box it sits in. */
function FlowLink({ onFlow }: { onFlow: () => void }) {
  return (
    <button className="link flowlink" title="Show the logic of this method" onClick={(e) => (e.stopPropagation(), onFlow())} onKeyDown={(e) => e.stopPropagation()}>
      flow ›
    </button>
  )
}

/** One interface line or call of the side panel: its sign (none when unchanged) and full text. */
function CallLine({ text, mark, note, onFlow }: { text: string; mark?: LineMark; note?: ReactNode; onFlow?: () => void }) {
  return (
    <div className={`bline d-${mark ?? 'none'}`} title={mark ? `${mark === 'move' ? 'moved' : DIFF_NAMES[mark]}: ${text}` : text}>
      <b>{mark ? SIGNS[mark] : ''}</b>
      <code className={mark === 'del' ? 'struck' : undefined}>{text}</code>
      {note && <span className="muted small"> {note}</span>}
      {onFlow && <FlowLink onFlow={onFlow} />}
    </div>
  )
}

/** One line on a box: its sign and signature (none when unchanged, a line shown for its flow); a moved line names the other module. */
function BoxLineView({ all, line, onFlow }: { all: DNode[]; line: BoxLine; onFlow?: () => void }) {
  const name = (id: string) => findNode(all, id)?.name ?? id
  const out = !!line.to
  const mark: LineMark | undefined = out ? 'move' : line.diff
  const text = out ? `${methodName(line.text)} → ${name(line.to!)}` : `${signature(line.text)}${mark === 'move' && line.from ? ` ← ${name(line.from)}` : ''}`
  const what = out ? `moved to ${name(line.to!)}` : mark === 'move' ? `moved from ${name(line.from ?? '')}` : mark ? DIFF_NAMES[mark] : 'logic changes'
  return (
    <span className={`bline d-${mark ?? 'none'}`} title={`${what}: ${line.text}`}>
      <span className={`text${mark === 'del' ? ' struck' : ''}`}><b>{mark ? SIGNS[mark] : ''}</b> {text}</span>
      {onFlow && <FlowLink onFlow={onFlow} />}
    </span>
  )
}

const VIEWS: { view: FlowView; label: string; hint: string }[] = [
  { view: 'diff', label: 'Diff', hint: 'what changes, marked' },
  { view: 'before', label: 'Було', hint: 'the logic before the change' },
  { view: 'after', label: 'Стало', hint: 'the logic after the change' },
]

/**
 * The flow of one method in place of the modules: breadcrumbs back to its module and to the top, Diff / Було / Стало
 * above the flowchart, and a panel with what changes in the logic, the module's other flows and who calls the method.
 */
function FlowLevel({ all, flows, item, node, onTop, onModule, onFlow }: {
  all: DNode[]
  flows: FlowItem[]
  item: FlowItem
  node: DNode
  onTop: () => void
  onModule: (id: string) => void
  onFlow: OpenFlow
}) {
  const [view, setView] = useState<FlowView>('diff')
  const { method } = parseFlowRef(item.diagram.of)!
  const mark = flowDiff(node, method)
  const { others, replaces, replacedBy } = relatedFlows(flows, item)
  const callers = methodCallers(all, node, method)
  const { summary, changes = [] } = item.diagram
  const toFlow = (l: FlowLink) =>
    l.flow ? <button className="link" onClick={() => onFlow(l.module, l.method)}>{methodLabel(all, l, node.id)}</button> : <code>{methodLabel(all, l, node.id)}</code>

  return (
    <>
      <nav className="archcrumbs">
        <button className="link" onClick={onTop}>All modules</button>
        <span className="muted">›</span>
        <button className="link" onClick={() => onModule(node.id)}>{node.name}</button>
        <span className="muted">›</span>
        <button className="link" disabled>{method}()</button>
      </nav>
      <div className="archlegend muted small">
        <div className="seg views" role="tablist">
          {VIEWS.map((v) => (
            <button key={v.view} role="tab" aria-selected={view === v.view} className={view === v.view ? 'on' : ''} title={v.hint} onClick={() => setView(v.view)}>
              {v.label}
            </button>
          ))}
        </div>
        <span>{item.title}</span>
        <span>Esc goes back to the modules.</span>
      </div>
      <div className="archbody">
        <div className="flowmain">
          <FlowchartView diagram={item.diagram} view={view} />
        </div>
        <aside className="archside">
          <div className="moddetails">
            <div className="muted small">{node.name}</div>
            <h2>
              {method}()
              <span className={`diffpill${diffCls(true, mark)}`}>{DIFF_NAMES[mark]}</span>
            </h2>
            <div className="label">Що змінилось у логіці</div>
            {summary && <p>{summary}</p>}
            {changes.length > 0 && <ul className="flowchanges">{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            {!summary && !changes.length && <span className="muted small">not described</span>}
            <div className="label">Інші flow цього модуля</div>
            {replaces && <div className="small">замінює {toFlow(replaces)}</div>}
            {replacedBy.map((l, i) => <div key={i} className="small">замінено на {toFlow(l)}</div>)}
            {others.length ? (
              others.map((f) => <CallLine key={f.item.id} text={`${f.method}()`} mark={flowDiff(node, f.method)} onFlow={() => onFlow(node.id, f.method)} />)
            ) : (
              !replaces && !replacedBy.length && <span className="muted small">none</span>
            )}
            <div className="label">Хто викликає</div>
            {callers.length ? (
              callers.map((g) => (
                <div key={g.id} className={`callgroup${diffCls(true, g.diff)}`}>
                  <div className="callhead">← <button className="link" onClick={() => onModule(g.id)}>{findNode(all, g.id)?.name ?? g.id}</button></div>
                  {g.calls.map((c, i) => <CallLine key={i} text={c.text} mark={c.diff} />)}
                </div>
              ))
            ) : (
              <span className="muted small">nobody on the diagram</span>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}

/** "method()", with its module's name when it is another module than `here`. */
function methodLabel(all: DNode[], l: { module: string; method: string }, here: string) {
  return l.module === here ? `${l.method}()` : `${findNode(all, l.module)?.name ?? l.module}.${l.method}()`
}

const COUNT_KEYS: (keyof DiffCount)[] = ['add', 'mod', 'del', 'move']

/** Above a diff: what changes by kind (modules, methods, calls, flows of methods), then the groomer's summary. */
function SummaryHeader({ modules, summary, flows }: { modules: DNode[]; summary?: string; flows: FlowItem[] }) {
  const s = useMemo(() => componentSummary({ type: 'component', modules }), [modules])
  const f = useMemo(() => flowsSummary(flows, modules), [flows, modules])
  const groups = ([['modules', s.modules], ['methods', s.methods], ['calls', s.calls], ['flows', f]] as const).filter(([, c]) => COUNT_KEYS.some((k) => c[k]))
  if (!groups.length && !summary) return null
  return (
    <div className="diffsummary">
      {groups.length > 0 && (
        <div className="chips">
          {groups.map(([label, c]) => (
            <span key={label} className="diffchip">
              <span className="muted">{label}</span>
              {COUNT_KEYS.filter((k) => c[k]).map((k) => <b key={k} className={`d-${k}`}>{SIGNS[k]}{c[k]}</b>)}
            </span>
          ))}
        </div>
      )}
      {summary && <p>{summary}</p>}
    </div>
  )
}
