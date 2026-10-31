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
