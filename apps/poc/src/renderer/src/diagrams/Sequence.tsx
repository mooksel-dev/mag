import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { DiffMark, SequenceDiagram } from '@mag/core'
import { DiffLegend } from './DiffLegend'
import { FONT, LABEL_LINE, LINE } from '../graphLayout'
import { BAR, SELF_W, layoutSequence, type PlacedMessage } from '../sequenceLayout'

const DIFF_NAMES: Record<DiffMark, string> = { add: 'added', mod: 'changed', del: 'removed' }
const SEVS = ['d-add', 'd-mod', 'd-del', 'd-none'] as const
const KIND_NAMES = { call: 'call', reply: 'reply', async: 'async message' }

/**
 * Who calls whom and in which order: participants as columns with lifelines, messages as rows. A call is a solid
 * arrow, a reply a dashed one, an async message has an open head; bars on the lifelines show who is busy. Hover or
 * click a participant to see its messages; `focus` (a #node link) selects one.
 */
export function SequenceView({ diagram, focus, onSelect }: { diagram: SequenceDiagram; focus?: string; onSelect?: (id: string | null) => void }) {
  const layout = useMemo(() => layoutSequence(diagram), [JSON.stringify(diagram)])
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  useEffect(() => onSelect?.(selected), [selected])
  const svg = useRef<SVGSVGElement>(null)
  const uid = useId()

  useEffect(() => {
    if (focus) setSelected(focus)
  }, [focus])
  useEffect(() => {
    if (!selected) return
    svg.current?.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const on = hover ?? selected
  const touches = (m: { from: string; to: string }) => !on || m.from === on || m.to === on
  const near = (id: string) => !on || id === on || layout.messages.some((m) => (m.from === on && m.to === id) || (m.to === on && m.from === id))
  const sev = (d?: DiffMark) => `d-${d ?? 'none'}`
  const marker = (head: string, s: string) => `${uid}-${head}-${s}`
  const enter = (id: string) => ({
    onMouseEnter: () => setHover(id),
    onMouseLeave: () => setHover((h) => (h === id ? null : h)),
    onClick: (ev: MouseEvent) => (ev.stopPropagation(), setSelected((s) => (s === id ? null : id))),
  })

  return (
    <div className="graphview">
      <div className="archlegend muted small">
        <span>Hover or click a participant to see its messages.</span>
        <span><Arrow d="M0 5 H22" head="solid" /> call</span>
        <span><Arrow d="M0 5 H22" head="open" dashed /> reply</span>
        <span><Arrow d="M0 5 H22" head="open" /> async</span>
        <DiffLegend />
      </div>
      <svg ref={svg} className="graph seq" width={layout.w} height={layout.h} viewBox={`0 0 ${layout.w} ${layout.h}`} onClick={() => setSelected(null)}>
        <defs>
          {SEVS.map((s) => (
            <g key={s}>
              <marker id={marker('solid', s)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 1 L9 5 L0 9 Z" className={s} />
              </marker>
              <marker id={marker('open', s)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M1 1 L9 5 L1 9" className={`open ${s}`} />
              </marker>
            </g>
          ))}
        </defs>
        {layout.participants.map((p) => (
          <line key={p.id} className={`lifeline ${sev(p.diff)}${near(p.id) ? '' : ' dim'}`} x1={p.x} y1={layout.head + 8} x2={p.x} y2={layout.h - 8} />
        ))}
        {layout.bars.map((b, i) => (
          <rect
            key={i}
            className={`seqbar ${sev(b.diff)}${!on || b.on === on ? '' : ' dim'}`}
            x={b.x}
            y={b.y}
            width={BAR}
            height={b.h}
          />
        ))}
        {layout.messages.map((m) => (
          <Message key={m.index} m={m} dim={!touches(m)} marker={(head) => `url(#${marker(head, sev(m.diff))})`} />
        ))}
        {layout.participants.map((p) => (
          <g
            key={p.id}
            data-id={p.id}
            className={`gnode seqhead diff-${p.diff ?? 'none'}${p.id === selected ? ' on' : ''}${near(p.id) ? '' : ' dim'}`}
            {...enter(p.id)}
          >
            <title>{`${p.diff ? `${DIFF_NAMES[p.diff]} · ` : ''}${p.label}${p.kind ? ` (${p.kind})` : ''}`}</title>
            <rect className="shape" x={p.x - p.w / 2} y={8} width={p.w} height={layout.head} rx={4} />
            {p.lines.map((l, i) => (
              <text key={i} x={p.x} y={8 + layout.head / 2 + LINE * (i - (p.lines.length - 1) / 2) - (p.kind ? LABEL_LINE / 2 : 0)} fontSize={FONT}>{l}</text>
            ))}
            {p.kind && <text className="kind" x={p.x} y={8 + layout.head / 2 + (LINE * p.lines.length) / 2}>{p.kind}</text>}
          </g>
        ))}
      </svg>
    </div>
  )
}

function Message({ m, dim, marker }: { m: PlacedMessage; dim: boolean; marker: (head: 'solid' | 'open') => string }) {
  const self = m.from === m.to
  const d = self ? `M${m.x1} ${m.y1} H${m.x1 + SELF_W} V${m.y2} H${m.x2}` : `M${m.x1} ${m.y1} H${m.x2}`
  const sev = `d-${m.diff ?? 'none'}`
  return (
    <g className={`seqmsg ${m.kind} ${sev}${dim ? ' dim' : ''}`}>
      <title>{`${m.diff ? `${DIFF_NAMES[m.diff]} · ` : ''}${KIND_NAMES[m.kind]} ${m.from} → ${m.to}`}</title>
      <path className={`gedge ${sev}`} d={d} markerEnd={marker(m.kind === 'call' ? 'solid' : 'open')} />
      {m.label.lines.map((l, i) => (
        <text
          key={i}
          className="seqlabel"
          x={m.label.x}
          y={m.label.y - LABEL_LINE * (m.label.lines.length - 1 - i)}
          textAnchor={m.label.anchor}
        >
          {l}
        </text>
      ))}
    </g>
  )
}

/** A sample arrow for the legend. */
function Arrow({ d, head, dashed }: { d: string; head: 'solid' | 'open'; dashed?: boolean }) {
  return (
    <svg className="seqsample" width="26" height="10" viewBox="0 0 26 10">
      <path d={d} className={dashed ? 'dashed' : ''} />
      {head === 'solid' ? <path d="M18 1 L25 5 L18 9 Z" className="solid" /> : <path d="M18 1 L25 5 L18 9" />}
    </svg>
  )
}
