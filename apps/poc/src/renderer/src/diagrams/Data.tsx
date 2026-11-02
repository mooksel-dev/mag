import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { fieldMoves, type DataDiagram, type DataMark, type DEntity } from '@mag/core'
import { DiffLegend } from './DiffLegend'
import { DATA_HEAD, DATA_NOTE, DATA_ROW, DATA_SUB, FONT, LABEL_LINE, fieldKey, layoutData, movePath, pathOf, type DataLayout } from '../graphLayout'

const DIFF_NAMES: Record<DataMark, string> = { add: 'added', mod: 'changed', del: 'removed', move: 'moved' }
const SIGNS: Record<DataMark, string> = { add: '+', mod: '~', del: '−', move: '↷' }
const SEVS = ['d-add', 'd-mod', 'd-del', 'd-none', 'd-move'] as const

/** An entity's own change: its mark, else 'mod' when one of its fields changes or moves out. */
function entityDiff(e: DEntity, movedOut: Set<string>): DataMark | undefined {
  return e.diff ?? (e.fields.some((f) => f.diff || movedOut.has(fieldKey(e.id, f.name))) ? 'mod' : undefined)
}

/**
 * Collections, tables and types with their fields, left to right. A changed field is coloured by its mark; a field
 * that moved is purple at both ends, struck out at the source, with a dashed line between them. Hover or click an
 * entity to see its relations; `focus` (a #entity link) selects one and scrolls to it.
 */
export function DataView({ diagram, focus, onSelect }: { diagram: DataDiagram; focus?: string; onSelect?: (id: string | null) => void }) {
  const [layout, setLayout] = useState<DataLayout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  useEffect(() => onSelect?.(selected), [selected])
  const svg = useRef<SVGSVGElement>(null)
  const uid = useId()

  // The diagram arrives as a fresh object on every render; lay it out again only when its content changes.
  const key = JSON.stringify(diagram)
  const moves = useMemo(() => fieldMoves(diagram), [key])
  const movedOut = useMemo(() => new Set(moves.map((m) => fieldKey(m.from.entity, m.from.field))), [moves])
  useEffect(() => {
    let live = true
    layoutData(diagram).then(
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
  const links = [...diagram.relations, ...moves.map((m) => ({ from: m.from.entity, to: m.to.entity }))]
  const touches = (from: string, to: string) => !on || from === on || to === on
  const near = (id: string) => !on || id === on || links.some((r) => (r.from === on && r.to === id) || (r.to === on && r.from === id))
  const marker = (s: string) => `${uid}-${s}`
  const placed = new Map(layout?.entities.map((e) => [e.id, e]))

  return (
    <div className="graphview">
      <div className="archlegend muted small">
        <span>Hover or click an entity to see its relations.</span>
        <DiffLegend move />
      </div>
      {error && <div className="violation error">Layout failed: {error}</div>}
      {!layout && !error && <p className="muted small">Laying out…</p>}
      {layout && (
        <svg ref={svg} className="graph data" width={layout.w} height={layout.h} viewBox={`0 0 ${layout.w} ${layout.h}`} onClick={() => setSelected(null)}>
          <defs>
            {SEVS.map((s) => (
              <marker key={s} id={marker(s)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 1 L9 5 L0 9 Z" className={s} />
              </marker>
            ))}
          </defs>
          {layout.relations.map((p) => {
            const r = diagram.relations[p.index]
            const sev = `d-${r.diff ?? 'none'}`
            const dim = touches(r.from, r.to) ? '' : ' dim'
            return (
              <g key={p.index}>
                <path className={`gedge ${sev}${dim}`} d={pathOf(p.points)} markerEnd={`url(#${marker(sev)})`} />
                {p.labelAt && (
                  <g className={`glabel ${sev}${dim}`}>
                    <rect x={p.labelAt.x} y={p.labelAt.y} width={p.labelAt.w} height={p.labelAt.h} rx={3} />
                    {p.labelAt.lines.map((l, i) => (
                      <text key={i} x={p.labelAt!.x + p.labelAt!.w / 2} y={p.labelAt!.y + 2 + LABEL_LINE * (i + 0.5)}>{l}</text>
                    ))}
                  </g>
                )}
              </g>
            )
          })}
          {diagram.entities.map((e) => {
            const box = placed.get(e.id)
            if (!box) return null
            const mark = entityDiff(e, movedOut)
            return (
              <g
                key={e.id}
                data-id={e.id}
                className={`dentity diff-${mark ?? 'none'}${e.id === selected ? ' on' : ''}${near(e.id) ? '' : ' dim'}`}
                onMouseEnter={() => setHover(e.id)}
                onMouseLeave={() => setHover((h) => (h === e.id ? null : h))}
                onClick={(ev) => (ev.stopPropagation(), setSelected((s) => (s === e.id ? null : e.id)))}
              >
                <title>{`${mark ? `${DIFF_NAMES[mark]} · ` : ''}${e.name} (${e.kind})`}</title>
                <rect className="shape" x={box.x} y={box.y} width={box.w} height={box.h} rx={6} />
                <text className="dname" x={box.x + 10} y={box.y + DATA_HEAD / 2 + 3} fontSize={FONT}>{e.name}</text>
                {box.sub.map((l, i) => (
                  <text key={i} className="dsub" x={box.x + 10} y={box.y + DATA_HEAD + DATA_SUB * (i + 0.5)}>{l}</text>
                ))}
                {e.fields.length > 0 && <line className="dsep" x1={box.x} x2={box.x + box.w} y1={box.rows[0].y - 3} y2={box.rows[0].y - 3} />}
                {e.fields.map((f, i) => {
                  const row = box.rows[i]
                  const out = movedOut.has(fieldKey(e.id, f.name))
                  // A field that moved out is purple whatever else it is marked.
                  const fm = out ? 'move' : f.diff
                  return (
                    <g key={f.name} className={`dfield f-${fm ?? 'none'}${out ? ' out' : ''}`}>
                      <title>{`${fm ? `${out ? 'moved out' : DIFF_NAMES[fm]} · ` : ''}${f.name}: ${f.type}`}</title>
                      {fm && <rect className="band" x={box.x + 1} y={row.y} width={box.w - 2} height={row.h} />}
                      {fm && <text className="fsign" x={box.x + 10} y={row.y + DATA_ROW / 2}>{SIGNS[fm]}</text>}
                      <text className="fname" x={box.x + 22} y={row.y + DATA_ROW / 2}>{f.name}</text>
                      <text className="ftype" x={box.x + box.w - 10} y={row.y + DATA_ROW / 2}>{f.type}</text>
                      {row.notes.map((l, j) => (
                        <text key={j} className="fnote" x={box.x + 22} y={row.y + DATA_ROW + DATA_NOTE * (j + 0.5) - 2}>{l}</text>
                      ))}
                    </g>
                  )
                })}
              </g>
            )
          })}
          {moves.map((m, i) => {
            const from = placed.get(m.from.entity)
            const to = placed.get(m.to.entity)
            const fi = diagram.entities.find((e) => e.id === m.from.entity)!.fields.findIndex((f) => f.name === m.from.field)
            const ti = diagram.entities.find((e) => e.id === m.to.entity)!.fields.findIndex((f) => f.name === m.to.field)
            if (!from || !to) return null
            return (
              <path
                key={i}
                className={`dmove${touches(m.from.entity, m.to.entity) ? '' : ' dim'}`}
                d={movePath(from, from.rows[fi], to, to.rows[ti])}
                markerEnd={`url(#${marker('d-move')})`}
              />
            )
          })}
        </svg>
      )}
    </div>
  )
}
