// Layout of node-and-arrow diagrams (Flowchart, State) with elkjs. Text is measured by estimate, so the layout runs
// without a DOM and the same wrapped lines are drawn as SVG text.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'

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
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
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
    },
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
    const points = (oe.sections ?? []).flatMap((s, i) => [...(i ? [] : [s.startPoint]), ...(s.bendPoints ?? []), s.endPoint])
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
