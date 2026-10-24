import { useMemo, useState } from 'react'
import { layerRule, type ArchApp, type ArchLayer, type ArchNode, type Project } from '@mag/core'

const mag = window.mag

const LANES: { layer: ArchLayer; label: string; hint: string }[] = [
  { layer: 'app', label: 'App layer', hint: 'UI, handlers, workers' },
  { layer: 'service', label: 'Services', hint: 'business logic' },
  { layer: 'client', label: 'Clients', hint: 'other runtimes' },
  { layer: 'lib', label: 'Lib', hint: 'project libraries' },
]
const STYLE: Record<ArchLayer, { fill: string; stroke: string; text: string }> = {
  app: { fill: '#F3F4F6', stroke: '#C4C8D0', text: '#3D4250' },
  service: { fill: '#EEF1FD', stroke: '#3451D1', text: '#23389C' },
  client: { fill: '#FDF1E6', stroke: '#C2410C', text: '#8E2E07' },
  lib: { fill: '#EDF6EF', stroke: '#1D8A4B', text: '#1D6B3A' },
}
const W = 210
const H = 62
const GAP = 22
const LANE_H = 124
const LEFT = 130

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const key = (app: ArchApp, n: ArchNode) => `${app.name}::${n.id}`

export function Architecture({ project }: { project: Project }) {
  const [selected, setSelected] = useState<string | null>(null)
  const arch = project.architecture
  const run = project.archRun
  const running = run?.status === 'running'

  const sel = useMemo(() => {
    if (!arch || !selected) return null
    for (const app of arch.apps) for (const n of app.nodes) if (key(app, n) === selected) return { app, node: n }
    return null
  }, [arch, selected])

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
          <p className="summary">{arch.summary}</p>
          <div className="archbody">
            <div className="archdiagrams">
              {arch.apps.map((app) => (
                <AppDiagram key={app.name} app={app} selected={selected} onSelect={setSelected} />
              ))}
            </div>
            <aside className="archside">
              {sel ? (
                <NodeDetails app={sel.app} node={sel.node} onSelect={setSelected} />
              ) : (
                <p className="muted">Select a box to see its interface and dependencies. Red arrows break the layering rules.</p>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  )
}

function AppDiagram({ app, selected, onSelect }: { app: ArchApp; selected: string | null; onSelect: (k: string) => void }) {
  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>()
    let maxN = 1
    LANES.forEach((lane, li) => {
      const nodes = app.nodes.filter((n) => n.layer === lane.layer)
      maxN = Math.max(maxN, nodes.length)
      nodes.forEach((n, i) => pos.set(n.id, { x: LEFT + i * (W + GAP), y: li * LANE_H + 30 }))
    })
    return { pos, width: LEFT + maxN * (W + GAP) + 20, height: LANES.length * LANE_H + 20 }
  }, [app])

  const byId = new Map(app.nodes.map((n) => [n.id, n]))
  const selNode = app.nodes.find((n) => key(app, n) === selected)
  const near = (n: ArchNode) =>
    !selNode || n.id === selNode.id || selNode.uses.includes(n.id) || n.uses.includes(selNode.id)

  return (
    <div className="archapp">
      <div className="label">
        {app.name}
        {app.kind && <span className="muted"> · {app.kind}</span>}
      </div>
      <svg width={layout.width} height={layout.height} role="img" aria-label={`Architecture of ${app.name}`}>
        <defs>
          <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 1 L9 5 L0 9 Z" fill="context-stroke" />
          </marker>
        </defs>
        {LANES.map((lane, li) => (
          <g key={lane.layer}>
            <rect x={0} y={li * LANE_H + 14} width={layout.width} height={LANE_H - 12} rx={10} fill={li % 2 ? '#FFFFFF' : '#FAFAFB'} />
            <text x={14} y={li * LANE_H + 52} fontSize={13} fontWeight={600} fill="#15171C">{lane.label}</text>
            <text x={14} y={li * LANE_H + 70} fontSize={11} fill="#8A8F9C">{lane.hint}</text>
          </g>
        ))}
        {app.nodes.flatMap((n) =>
          n.uses.map((to) => {
            const t = byId.get(to)
            const a = layout.pos.get(n.id)
            const b = layout.pos.get(to)
            if (!t || !a || !b) return null
            const sev = layerRule(n.layer, t.layer)?.severity
            const color = sev === 'error' ? '#C0392B' : sev === 'warning' ? '#D68910' : '#B8BDC7'
            const dim = selNode && n.id !== selNode.id && to !== selNode.id
            const ax = a.x + W / 2
            const bx = b.x + W / 2
            const d =
              b.y > a.y
                ? `M ${ax} ${a.y + H} C ${ax} ${a.y + H + 40}, ${bx} ${b.y - 40}, ${bx} ${b.y}`
                : `M ${ax} ${a.y} C ${ax} ${a.y - 36}, ${bx} ${b.y - 36}, ${bx} ${b.y}`
            return (
              <path
                key={n.id + '>' + to}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={sev ? 2.2 : 1.4}
                strokeDasharray={sev === 'warning' ? '5 4' : undefined}
                opacity={dim ? 0.12 : 1}
                markerEnd="url(#arch-arrow)"
              />
            )
          }),
        )}
        {app.nodes.map((n) => {
          const p = layout.pos.get(n.id)
          if (!p) return null
          const s = STYLE[n.layer]
          const k = key(app, n)
          const broken = n.uses.some((u) => byId.get(u) && layerRule(n.layer, byId.get(u)!.layer)?.severity === 'error')
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} onClick={() => onSelect(k)} style={{ cursor: 'pointer' }} opacity={near(n) ? 1 : 0.3}>
              <title>{n.description}</title>
              <rect width={W} height={H} rx={8} fill={s.fill} stroke={k === selected ? '#15171C' : s.stroke} strokeWidth={k === selected ? 2 : 1} />
              <text x={12} y={24} fontSize={14} fontWeight={600} fill={s.text}>{clip(n.name, 24)}</text>
              <text x={12} y={44} fontSize={11} fill="#5B6170">{clip(n.description, 34)}</text>
              {(n.concern || broken) && (
                <g transform={`translate(${W - 24},8)`}>
                  <circle cx={8} cy={8} r={8} fill="#C0392B" />
                  <text x={8} y={12} fontSize={11} fill="#fff" textAnchor="middle">!</text>
                </g>
              )}
            </g>
          )
        })}
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
