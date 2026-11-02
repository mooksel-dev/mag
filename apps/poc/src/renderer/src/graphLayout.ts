// Layout of node-and-arrow diagrams (Flowchart, State, Data) with elkjs. Text is measured by estimate, so the layout
// runs without a DOM and the same wrapped lines are drawn as SVG text.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import { fieldMoves, type DataDiagram } from '@mag/core'

/** start/end: pill; step/state: rounded box; decision: diamond; initial: filled dot; final: bullseye. */
export type GraphShape = 'start' | 'step' | 'decision' | 'end' | 'state' | 'initial' | 'final'

export interface GraphNode {
  id: string
  label: string
  shape: GraphShape
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  label?: string
}

export interface Point {
  x: number
  y: number
}

export interface PlacedNode extends GraphNode {
  x: number
  y: number
  w: number
  h: number
  lines: string[]
}

export interface PlacedEdge extends GraphEdge {
  points: Point[]
  /** Label box, top-left corner. */
  labelAt?: Point & { w: number; h: number; lines: string[] }
}

export interface GraphLayout {
  w: number
  h: number
  nodes: PlacedNode[]
  edges: PlacedEdge[]
}

export const FONT = 13
export const LINE = 17
export const LABEL_FONT = 11
export const LABEL_LINE = 14
const CHAR = 0.6 // average glyph width, in ems
const PAD = { x: 14, y: 10 }

/** Words wrapped into lines of at most `max` characters; a longer word stays whole on its own line. */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > max) {
      lines.push(cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur || !lines.length) lines.push(cur)
  return lines
}

export const textWidth = (lines: string[], font: number) => Math.max(...lines.map((l) => l.length)) * font * CHAR

/** Size of a node and its wrapped label. A diamond needs about twice the text box to hold it inside. */
export function measureNode(n: GraphNode): { w: number; h: number; lines: string[] } {
  if (n.shape === 'initial') return { w: 18, h: 18, lines: [] }
  if (n.shape === 'final') return { w: 24, h: 24, lines: [] }
  const lines = wrap(n.label, n.shape === 'decision' ? 18 : 24)
  const tw = textWidth(lines, FONT)
  const th = lines.length * LINE
  if (n.shape === 'decision') return { w: Math.max(90, Math.round(tw * 1.6 + PAD.x)), h: Math.max(56, Math.round(th * 1.8 + PAD.y)), lines }
  const pill = n.shape === 'start' || n.shape === 'end'
  return { w: Math.max(pill ? 80 : 100, Math.round(tw + PAD.x * 2 + (pill ? th : 0))), h: Math.round(th + PAD.y * 2), lines }
}

export function measureLabel(text: string): { w: number; h: number; lines: string[] } {
  const lines = wrap(text, 28)
  return { w: Math.round(textWidth(lines, LABEL_FONT) + 8), h: lines.length * LABEL_LINE + 4, lines }
}

/**
 * Moves the end of a route from the bounding box of a diamond or a circle onto its outline, along the last segment.
 * `end` is the point on the box, `prev` the point before it.
 */
export function clipToShape(end: Point, prev: Point, box: { x: number; y: number; w: number; h: number }, shape: GraphShape): Point {
  if (shape !== 'decision' && shape !== 'initial' && shape !== 'final') return end
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const hw = box.w / 2
  const hh = box.h / 2
  const vertical = Math.abs(end.x - prev.x) < Math.abs(end.y - prev.y)
  // Offset from the center along the segment's axis to the outline, given the offset across it.
  const reach = (across: number, half: number, otherHalf: number) => {
    const a = Math.abs(across)
    if (a > half) return null
    return shape === 'decision' ? otherHalf * (1 - a / half) : Math.sqrt(half * half - a * a)
  }
  if (vertical) {
    const d = reach(end.x - cx, hw, hh)
    if (d === null) return end
    return { x: end.x, y: end.y < cy ? cy - d : cy + d }
  }
  const d = reach(end.y - cy, hh, hw)
  if (d === null) return end
  return { x: end.x < cx ? cx - d : cx + d, y: end.y }
}

/** An SVG path through the points with rounded corners. */
export function pathOf(points: Point[], radius = 6): string {
  if (!points.length) return ''
  const r = (n: number) => Math.round(n * 10) / 10
  let d = `M${r(points[0].x)} ${r(points[0].y)}`
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const next = points[i + 1]
    if (!next) {
      d += ` L${r(p.x)} ${r(p.y)}`
      break
    }
    const prev = points[i - 1]
    const lin = Math.hypot(p.x - prev.x, p.y - prev.y)
    const lout = Math.hypot(next.x - p.x, next.y - p.y)
    const k = Math.min(radius, lin / 2, lout / 2)
    if (!k) {
      d += ` L${r(p.x)} ${r(p.y)}`
      continue
    }
    const a = { x: p.x + ((prev.x - p.x) / lin) * k, y: p.y + ((prev.y - p.y) / lin) * k }
    const b = { x: p.x + ((next.x - p.x) / lout) * k, y: p.y + ((next.y - p.y) / lout) * k }
    d += ` L${r(a.x)} ${r(a.y)} Q${r(p.x)} ${r(p.y)} ${r(b.x)} ${r(b.y)}`
  }
  return d
}

let elk: InstanceType<typeof ELK> | null = null

const LAYERED = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '36',
  'elk.layered.spacing.nodeNodeBetweenLayers': '44',
  'elk.spacing.edgeLabel': '4',
  'elk.spacing.edgeNode': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
  'elk.edgeLabels.placement': 'CENTER',
  'elk.padding': '[top=12,left=12,bottom=12,right=12]',
}

/** Route of an ELK edge as one list of points. */
const routeOf = (e: ElkExtendedEdge): Point[] => (e.sections ?? []).flatMap((s, i) => [...(i ? [] : [s.startPoint]), ...(s.bendPoints ?? []), s.endPoint])

/**
 * Layered layout, top-down or left-to-right. The input order of nodes and edges is kept where the algorithm allows,
 * so the diagram reads in the order the agent wrote it.
 */
export async function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], direction: 'DOWN' | 'RIGHT' = 'DOWN'): Promise<GraphLayout> {
  elk ??= new ELK()
  const sized = new Map(nodes.map((n) => [n.id, measureNode(n)]))
  const labels = new Map(edges.filter((e) => e.label).map((e) => [e.id, measureLabel(e.label!)]))
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: { ...LAYERED, 'elk.direction': direction },
    children: nodes.map((n) => ({ id: n.id, width: sized.get(n.id)!.w, height: sized.get(n.id)!.h })),
    edges: edges.map((e) => {
      const l = labels.get(e.id)
      return { id: e.id, sources: [e.from], targets: [e.to], labels: l ? [{ text: e.label, width: l.w, height: l.h }] : [] }
    }),
  }
  const out = await elk.layout(graph)
  const placed = new Map<string, PlacedNode>()
  for (const c of out.children ?? []) {
    const n = nodes.find((x) => x.id === c.id)!
    const s = sized.get(c.id)!
    placed.set(c.id, { ...n, x: c.x ?? 0, y: c.y ?? 0, w: s.w, h: s.h, lines: s.lines })
  }
  const byId = new Map(edges.map((e) => [e.id, e]))
  const placedEdges = ((out.edges ?? []) as ElkExtendedEdge[]).map((oe): PlacedEdge => {
    const e = byId.get(oe.id)!
    const points = routeOf(oe)
    if (points.length >= 2) {
      const from = placed.get(e.from)!
      const to = placed.get(e.to)!
      points[0] = clipToShape(points[0], points[1], from, from.shape)
      points[points.length - 1] = clipToShape(points[points.length - 1], points[points.length - 2], to, to.shape)
    }
    const ol = oe.labels?.[0]
    const l = labels.get(e.id)
    return { ...e, points, labelAt: ol && l ? { x: ol.x ?? 0, y: ol.y ?? 0, w: l.w, h: l.h, lines: l.lines } : undefined }
  })
  return { w: out.width ?? 0, h: out.height ?? 0, nodes: [...placed.values()], edges: placedEdges }
}

// Data diagram: an entity is a box with a header (its name, then a line each for kind, old id, note), one row per
// field and one per index; entities stand in a box of the module that owns them (povnyi-diff-nabir-pov-iazanykh.3).
export const DATA_HEAD = 22
export const DATA_SUB = 14
export const DATA_ROW = 18
export const DATA_NOTE = 13
const MONO = 12 // field rows, ui-monospace
const MONO_CHAR = 0.62
const NOTE_FONT = 10.5

/** A field row: its top and height (a row with a note is taller), and the note, wrapped. */
export interface PlacedRow {
  y: number
  h: number
  notes: string[]
}

export interface PlacedEntity {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Lines under the name: the kind, "was <old id>" for a moved entity, the note. */
  sub: string[]
  rows: PlacedRow[]
  /** One row per index, after the fields: its top and its text. */
  indexRows: { y: number; text: string }[]
}

/** The box of a module that owns entities: its id, where it stands. */
export interface PlacedGroup {
  module: string
  x: number
  y: number
  w: number
  h: number
}

export interface PlacedRelation {
  /** Index in diagram.relations. */
  index: number
  points: Point[]
  labelAt?: Point & { w: number; h: number; lines: string[] }
}

export interface DataLayout {
  w: number
  h: number
  entities: PlacedEntity[]
  relations: PlacedRelation[]
  groups: PlacedGroup[]
}

/** The line of an index: "unique (user_id, inbox_id, domain)" or "index (alias)". */
export const indexText = (i: NonNullable<DataDiagram['entities'][number]['indexes']>[number]) => `${i.unique ? 'unique' : 'index'} (${i.fields.join(', ')})`
/** The height of the label on top of a module's box. */
export const GROUP_HEAD = 22

/** Key of a field in fieldNotes. */
export const fieldKey = (entity: string, field: string) => `${entity}\u0000${field}`

/** The note line of a field: its own note, its old name, where a moved field came from, where a field moved to. */
export function fieldNotes(d: DataDiagram): Map<string, string> {
  const notes = new Map<string, string>()
  const add = (k: string, text: string) => notes.set(k, notes.has(k) ? `${notes.get(k)} · ${text}` : text)
  for (const e of d.entities)
    for (const f of e.fields) {
      if (f.note) add(fieldKey(e.id, f.name), f.note)
      // Renamed in its entity (Decision 12): from is "<this entity>.<old name>".
      if (f.diff === 'move' && f.from?.startsWith(`${e.id}.`) && !e.fields.some((x) => `${e.id}.${x.name}` === f.from)) add(fieldKey(e.id, f.name), `renamed from ${f.from.slice(e.id.length + 1)}`)
    }
  for (const m of fieldMoves(d)) {
    add(fieldKey(m.to.entity, m.to.field), `moved from ${m.from.entity}.${m.from.field}`)
    add(fieldKey(m.from.entity, m.from.field), `moved to ${m.to.entity}.${m.to.field}`)
  }
  return notes
}

/** The relation label: its kind, the field holding it and the label. */
export const relationText = (r: DataDiagram['relations'][number]) => [r.kind, r.field, r.label].filter(Boolean).join(' · ')

/**
 * Entities left to right with elkjs. Each field row has its own height, so relations leave from the row of their
 * field. A field move pulls its two entities next to each other with an edge that is laid out but not drawn; the
 * renderer draws the move between the two rows.
 */
export async function layoutData(d: DataDiagram): Promise<DataLayout> {
  elk ??= new ELK()
  const notes = fieldNotes(d)
  const sized = d.entities.map((e) => {
    const sub = [e.kind, ...(e.diff === 'move' && e.from ? [`was ${e.from}`] : []), ...(e.note ? wrap(e.note, 40) : [])]
    let y = DATA_HEAD + sub.length * DATA_SUB + 6
    let wide = Math.max(e.name.length * FONT * CHAR, textWidth(sub, NOTE_FONT))
    const rows = e.fields.map((f): PlacedRow => {
      const n = notes.get(fieldKey(e.id, f.name))
      const lines = n ? wrap(n, 44) : []
      // "+ name  type": the sign, a gap between name and type.
      wide = Math.max(wide, (f.name.length + f.type.length + 5) * MONO * MONO_CHAR, lines.length ? textWidth(lines, NOTE_FONT) + 12 : 0)
      const row = { y, h: DATA_ROW + lines.length * DATA_NOTE, notes: lines }
      y += row.h
      return row
    })
    if (e.indexes?.length) y += 6
    const indexRows = (e.indexes ?? []).map((i) => {
      const text = indexText(i)
      wide = Math.max(wide, (text.length + 3) * MONO * MONO_CHAR)
      const row = { y, text }
      y += DATA_ROW
      return row
    })
    return { id: e.id, w: Math.max(180, Math.round(wide + PAD.x * 2)), h: y + 6, sub, rows, indexRows }
  })
  const byId = new Map(sized.map((s) => [s.id, s]))
  const ports = new Map<number, string>()
  const labels = d.relations.map((r) => measureLabel(relationText(r)))
  const node = (s: (typeof sized)[number]): ElkNode => {
    const e = d.entities.find((x) => x.id === s.id)!
    const own = d.relations.flatMap((r, i) => {
      const at = r.field && r.from === s.id ? e.fields.findIndex((f) => f.name === r.field) : -1
      if (at < 0) return []
      const id = `p${i}`
      ports.set(i, id)
      return [{ id, width: 0, height: 0, x: s.w, y: s.rows[at].y + DATA_ROW / 2, layoutOptions: { 'elk.port.side': 'EAST' } }]
    })
    return { id: s.id, width: s.w, height: s.h, ports: own, layoutOptions: { 'elk.portConstraints': own.length ? 'FIXED_POS' : 'UNDEFINED' } }
  }
  // Entities of one module stand in its box; the boxes and the entities without a module are laid out together.
  const modules = [...new Set(d.entities.map((e) => e.module).filter((m): m is string => !!m))]
  const moduleOf = new Map(d.entities.map((e) => [e.id, e.module]))
  const group = (m: string) => `\u0000group:${m}`
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      ...LAYERED,
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.json.shapeCoords': 'ROOT',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: [
      ...modules.map((m) => ({
        id: group(m),
        layoutOptions: { 'elk.padding': `[top=${GROUP_HEAD + 8},left=14,bottom=14,right=14]` },
        children: sized.filter((s) => moduleOf.get(s.id) === m).map(node),
      })),
      ...sized.filter((s) => !moduleOf.get(s.id)).map(node),
    ],
    edges: [
      ...d.relations.flatMap((r, i) =>
        byId.has(r.from) && byId.has(r.to)
          ? [{ id: `r${i}`, sources: [ports.get(i) ?? r.from], targets: [r.to], labels: [{ text: relationText(r), width: labels[i].w, height: labels[i].h }] }]
          : [],
      ),
      ...fieldMoves(d).map((m, i) => ({ id: `m${i}`, sources: [m.from.entity], targets: [m.to.entity] })),
    ],
  }
  const out = await elk.layout(graph)
  const groups: PlacedGroup[] = []
  const entities: PlacedEntity[] = []
  for (const c of out.children ?? []) {
    if (c.id.startsWith(group(''))) groups.push({ module: c.id.slice(group('').length), x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 })
    for (const x of c.id.startsWith(group('')) ? (c.children ?? []) : [c]) {
      const s = byId.get(x.id)!
      const top = x.y ?? 0
      entities.push({ id: s.id, x: x.x ?? 0, y: top, w: s.w, h: s.h, sub: s.sub, rows: s.rows.map((r) => ({ ...r, y: top + r.y })), indexRows: s.indexRows.map((r) => ({ ...r, y: top + r.y })) })
    }
  }
  // In the order of the diagram, as before modules.
  const order = new Map(d.entities.map((e, i) => [e.id, i]))
  entities.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  const relations = ((out.edges ?? []) as ElkExtendedEdge[])
    .filter((oe) => oe.id.startsWith('r'))
    .map((oe): PlacedRelation => {
      const index = Number(oe.id.slice(1))
      const ol = oe.labels?.[0]
      const l = labels[index]
      return { index, points: routeOf(oe), labelAt: ol ? { x: ol.x ?? 0, y: ol.y ?? 0, w: l.w, h: l.h, lines: l.lines } : undefined }
    })
  return { w: out.width ?? 0, h: out.height ?? 0, entities, relations, groups }
}

/**
 * The dashed line of a field move, from the side of the source row facing the target to the facing side of the
 * target row, as a cubic curve.
 */
export function movePath(from: PlacedEntity, fromRow: PlacedRow, to: PlacedEntity, toRow: PlacedRow): string {
  const y1 = fromRow.y + DATA_ROW / 2
  const y2 = toRow.y + DATA_ROW / 2
  const right = from.x + from.w / 2 <= to.x + to.w / 2
  const x1 = right ? from.x + from.w : from.x
  const x2 = right ? to.x : to.x + to.w
  const bend = Math.max(30, Math.abs(x2 - x1) / 2) * (right ? 1 : -1)
  const r = (n: number) => Math.round(n * 10) / 10
  return `M${r(x1)} ${r(y1)} C${r(x1 + bend)} ${r(y1)} ${r(x2 - bend)} ${r(y2)} ${r(x2)} ${r(y2)}`
}
