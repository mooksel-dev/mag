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
type Pt = { x: number; y: number }

const r = (n: number) => Math.round(n * 10) / 10

/** Clearance kept around a box an arrow passes by. */
const PAD = 4
/** How far an arrow keeps from the boxes beside a gap it goes through, when the gap is wide enough. */
const GAP = 8

/** The size of a count pill ("+2 ~1 −1") on an arrow. */
const PILL = { w: 64, h: 20 }

const inflate = (b: Box): Box => ({ x: b.x - PAD, y: b.y - PAD, w: b.w + 2 * PAD, h: b.h + 2 * PAD })

/** Whether the segment p–q crosses the inside of box b (Liang–Barsky clipping). */
function segHits(p: Pt, q: Pt, b: Box) {
  let t0 = 0
  let t1 = 1
  const dx = q.x - p.x
  const dy = q.y - p.y
  const clip = (den: number, num: number) => {
    if (den === 0) return num > 0
    const t = num / den
    if (den < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return clip(-dx, p.x - b.x) && clip(dx, b.x + b.w - p.x) && clip(-dy, p.y - b.y) && clip(dy, b.y + b.h - p.y) && t1 - t0 > 1e-6
}

const bezier = (p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt => {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  }
}

/** Points along a cubic curve, for hit tests and lengths. */
const sample = (p0: Pt, c1: Pt, c2: Pt, p3: Pt, n = 24) => Array.from({ length: n + 1 }, (_, i) => bezier(p0, c1, c2, p3, i / n))

const crosses = (pts: Pt[], obstacles: Box[]) => pts.some((p, i) => i > 0 && obstacles.some((b) => segHits(pts[i - 1], p, b)))

/** The point at fraction f of the length of a polyline. */
function along(pts: Pt[], f: number): Pt {
  const len = (i: number) => Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  let rest = pts.reduce((s, _, i) => (i ? s + len(i) : 0), 0) * f
  for (let i = 1; i < pts.length; i++) {
    const l = len(i)
    if (l >= rest && l > 0) {
      const t = rest / l
      return { x: r(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t), y: r(pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t) }
    }
    rest -= l
  }
  return { x: r(pts[0].x), y: r(pts[0].y) }
}

/**
 * A path from s down to t (s.y < t.y) that passes no obstacle. The boxes standing in the way are grouped into
 * horizontal bands; the path crosses each band straight down through a free gap, the one nearest to the straight
 * line from s to t, and bends between bands, where nothing stands. Returns the points it goes through.
 */
function detour(s: Pt, t: Pt, obstacles: Box[]): Pt[] {
  const inWay = obstacles.filter((b) => b.y < t.y && b.y + b.h > s.y).sort((p, q) => p.y - q.y)
  const bands: { top: number; bottom: number; boxes: Box[] }[] = []
  for (const b of inWay) {
    const last = bands[bands.length - 1]
    if (last && b.y < last.bottom) {
      last.bottom = Math.max(last.bottom, b.y + b.h)
      last.boxes.push(b)
    } else bands.push({ top: b.y, bottom: b.y + b.h, boxes: [b] })
  }
  const pts: Pt[] = [s]
  for (const band of bands) {
    const top = Math.max(band.top, s.y)
    const bottom = Math.min(band.bottom, t.y)
    // Where the straight line would be; a band touching an end keeps to that end.
    const ideal = top <= s.y ? s.x : bottom >= t.y ? t.x : s.x + ((t.x - s.x) * ((top + bottom) / 2 - s.y)) / (t.y - s.y)
    const xs = band.boxes.map((b) => [b.x, b.x + b.w]).sort((p, q) => p[0] - q[0])
    const gaps: [number, number][] = []
    let from = -Infinity
    for (const [l, rt] of xs) {
      if (l > from) gaps.push([from, l])
      from = Math.max(from, rt)
    }
    gaps.push([from, Infinity])
    let x = ideal
    let best = Infinity
    for (const [l, rt] of gaps) {
      const m = Math.min(GAP, (rt - l) / 2)
      const c = Math.min(Math.max(ideal, l + m), rt - m)
      if (Math.abs(c - ideal) < best) [x, best] = [c, Math.abs(c - ideal)]
    }
    pts.push({ x, y: top }, { x, y: bottom })
  }
  pts.push(t)
  return pts
}

/** A smooth path through points going one way vertically: straight where x stays, an S-bend where it shifts. */
function smooth(pts: Pt[]) {
  let d = `M ${r(pts[0].x)} ${r(pts[0].y)}`
  const line: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [p, q] = [pts[i - 1], pts[i]]
    if (p.x === q.x && p.y === q.y) continue
    if (Math.abs(p.x - q.x) < 0.05) {
      d += ` L ${r(q.x)} ${r(q.y)}`
      line.push(q)
      continue
    }
    const my = (p.y + q.y) / 2
    const c1 = { x: p.x, y: my }
    const c2 = { x: q.x, y: my }
    d += ` C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(q.x)} ${r(q.y)}`
    line.push(...sample(p, c1, c2, q, 12).slice(1))
  }
  return { d, mid: along(line, 0.5), line }
}

/**
 * An arrow from the bottom of one box to the bottom of another (or top to top) that goes below (above) every box
 * standing in its way: down, along a free channel, and up again, with rounded corners.
 */
function under(s: Pt, t: Pt, side: Side, obstacles: Box[]) {
  const dir = side === 'bottom' ? 1 : -1
  const [l, rt] = [Math.min(s.x, t.x), Math.max(s.x, t.x)]
  let ch = dir > 0 ? Math.max(s.y, t.y) + GAP : Math.min(s.y, t.y) - GAP
  for (let moved = true; moved; ) {
    moved = false
    for (const b of obstacles) {
      if (b.x >= rt || b.x + b.w <= l) continue
      // A box reaching past the channel, between the ends and the channel, pushes the channel beyond it.
      const reach = dir > 0 ? b.y < ch && b.y + b.h > Math.min(s.y, t.y) : b.y + b.h > ch && b.y < Math.max(s.y, t.y)
      const next = dir > 0 ? b.y + b.h + GAP : b.y - GAP
      if (reach && next * dir > ch * dir) [ch, moved] = [next, true]
    }
  }
  const k = Math.min(8, Math.abs(ch - s.y), Math.abs(ch - t.y), (rt - l) / 2)
  const hx = t.x > s.x ? k : -k
  const d =
    `M ${r(s.x)} ${r(s.y)} L ${r(s.x)} ${r(ch - dir * k)} Q ${r(s.x)} ${r(ch)}, ${r(s.x + hx)} ${r(ch)}` +
    ` L ${r(t.x - hx)} ${r(ch)} Q ${r(t.x)} ${r(ch)}, ${r(t.x)} ${r(ch - dir * k)} L ${r(t.x)} ${r(t.y)}`
  return { d, mid: { x: r((s.x + t.x) / 2), y: r(ch) }, line: [s, { x: s.x, y: ch }, { x: t.x, y: ch }, t] }
}

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
 * never meet in one point. An arrow never crosses a box other than its two ends: when the plain curve would, it
 * goes through the gaps beside the boxes in the way, or below (above) them for a bottom-to-bottom (top-to-top)
 * arrow. Several arrows between the same neighbours are drawn on parallel lines. `mid` is the middle of the arrow,
 * for a label of size `pill`: moved along the arrow off boxes and the labels of other arrows when there is room.
 */
export function routeEdges<E extends Edge>(edges: E[], boxes: Map<string, Box>, pill = PILL): (E & { d: string; mid: { x: number; y: number } })[] {
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

  const others = (a: Box, b: Box) => [...boxes.values()].filter((c) => c !== a && c !== b).map(inflate)

  const routed = ends.map((e) => {
    const sy = e.out === 'bottom' ? e.a.y + e.a.h : e.a.y
    const ty = e.in === 'bottom' ? e.b.y + e.b.h : e.b.y
    const k = e.out === e.in ? 36 : Math.min(80, Math.max(28, Math.abs(ty - sy) / 2))
    const c1 = sy + (e.out === 'bottom' ? k : -k)
    const c2 = ty + (e.in === 'bottom' ? k : -k)
    const s = { x: e.sx, y: sy }
    const t = { x: e.tx, y: ty }
    const obstacles = others(e.a, e.b)
    if (!crosses(sample(s, { x: e.sx, y: c1 }, { x: e.tx, y: c2 }, t), obstacles)) {
      // A cubic Bézier at t = 0.5.
      const mid = { x: r((e.sx + 3 * e.sx + 3 * e.tx + e.tx) / 8), y: r((sy + 3 * c1 + 3 * c2 + ty) / 8) }
      const line = sample(s, { x: e.sx, y: c1 }, { x: e.tx, y: c2 }, t)
      return { ...e.edge, d: `M ${r(e.sx)} ${r(sy)} C ${r(e.sx)} ${r(c1)}, ${r(e.tx)} ${r(c2)}, ${r(e.tx)} ${r(ty)}`, mid, line }
    }
    if (e.out === e.in) return { ...e.edge, ...under(s, t, e.out, obstacles) }
    // The curve hits a box: go through the gaps beside the boxes in the way.
    const pts = sy < ty ? detour(s, t, obstacles) : detour(t, s, obstacles).reverse()
    return { ...e.edge, ...smooth(pts) }
  })

  const pairs = new Map<string, E[]>()
  for (const { edge } of sides) {
    const k = [edge.from, edge.to].sort().join('\n')
    if (!pairs.has(k)) pairs.set(k, [])
    pairs.get(k)!.push(edge)
  }
  const straight = sides.map(({ edge, a, b }) => {
    const right = b.x > a.x
    const sx = right ? a.x + a.w : a.x
    const tx = right ? b.x : b.x + b.w
    // Several arrows between the same pair (both ways, or a call and a move): each keeps to its own line.
    const pair = pairs.get([edge.from, edge.to].sort().join('\n'))!
    const shift = (pair.indexOf(edge) - (pair.length - 1) / 2) * 12
    const y = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 + shift
    return { ...edge, d: `M ${r(sx)} ${r(y)} L ${r(tx)} ${r(y)}`, mid: { x: r((sx + tx) / 2), y: r(y) }, line: [{ x: sx, y }, { x: tx, y }] }
  })

  return place([...routed, ...straight], [...boxes.values()], pill)
}

/** Where along an arrow its label may go when the middle is taken, nearest to the middle first. */
const SPOTS = [0.4, 0.6, 0.3, 0.7, 0.2, 0.8]

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Moves the label of each arrow (`mid`) along its path off the boxes and off the labels placed before it: the middle
 * when it is free, else the free spot nearest to it. An arrow with no free spot keeps its middle.
 */
function place<R extends { mid: Pt; line: Pt[] }>(routes: R[], boxes: Box[], pill: { w: number; h: number }) {
  const taken: Box[] = []
  const rect = (p: Pt): Box => ({ x: p.x - pill.w / 2, y: p.y - pill.h / 2, w: pill.w, h: pill.h })
  return routes.map((route) => {
    const spots = [route.mid, ...SPOTS.map((f) => along(route.line, f))]
    const mid = spots.find((p) => !boxes.some((b) => overlaps(rect(p), b)) && !taken.some((b) => overlaps(rect(p), b))) ?? route.mid
    taken.push(rect(mid))
    return { ...route, mid }
  })
}
