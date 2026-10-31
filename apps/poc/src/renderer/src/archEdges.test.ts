import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeEdges, type Box } from './archEdges.ts'

const ends = (d: string) => {
  const n = d.match(/-?[\d.]+/g)!.map(Number)
  return { sx: n[0], sy: n[1], tx: n[6], ty: n[7] }
}

const boxes = new Map<string, Box>([
  ['ui', { x: 0, y: 0, w: 200, h: 60 }],
  ['jobs', { x: 220, y: 0, w: 200, h: 60 }],
  ['svc', { x: 0, y: 120, w: 200, h: 60 }],
  ['svc2', { x: 220, y: 120, w: 200, h: 60 }],
])

test('a downward arrow leaves the bottom of the source and enters the top of the target', () => {
  const [r] = routeEdges([{ from: 'ui', to: 'svc' }], boxes)
  assert.deepEqual(ends(r.d), { sx: 100, sy: 60, tx: 100, ty: 120 })
  assert.deepEqual(r.mid, { x: 100, y: 90 })
})

test('an upward arrow leaves the top and enters the bottom', () => {
  const [r] = routeEdges([{ from: 'svc', to: 'ui' }], boxes)
  assert.deepEqual(ends(r.d), { sx: 100, sy: 120, tx: 100, ty: 60 })
})

test('neighbours on one row are linked side to side by a straight arrow', () => {
  const [r] = routeEdges([{ from: 'svc', to: 'svc2' }], boxes)
  assert.equal(r.d, 'M 200 150 L 220 150')
  assert.deepEqual(r.mid, { x: 210, y: 150 })
  const [back] = routeEdges([{ from: 'svc2', to: 'svc' }], boxes)
  assert.equal(back.d, 'M 220 150 L 200 150')
})

test('arrows both ways between neighbours keep apart', () => {
  const rs = routeEdges([{ from: 'svc', to: 'svc2' }, { from: 'svc2', to: 'svc' }], boxes)
  assert.deepEqual(rs.map((r) => r.d), ['M 200 144 L 220 144', 'M 220 156 L 200 156'])
})

test('boxes on the same row with one between are linked bottom to bottom', () => {
  const row = new Map(boxes).set('svc3', { x: 440, y: 120, w: 200, h: 60 })
  const [r] = routeEdges([{ from: 'svc', to: 'svc3' }], row)
  const e = ends(r.d)
  assert.equal(e.sy, 180)
  assert.equal(e.ty, 180)
  assert.equal(r.mid.y, 207)
})

test('several arrows into one box get separate entry points, ordered by their source', () => {
  const rs = routeEdges(
    [
      { from: 'jobs', to: 'svc' },
      { from: 'ui', to: 'svc' },
    ],
    boxes,
  )
  const fromUi = ends(rs.find((r) => r.from === 'ui')!.d)
  const fromJobs = ends(rs.find((r) => r.from === 'jobs')!.d)
  assert.ok(Math.abs(fromUi.tx - 200 / 3) < 0.1)
  assert.ok(Math.abs(fromJobs.tx - 400 / 3) < 0.1)
})

test('edges with an unmeasured box or to itself are skipped, extra fields are kept', () => {
  const rs = routeEdges(
    [
      { from: 'ui', to: 'missing', sev: 'ok' },
      { from: 'ui', to: 'ui', sev: 'ok' },
      { from: 'ui', to: 'svc', sev: 'error' },
    ],
    boxes,
  )
  assert.equal(rs.length, 1)
  assert.equal(rs[0].sev, 'error')
})

type P = { x: number; y: number }

/** The points a path goes through: its M/L points, and its C/Q curves sampled finely. */
function trace(d: string): P[] {
  const pts: P[] = []
  for (const [, cmd, args] of d.matchAll(/([MLCQ])([^MLCQ]*)/g)) {
    const n = args.match(/-?[\d.]+/g)!.map(Number)
    const xy = Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[2 * i], y: n[2 * i + 1] }))
    if (cmd === 'M' || cmd === 'L') {
      pts.push(...xy)
      continue
    }
    const p0 = pts[pts.length - 1]
    const ctl = [p0, ...xy]
    for (let i = 1; i <= 40; i++) {
      // De Casteljau on the control points.
      let q = ctl
      while (q.length > 1) q = q.slice(1).map((p, j) => ({ x: q[j].x + (p.x - q[j].x) * (i / 40), y: q[j].y + (p.y - q[j].y) * (i / 40) }))
      pts.push(q[0])
    }
  }
  return pts
}

/** Ids of the boxes a path passes through (between its points, finely). */
function hits(d: string, boxes: Map<string, Box>, except: string[]) {
  const pts = trace(d)
  const out = new Set<string>()
  for (let i = 1; i < pts.length; i++) {
    for (let k = 0; k <= 10; k++) {
      const x = pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * k) / 10
      const y = pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * k) / 10
      for (const [id, b] of boxes) if (!except.includes(id) && x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) out.add(id)
    }
  }
  return [...out]
}

// Three lanes; Telemetry stands right between UI and MongoDB, with a gap beside it.
const lanes = new Map<string, Box>([
  ['ui', { x: 0, y: 0, w: 200, h: 60 }],
  ['telemetry', { x: 0, y: 120, w: 200, h: 60 }],
  ['users', { x: 216, y: 120, w: 200, h: 60 }],
  ['mongo', { x: 0, y: 240, w: 200, h: 60 }],
])

test('an arrow that would cross a box goes around it through the gap beside it', () => {
  const [r] = routeEdges([{ from: 'ui', to: 'mongo' }], lanes)
  assert.deepEqual(hits(r.d, lanes, ['ui', 'mongo']), [])
  const pts = trace(r.d)
  assert.deepEqual(pts[0], { x: 100, y: 60 })
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 240 })
  // Through the 16px gap between Telemetry and Users, in its middle.
  const inBand = pts.filter((p) => p.y >= 116 && p.y <= 184)
  assert.ok(inBand.length >= 2 && inBand.every((p) => p.x === 208))
  assert.ok(r.mid.y > 60 && r.mid.y < 240)
})

test('an upward arrow goes around the same way', () => {
  const [r] = routeEdges([{ from: 'mongo', to: 'ui' }], lanes)
  assert.deepEqual(hits(r.d, lanes, ['ui', 'mongo']), [])
  const pts = trace(r.d)
  assert.deepEqual(pts[0], { x: 100, y: 240 })
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 60 })
})

test('an arrow passes a whole row of boxes on its outer side', () => {
  const row = new Map(lanes).set('users', { x: 204, y: 120, w: 200, h: 60 })
  const [r] = routeEdges([{ from: 'ui', to: 'mongo' }], row)
  assert.deepEqual(hits(r.d, row, ['ui', 'mongo']), [])
  // The 4px gap is too narrow; the nearest free side is left of Telemetry.
  assert.ok(trace(r.d).some((p) => p.x < 0))
})

test('an arrow crossing several lanes avoids every box in the way', () => {
  const deep = new Map<string, Box>([
    ['a', { x: 0, y: 0, w: 200, h: 60 }],
    ['m1', { x: 100, y: 120, w: 200, h: 60 }],
    ['m2', { x: 316, y: 120, w: 200, h: 60 }],
    ['n1', { x: 0, y: 240, w: 200, h: 60 }],
    ['n2', { x: 216, y: 240, w: 200, h: 60 }],
    ['n3', { x: 400, y: 320, w: 200, h: 40 }],
    ['z', { x: 300, y: 420, w: 200, h: 60 }],
  ])
  for (const [from, to] of [['a', 'z'], ['z', 'a']]) {
    const [r] = routeEdges([{ from, to }], deep)
    assert.deepEqual(hits(r.d, deep, [from, to]), [], `${from} → ${to}`)
  }
})

test('an arrow that clears every box keeps its plain curve', () => {
  const [r] = routeEdges([{ from: 'ui', to: 'users' }], lanes)
  assert.match(r.d, /^M [\d.]+ 60 C [^C]+$/)
  assert.deepEqual(hits(r.d, lanes, ['ui', 'users']), [])
})

test('a bottom-to-bottom arrow goes under a taller box between its ends', () => {
  const row = new Map<string, Box>([
    ['a', { x: 0, y: 0, w: 200, h: 60 }],
    ['tall', { x: 216, y: 0, w: 200, h: 140 }],
    ['b', { x: 432, y: 0, w: 200, h: 60 }],
  ])
  const [r] = routeEdges([{ from: 'a', to: 'b' }], row)
  assert.deepEqual(hits(r.d, row, ['a', 'b']), [])
  const pts = trace(r.d)
  assert.deepEqual(pts[0], { x: 100, y: 60 })
  assert.deepEqual(pts[pts.length - 1], { x: 532, y: 60 })
  assert.equal(r.mid.y, 152)
})

test('several arrows between the same neighbours each keep their own line', () => {
  const rs = routeEdges(
    [
      { from: 'svc', to: 'svc2', kind: 'call' },
      { from: 'svc', to: 'svc2', kind: 'move' },
      { from: 'svc2', to: 'svc', kind: 'call' },
    ],
    boxes,
  )
  assert.deepEqual(rs.map((r) => r.mid.y), [138, 150, 162])
})

const pillAt = (p: P): Box => ({ x: p.x - 32, y: p.y - 10, w: 64, h: 20 })
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('a pill moves along its arrow off a box beside the middle', () => {
  const side = new Map<string, Box>([
    ['a', { x: 0, y: 0, w: 100, h: 40 }],
    ['c', { x: 0, y: 300, w: 100, h: 40 }],
    ['x', { x: 60, y: 160, w: 100, h: 40 }],
  ])
  const [r] = routeEdges([{ from: 'a', to: 'c' }], side)
  assert.equal(r.mid.x, 50)
  assert.ok(![...side.values()].some((b) => overlap(pillAt(r.mid), b)))
  assert.ok(r.mid.y > 40 && r.mid.y < 300)
})

test('pills of crossing arrows do not cover each other', () => {
  const cross = new Map<string, Box>([
    ['a', { x: 0, y: 0, w: 100, h: 40 }],
    ['b', { x: 300, y: 0, w: 100, h: 40 }],
    ['c', { x: 0, y: 200, w: 100, h: 40 }],
    ['d', { x: 300, y: 200, w: 100, h: 40 }],
  ])
  const [p, q] = routeEdges([{ from: 'a', to: 'd' }, { from: 'b', to: 'c' }], cross)
  assert.deepEqual(p.mid, { x: 200, y: 120 })
  assert.ok(!overlap(pillAt(p.mid), pillAt(q.mid)))
})
