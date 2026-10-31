import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { boxLines, callersOf, componentSummary, edgesAt, findNode, formatDiffCount, innerSummary, layerRule, methodName, moves, nodeDiff, pathTo, type ArchEdge, type ArchLayer, type BoxLine, type ComponentDiagram, type DiffCount, type DNode, type DiffMark, type LineMark } from '@mag/core'
import { routeEdges, type Box } from '../archEdges'
import { edgeCalls, moveEdges, unchangedAt } from '../componentDiff'
import { DiffLegend } from './DiffLegend'

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

/**
 * One level of a module tree: click a module with inner modules to go inside, breadcrumbs lead back. Arrows carry
 * the number of calls; modules outside the level that it calls or is called by show as ports. `diff`: a task diagram,
 * colored by its diff marks instead of layering. `focus`: a module to show on its level and select (a #node link).
 */
export function ComponentView({ modules, diff = false, summary, focus }: { modules: DNode[]; diff?: boolean; summary?: string; focus?: string }) {
  const at = (id: string | undefined) => (id ? pathTo(modules, id) : [])
  const [level, setLevel] = useState<string | null>(() => at(focus).at(-2)?.id ?? null)
  const [selected, setSelected] = useState<string | null>(() => (at(focus).length ? focus! : null))
  const crumbs = level ? pathTo(modules, level) : []
  // The tree may change under us (a new architect run): fall back to the top when the level is gone.
  const parentId = level && crumbs.length ? level : null
  const sel = selected ? findNode(modules, selected) : undefined

  useEffect(() => {
    if (!sel) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel])

  const go = (id: string | null) => {
    setLevel(id)
    setSelected(null)
  }
  /** Shows a module on its own level and selects it. */
  const reveal = (id: string) => {
    setLevel(pathTo(modules, id).at(-2)?.id ?? null)
    setSelected(id)
  }
  // A new anchor on the same view (another #node link to it).
  useEffect(() => {
    if (focus && pathTo(modules, focus).length) reveal(focus)
  }, [focus])

  return (
    <>
      {diff && <SummaryHeader modules={modules} summary={summary} />}
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
        <span>Click a module with ▸ to go inside. Hover or select a box to see its links; hover an arrow label for the calls.</span>
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
        <Level key={parentId ?? ''} all={modules} diff={diff} parentId={parentId} selected={selected} onSelect={setSelected} onOpen={go} onReveal={reveal} />
        {sel && (
          <aside className="archside">
            <button className="icon close" title="Close (Esc)" onClick={() => setSelected(null)}>✕</button>
            <NodeDetails all={modules} diff={diff} node={sel} onReveal={reveal} onOpen={go} />
          </aside>
        )}
      </div>
    </>
  )
}

function Level({ all, diff, parentId, selected, onSelect, onOpen, onReveal }: {
  all: DNode[]
  diff: boolean
  parentId: string | null
  selected: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onReveal: (id: string) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map())
  // Unchanged modules of a diff the user unfolded back into their lanes.
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set())
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
  const folded = useMemo(() => (diff ? unchangedAt(diagram, nodes) : new Set<string>()), [diff, diagram, nodes])
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
  }, [nodes, ports, folded, unfolded])

  const focus = hover ?? (selected && boxes.has(selected) ? selected : null)
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
              const changed = diff ? boxLines(n, diagram) : null
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
                  <span className="desc">{n.description}</span>
                  {changed && changed.shown.length > 0 && (
                    <span className="lines">
                      {changed.shown.map((l, i) => <BoxLineView key={i} all={all} line={l} />)}
                      {changed.more > 0 && <span className="more muted">+{changed.more} ще</span>}
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
          <span key={`move:${r.from}>${r.to}`} className="archbadge names d-move" style={{ left: r.mid.x, top: r.mid.y }}>
            {r.moved!.slice(0, 3).map((name) => <span key={name} className="d-move">↷ {name}</span>)}
            {r.moved!.length > 3 && <span className="muted">+{r.moved!.length - 3}</span>}
            <span className="calls">
              <span className="muted">moved {findNode(all, r.from)?.name} → {findNode(all, r.to)?.name}</span>
              {r.moved!.map((name) => <code key={name} className="diff-move">{name}</code>)}
            </span>
          </span>
        ))}
        {routes.filter((r) => r.calls.length).map((r) => {
          // A changed arrow names its changed calls; an unchanged one keeps the count.
          const named = diff ? edgeCalls(r) : null
          return (
            <span key={r.from + '>' + r.to} className={`archbadge ${r.sev}${named ? ' names' : ''}`} style={{ left: r.mid.x, top: r.mid.y }}>
              {named ? (
                <>
                  {named.calls.map((c) => <span key={c.name} className={`d-${c.mark}${c.mark === 'del' ? ' struck' : ''}`}>{SIGNS[c.mark]} {c.name}</span>)}
                  {named.more > 0 && <span className="muted">+{named.more}</span>}
                </>
              ) : (
                r.calls.length
              )}
              <span className="calls">
                <span className="muted">{findNode(all, r.from)?.name} → {findNode(all, r.to)?.name}</span>
                {r.calls.map((c) => <code key={c} className={diffCls(diff && !!r.callDiff?.[c], r.callDiff?.[c])}>{c}</code>)}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function NodeDetails({ all, diff, node, onReveal, onOpen }: { all: DNode[]; diff: boolean; node: DNode; onReveal: (id: string) => void; onOpen: (id: string) => void }) {
  const path = pathTo(all, node.id).slice(0, -1)
  const callers = callersOf(all, node.id)
  const lines = node.interface ?? []
  const names = new Set(lines.map((l) => methodName(l.text)))
  const mark = diff ? nodeDiff(node) : undefined
  // With an interface: callers of a method not in it or with no calls recorded; without one: every caller.
  const others = lines.length ? callers.filter((c) => !c.calls.length || c.calls.some((x) => !names.has(methodName(x)))) : callers
  const movedOut = diff ? moves({ type: 'component', modules: all }).filter((m) => m.from === node.id) : []
  const issues = node.uses.map((u) => ({ to: u.to, r: ruleOf(all, node, u.to) })).filter((x) => x.r)
  const link = (id: string, title?: string) => {
    const n = findNode(all, id)
    return n ? <button key={id} className="link" title={title} onClick={() => onReveal(id)}>{n.name}</button> : null
  }
  const meta = [path.map((a) => a.name).join(' › '), node.kind, LANES.find((l) => l.layer === node.layer)?.label, node.path].filter(Boolean)

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
          <div className="chips">{node.children.map((c) => link(c.id))}</div>
        </>
      )}
      <div className="label">Calls</div>
      {node.uses.length ? (
        <ul className="archcalls">
          {node.uses.map((u) => (
            <li key={u.to} className={diffCls(diff && !!u.diff, u.diff)}>
              {link(u.to)}
              {u.calls.map((c, i) => <code key={i} className={diffCls(diff && !!c.diff, c.diff)}>{c.text}</code>)}
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted small">nothing</span>
      )}
      {(lines.length > 0 || movedOut.length > 0) && (
        <>
          <div className="label">Interface · who calls</div>
          <ul className="archcalls">
            {lines.map((line, i) => {
              const by = callers.filter((c) => c.calls.some((x) => methodName(x) === methodName(line.text)))
              return (
                <li key={i}>
                  <code className={diffCls(diff && !!line.diff, line.diff)}>{line.text}</code>
                  {diff && line.diff === 'move' && line.from && <span className="muted small">moved from {link(line.from)}</span>}
                  {by.length > 0 && <span className="chips">{by.map((c) => link(c.node.id))}</span>}
                </li>
              )
            })}
            {movedOut.map((m, i) => (
              <li key={`out${i}`}>
                <code className="diff-move out">{m.line.text}</code>
                <span className="muted small">moved to {link(m.to)}</span>
              </li>
            ))}
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

/** One changed interface line on a box: its sign and signature; a moved line names the other module. */
function BoxLineView({ all, line }: { all: DNode[]; line: BoxLine }) {
  const name = (id: string) => findNode(all, id)?.name ?? id
  const out = !!line.to
  const mark: LineMark = out ? 'move' : line.diff!
  const text = out ? `${methodName(line.text)} → ${name(line.to!)}` : `${signature(line.text)}${mark === 'move' && line.from ? ` ← ${name(line.from)}` : ''}`
  const title = out ? `moved to ${name(line.to!)}: ${line.text}` : `${line.diff === 'move' ? `moved from ${name(line.from ?? '')}` : DIFF_NAMES[line.diff as DiffMark]}: ${line.text}`
  return (
    <span className={`bline d-${mark}${mark === 'del' ? ' struck' : ''}`} title={title}>
      <b>{SIGNS[mark]}</b> {text}
    </span>
  )
}

const COUNT_KEYS: (keyof DiffCount)[] = ['add', 'mod', 'del', 'move']

/** Above a diff: what changes by kind (modules, methods, calls), then the groomer's summary. */
function SummaryHeader({ modules, summary }: { modules: DNode[]; summary?: string }) {
  const s = useMemo(() => componentSummary({ type: 'component', modules }), [modules])
  const groups = ([['modules', s.modules], ['methods', s.methods], ['calls', s.calls]] as const).filter(([, c]) => COUNT_KEYS.some((k) => c[k]))
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
