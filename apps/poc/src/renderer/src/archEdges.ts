/** Box position relative to the diagram, in px. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Edge {
  from: string
  to: string
}

type Side = 'top' | 'bottom'

const r = (n: number) => Math.round(n * 10) / 10

/** Neighbours on one row: their boxes overlap vertically and no other box of that row stands between them. */
function neighbours(a: Box, b: Box, boxes: Map<string, Box>) {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (overlap <= 0) return false
  const [l, rt] = a.x < b.x ? [a, b] : [b, a]
  for (const c of boxes.values()) {
    if (c === a || c === b) continue
    const row = Math.min(c.y + c.h, l.y + l.h) - Math.max(c.y, l.y) > 0
    if (row && c.x >= l.x + l.w && c.x + c.w <= rt.x) return false
  }
  return true
}

/**
 * Routes arrows between measured boxes. An arrow leaves the bottom of its source and enters the top of its
 * target, or the other way round when the target sits above. Neighbours on one row are linked by a straight arrow
 * between their facing sides; other boxes on the same row are linked bottom to bottom. When several arrows share
 * the top or bottom of a box, their ends are spread across its width, ordered by where the other end is, so they
 * never meet in one point. `mid` is the middle of the arrow, for a label.
 */
export function routeEdges<E extends Edge>(edges: E[], boxes: Map<string, Box>): (E & { d: string; mid: { x: number; y: number } })[] {
  const ends: { edge: E; a: Box; b: Box; out: Side; in: Side; sx: number; tx: number }[] = []
  const sides: { edge: E; a: Box; b: Box }[] = []
  for (const edge of edges) {
    const a = boxes.get(edge.from)
    const b = boxes.get(edge.to)
    if (!a || !b || edge.from === edge.to) continue
    if (neighbours(a, b, boxes)) {
      sides.push({ edge, a, b })
      continue
    }
    const down = b.y >= a.y + a.h
    const up = b.y + b.h <= a.y
    ends.push({ edge, a, b, out: up ? 'top' : 'bottom', in: down ? 'top' : 'bottom', sx: 0, tx: 0 })
  }

  const ports = new Map<string, { set: (x: number) => void; other: number }[]>()
  const port = (id: string, side: Side, set: (x: number) => void, other: Box) => {
    const k = `${id}:${side}`
    if (!ports.has(k)) ports.set(k, [])
    ports.get(k)!.push({ set, other: other.x + other.w / 2 })
  }
  for (const e of ends) {
    port(e.edge.from, e.out, (x) => (e.sx = x), e.b)
    port(e.edge.to, e.in, (x) => (e.tx = x), e.a)
  }
  for (const [k, list] of ports) {
    const box = boxes.get(k.slice(0, k.lastIndexOf(':')))!
    list.sort((p, q) => p.other - q.other)
    list.forEach((p, i) => p.set(box.x + (box.w * (i + 1)) / (list.length + 1)))
  }

  const routed = ends.map((e) => {
    const sy = e.out === 'bottom' ? e.a.y + e.a.h : e.a.y
    const ty = e.in === 'bottom' ? e.b.y + e.b.h : e.b.y
    const k = e.out === e.in ? 36 : Math.min(80, Math.max(28, Math.abs(ty - sy) / 2))
    const c1 = sy + (e.out === 'bottom' ? k : -k)
    const c2 = ty + (e.in === 'bottom' ? k : -k)
    // A cubic Bézier at t = 0.5.
    const mid = { x: r((e.sx + 3 * e.sx + 3 * e.tx + e.tx) / 8), y: r((sy + 3 * c1 + 3 * c2 + ty) / 8) }
    return { ...e.edge, d: `M ${r(e.sx)} ${r(sy)} C ${r(e.sx)} ${r(c1)}, ${r(e.tx)} ${r(c2)}, ${r(e.tx)} ${r(ty)}`, mid }
  })

  const straight = sides.map(({ edge, a, b }) => {
    const right = b.x > a.x
    const sx = right ? a.x + a.w : a.x
    const tx = right ? b.x : b.x + b.w
    // Both ways between the same pair: each arrow keeps to its own half.
    const back = sides.some((s) => s.edge.from === edge.to && s.edge.to === edge.from)
    const y = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 + (back ? (right ? -6 : 6) : 0)
    return { ...edge, d: `M ${r(sx)} ${r(y)} L ${r(tx)} ${r(y)}`, mid: { x: r((sx + tx) / 2), y: r(y) } }
  })

  return [...routed, ...straight]
}
