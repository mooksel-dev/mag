// Layout of a Sequence diagram: a grid of participants (columns) × messages (rows), with activation bars from
// sequenceActivations. Text is measured by estimate, like graphLayout.
import { sequenceActivations, type Activation, type DiffMark, type MessageKind, type SequenceDiagram } from '@mag/core'
import { FONT, LABEL_FONT, LABEL_LINE, LINE, textWidth, wrap } from './graphLayout.ts'

export const BAR = 10 // width of an activation bar
const NEST = 5 // shift of a nested bar
const MARGIN = 8
const GAP = 36 // between participant boxes
const HEAD_PAD = 10
export const SELF_W = 26 // loop of a message to itself
const SELF_H = 16
const ROW_GAP = 16

export interface PlacedParticipant {
  id: string
  label: string
  kind?: string
  diff?: DiffMark
  /** Centre of the lifeline. */
  x: number
  w: number
  lines: string[]
}

export interface PlacedMessage {
  index: number
  from: string
  to: string
  kind: MessageKind
  diff?: DiffMark
  x1: number
  x2: number
  /** The arrow leaves at y1 and arrives at y2; they differ only for a message to itself. */
  y1: number
  y2: number
  label: { x: number; y: number; lines: string[]; anchor: 'middle' | 'start' }
}

export interface PlacedBar extends Activation {
  x: number
  y: number
  h: number
}

export interface SequenceLayout {
  w: number
  h: number
  /** Height of the participant boxes; lifelines start below them. */
  head: number
  participants: PlacedParticipant[]
  messages: PlacedMessage[]
  bars: PlacedBar[]
}

/** Offset from a lifeline to the side of the bar at `depth` (-1: no bar, the lifeline itself) facing `side`. */
const edge = (depth: number, side: 1 | -1) => (depth < 0 ? 0 : depth * NEST + (side * BAR) / 2)

export function layoutSequence(d: SequenceDiagram): SequenceLayout {
  const col = new Map(d.participants.map((p, i) => [p.id, i]))
  // Messages between unknown participants are dropped; validateDiagram rejects them anyway.
  const msgs = d.messages.map((m, index) => ({ ...m, index })).filter((m) => col.has(m.from) && col.has(m.to))
  const { bars, ends } = sequenceActivations({ ...d, messages: msgs })

  const parts = d.participants.map((p) => {
    const lines = wrap(p.label, 20)
    const kindW = p.kind ? textWidth([p.kind], LABEL_FONT) : 0
    return { ...p, lines, w: Math.max(90, Math.round(Math.max(textWidth(lines, FONT), kindW) + HEAD_PAD * 2)) }
  })
  const head = Math.max(0, ...parts.map((p) => p.lines.length * LINE + (p.kind ? LABEL_LINE : 0))) + HEAD_PAD * 2

  // Distances between neighbouring lifelines: the boxes, then room for the labels of the messages between them.
  const gaps = parts.slice(1).map((p, i) => (parts[i].w + p.w) / 2 + GAP)
  let tail = 0 // room right of the last lifeline
  const labels = msgs.map((m) => wrap(`${m.index + 1}. ${m.text}`, 40))
  const spans = msgs
    .map((m, i) => ({ a: Math.min(col.get(m.from)!, col.get(m.to)!), b: Math.max(col.get(m.from)!, col.get(m.to)!), w: textWidth(labels[i], LABEL_FONT) }))
    .sort((x, y) => x.b - x.a - (y.b - y.a))
  for (const s of spans) {
    if (s.a === s.b) {
      const need = BAR + Math.max(SELF_W, s.w) + 16
      if (s.a < gaps.length) gaps[s.a] = Math.max(gaps[s.a], need + parts[s.a + 1].w / 2)
      else tail = Math.max(tail, need)
      continue
    }
    const need = s.w + BAR * 2 + 24
    const have = gaps.slice(s.a, s.b).reduce((x, y) => x + y, 0)
    if (have < need) for (let g = s.a; g < s.b; g++) gaps[g] += (need - have) / (s.b - s.a)
  }
  const xs = [MARGIN + (parts[0]?.w ?? 0) / 2]
  for (const g of gaps) xs.push(xs[xs.length - 1] + g)
  const participants: PlacedParticipant[] = parts.map((p, i) => ({ ...p, x: Math.round(xs[i]) }))
  const last = participants[participants.length - 1]
  const w = last ? Math.round(Math.max(last.x + last.w / 2, last.x + tail) + MARGIN) : MARGIN * 2

  let y = MARGIN + head + 20
  const messages: PlacedMessage[] = msgs.map((m, i) => {
    const lines = labels[i]
    const a = participants[col.get(m.from)!].x
    const b = participants[col.get(m.to)!].x
    y += lines.length * LABEL_LINE + 4
    const y1 = y
    let placed: PlacedMessage
    if (m.from === m.to) {
      const x1 = a + edge(ends[i].from, 1)
      placed = { ...m, x1, x2: a + edge(ends[i].to, 1), y1, y2: y1 + SELF_H, label: { x: x1 + 4, y: y1 - 3, lines, anchor: 'start' } }
    } else {
      const dir = b > a ? 1 : -1
      const x1 = a + edge(ends[i].from, dir)
      const x2 = b + edge(ends[i].to, dir === 1 ? -1 : 1)
      placed = { ...m, x1, x2, y1, y2: y1, label: { x: (x1 + x2) / 2, y: y1 - 3, lines, anchor: 'middle' } }
    }
    y = placed.y2 + ROW_GAP
    return placed
  })
  const bottom = y + 4

  const placedBars: PlacedBar[] = bars.map((bar) => {
    const top = messages[bar.from].y2
    const end = bar.to < messages.length ? messages[bar.to].y1 : bottom - 6
    return { ...bar, x: participants[col.get(bar.on)!].x + bar.depth * NEST - BAR / 2, y: top, h: Math.max(8, end - top) }
  })
  return { w, h: bottom + MARGIN, head, participants, messages, bars: placedBars }
}
