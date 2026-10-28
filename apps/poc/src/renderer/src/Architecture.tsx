import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { layerRule, type ArchApp, type ArchLayer, type ArchNode, type Project } from '@mag/core'
import { routeEdges, type Box } from './archEdges.ts'

const mag = window.mag

const LANES: { layer: ArchLayer; label: string; hint: string }[] = [
  { layer: 'app', label: 'App layer', hint: 'UI, handlers, workers' },
  { layer: 'service', label: 'Services', hint: 'business logic' },
  { layer: 'client', label: 'Clients', hint: 'other runtimes' },
  { layer: 'lib', label: 'Lib', hint: 'project libraries' },
]

const key = (app: ArchApp, n: ArchNode) => `${app.name}::${n.id}`

/** A box gets the "!" mark when the agent flagged it or one of its dependencies breaks the layering rules. */
function flagged(app: ArchApp, n: ArchNode) {
  if (n.concern) return true
  return n.uses.some((u) => {
    const t = app.nodes.find((x) => x.id === u)
    return !!t && layerRule(n.layer, t.layer)?.severity === 'error'
  })
}

/** `inWindow`: shown in its own pop-out window, so there is no button to open one. */
export function Architecture({ project, inWindow = false }: { project: Project; inWindow?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  const arch = project.architecture
  const run = project.archRun
  const running = run?.status === 'running'
  const app = arch?.apps.find((a) => a.name === tab) ?? arch?.apps[0]

  const sel = useMemo(() => {
    if (!app || !selected) return null
    const node = app.nodes.find((n) => key(app, n) === selected)
    return node ? { app, node } : null
  }, [app, selected])

  useEffect(() => {
    if (!sel) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel])

  const start = () => mag.runArchitect(project.id).catch((e: Error) => alert(e.message))

  return (
    <section className="page arch">
      <div className="archhead">
        <h1>Architecture</h1>
        <button className={arch ? '' : 'primary'} onClick={start} disabled={running || !project.repos.length}>
          {running ? 'Analyzing…' : arch ? 'Re-analyze' : 'Analyze with AI'}
        </button>
        {arch && <span className="muted small">updated {new Date(arch.updatedAt).toLocaleString()}</span>}
        {run && run.status !== 'done' && (
          <span className={`small ${run.status === 'error' ? 'err' : 'muted'}`}>
            {run.status === 'running' ? '● ' : '✗ '}
            {run.note ?? ''}
          </span>
        )}
        {!inWindow && (
          <button className="link popbtn" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'architecture', projectId: project.id })}>
            ⧉ Open in window
          </button>
        )}
      </div>
      {!project.repos.length && <p className="muted">Attach a repository in Settings.</p>}
      {!arch && !running && project.repos.length > 0 && (
        <p className="muted">
          An agent reads the code and describes it in your layers: app, services, clients, lib, with the interfaces of
          services and clients. It refreshes after each merged PR.
        </p>
      )}
      {arch && (
        <>
          <Summary text={arch.summary} />
          {arch.apps.length > 0 && (
            <div className="archtabs">
              {arch.apps.map((a) => {
                const issues = a.nodes.filter((n) => flagged(a, n)).length
                return (
                  <button
                    key={a.name}
                    className={a === app ? 'on' : ''}
                    onClick={() => {
                      setTab(a.name)
                      setSelected(null)
                    }}
                  >
                    {a.name}
                    {issues > 0 && <span className="badge" title={`${issues} with issues`}>{issues}</span>}
                  </button>
                )
              })}
            </div>
          )}
          {app && (
            <>
              <div className="archlegend muted small">
                {app.kind && <span className="archkind">{app.kind}</span>}
                <span>Hover or select a box to see its links.</span>
                <span><i className="sw error" /> breaks layering</span>
                <span><i className="sw warning" /> app uses a client directly</span>
              </div>
              <div className="archbody">
                <AppDiagram key={app.name} app={app} selected={selected} onSelect={setSelected} />
                {sel && (
                  <aside className="archside">
                    <button className="icon close" title="Close (Esc)" onClick={() => setSelected(null)}>✕</button>
                    <NodeDetails app={sel.app} node={sel.node} onSelect={setSelected} />
                  </aside>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

function Summary({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, open])

  return (
    <div className={`archsummary${open ? ' open' : ''}`}>
      <p ref={ref}>{text}</p>
      {(long || open) && (
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'less' : 'more'}</button>
      )}
    </div>
  )
}

function AppDiagram({ app, selected, onSelect }: { app: ArchApp; selected: string | null; onSelect: (k: string) => void }) {
  const [hover, setHover] = useState<string | null>(null)
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map())
  const wrap = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const uid = useId()

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
  }, [app])

  const byId = useMemo(() => new Map(app.nodes.map((n) => [n.id, n])), [app])
  const selNode = app.nodes.find((n) => key(app, n) === selected)
  const focus = (hover ? byId.get(hover) : undefined) ?? selNode
  const near = (n: ArchNode) => !focus || n.id === focus.id || focus.uses.includes(n.id) || n.uses.includes(focus.id)

  const routes = useMemo(() => {
    if (!focus) return []
    const edges = app.nodes.flatMap((n) =>
      n.uses
        .filter((to) => byId.has(to) && (n.id === focus.id || to === focus.id))
        .map((to) => ({ from: n.id, to, sev: layerRule(n.layer, byId.get(to)!.layer)?.severity ?? 'ok' })),
    )
    return routeEdges(edges, boxes)
  }, [app, byId, focus, boxes])

  const marker = (sev: string) => `${uid}-${sev}`

  return (
    <div className="archdiagram" ref={wrap}>
      {LANES.map((lane) => {
        const nodes = app.nodes.filter((n) => n.layer === lane.layer)
        return (
          <div key={lane.layer} className="archlane">
            <div className="archlanehead">
              <div>{lane.label}</div>
              <div className="muted small">{lane.hint}</div>
            </div>
            <div className="archboxes">
              {nodes.length === 0 && <span className="muted small">none</span>}
              {nodes.map((n) => {
                const k = key(app, n)
                return (
                  <button
                    key={n.id}
                    ref={(el) => {
                      if (el) els.current.set(n.id, el)
                      else els.current.delete(n.id)
                    }}
                    className={`archbox ${n.layer}${k === selected ? ' on' : ''}${near(n) ? '' : ' dim'}`}
                    title={`${n.name}\n${n.description}`}
                    onClick={() => onSelect(k)}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                  >
                    <span className="name">{n.name}</span>
                    <span className="desc">{n.description}</span>
                    {flagged(app, n) && <span className="flag">!</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      <svg className="archarrows" aria-hidden="true">
        <defs>
          {['ok', 'warning', 'error'].map((sev) => (
            <marker key={sev} id={marker(sev)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 1 L9 5 L0 9 Z" className={sev} />
            </marker>
          ))}
        </defs>
        {routes.map((r) => (
          <path key={r.from + '>' + r.to} d={r.d} className={r.sev} markerEnd={`url(#${marker(r.sev)})`} />
        ))}
      </svg>
    </div>
  )
}

function NodeDetails({ app, node, onSelect }: { app: ArchApp; node: ArchNode; onSelect: (k: string) => void }) {
  const byId = new Map(app.nodes.map((n) => [n.id, n]))
  const usedBy = app.nodes.filter((n) => n.uses.includes(node.id))
  const issues = node.uses
    .map((u) => byId.get(u))
    .filter((t): t is ArchNode => !!t)
    .map((t) => ({ t, r: layerRule(node.layer, t.layer) }))
    .filter((x) => x.r)
  const link = (n: ArchNode) => (
    <button key={n.id} className="link" onClick={() => onSelect(key(app, n))}>{n.name}</button>
  )
  return (
    <div className="moddetails">
      <div className="muted small">{app.name} · {LANES.find((l) => l.layer === node.layer)?.label}{node.path ? ` · ${node.path}` : ''}</div>
      <h2>{node.name}</h2>
      <p>{node.description}</p>
      {node.concern && <div className="violation error">{node.concern}</div>}
      {node.interface && node.interface.length > 0 && (
        <>
          <div className="label">Interface</div>
          <pre>{node.interface.join('\n')}</pre>
        </>
      )}
      <div className="label">Uses</div>
      <div className="chips">{node.uses.length ? node.uses.map((u) => byId.get(u)).filter(Boolean).map((n) => link(n!)) : <span className="muted small">nothing</span>}</div>
      <div className="label">Used by</div>
      <div className="chips">{usedBy.length ? usedBy.map(link) : <span className="muted small">nobody</span>}</div>
      {issues.length > 0 && (
        <>
          <div className="label">Layering</div>
          {issues.map(({ t, r }) => (
            <div key={t.id} className={`violation ${r!.severity}`}>{r!.rule}: → {t.name}</div>
          ))}
        </>
      )}
    </div>
  )
}
