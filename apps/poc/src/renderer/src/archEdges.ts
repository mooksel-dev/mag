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

/**
 * Routes arrows between measured boxes. An arrow leaves the bottom of its source and enters the top of its
 * target, or the other way round when the target sits above. Boxes on the same row are linked bottom to bottom.
 * When several arrows share a side of a box, their ends are spread across its width, ordered by where the
 * other end is, so they never meet in one point.
 */
export function routeEdges<E extends Edge>(edges: E[], boxes: Map<string, Box>): (E & { d: string })[] {
  const ends: { edge: E; a: Box; b: Box; out: Side; in: Side; sx: number; tx: number }[] = []
  for (const edge of edges) {
    const a = boxes.get(edge.from)
    const b = boxes.get(edge.to)
    if (!a || !b || edge.from === edge.to) continue
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

  return ends.map((e) => {
    const sy = e.out === 'bottom' ? e.a.y + e.a.h : e.a.y
    const ty = e.in === 'bottom' ? e.b.y + e.b.h : e.b.y
    const k = e.out === e.in ? 36 : Math.min(80, Math.max(28, Math.abs(ty - sy) / 2))
    const c1 = sy + (e.out === 'bottom' ? k : -k)
    const c2 = ty + (e.in === 'bottom' ? k : -k)
    const r = (n: number) => Math.round(n * 10) / 10
    return { ...e.edge, d: `M ${r(e.sx)} ${r(sy)} C ${r(e.sx)} ${r(c1)}, ${r(e.tx)} ${r(c2)}, ${r(e.tx)} ${r(ty)}` }
  })
}
