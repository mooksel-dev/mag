import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipToShape, layoutGraph, measureNode, pathOf, wrap } from './graphLayout.ts'

test('wrap: breaks on words, keeps a long word whole', () => {
  assert.deepEqual(wrap('check the open pull request', 10), ['check the', 'open pull', 'request'])
  assert.deepEqual(wrap('supercalifragilistic word', 8), ['supercalifragilistic', 'word'])
  assert.deepEqual(wrap('', 8), [''])
})

test('measureNode: a diamond is larger than a box with the same label', () => {
  const step = measureNode({ id: 'a', label: 'Is it merged?', shape: 'step' })
  const dec = measureNode({ id: 'a', label: 'Is it merged?', shape: 'decision' })
  assert.ok(dec.w > step.w - 20 && dec.h > step.h)
  assert.deepEqual(measureNode({ id: 'i', label: '', shape: 'initial' }).lines, [])
})

test('clipToShape: ends on a diamond move from the box onto the outline', () => {
  const box = { x: 0, y: 0, w: 100, h: 60 }
  // Vertical segment into the top tip stays at the tip.
  assert.deepEqual(clipToShape({ x: 50, y: 0 }, { x: 50, y: -20 }, box, 'decision'), { x: 50, y: 0 })
  // Off-center vertical segment ends lower, on the slanted side.
  assert.deepEqual(clipToShape({ x: 75, y: 0 }, { x: 75, y: -20 }, box, 'decision'), { x: 75, y: 15 })
  // Horizontal segment into the right side.
  assert.deepEqual(clipToShape({ x: 100, y: 30 }, { x: 130, y: 30 }, box, 'decision'), { x: 100, y: 30 })
  // A box is left alone.
  assert.deepEqual(clipToShape({ x: 75, y: 0 }, { x: 75, y: -20 }, box, 'step'), { x: 75, y: 0 })
  // A circle.
  const dot = { x: 0, y: 0, w: 20, h: 20 }
  assert.deepEqual(clipToShape({ x: 10, y: 20 }, { x: 10, y: 40 }, dot, 'initial'), { x: 10, y: 20 })
})

test('pathOf: rounds inner corners, keeps the ends', () => {
  const d = pathOf([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }])
  assert.match(d, /^M0 0 L0 14 Q0 20 6 20 L30 20$/)
  assert.equal(pathOf([]), '')
})

test('layoutGraph: places every node and routes every edge between them', async () => {
  const g = await layoutGraph(
    [
      { id: 's', label: 'Start', shape: 'start' },
      { id: 'q', label: 'PR merged?', shape: 'decision' },
      { id: 'done', label: 'Mark step done', shape: 'step' },
      { id: 'e', label: 'End', shape: 'end' },
    ],
    [
      { id: '0', from: 's', to: 'q' },
      { id: '1', from: 'q', to: 'done', label: 'yes' },
      { id: '2', from: 'q', to: 'q', label: 'no, wait' },
      { id: '3', from: 'done', to: 'e' },
    ],
  )
  assert.equal(g.nodes.length, 4)
  assert.equal(g.edges.length, 4)
  const at = new Map(g.nodes.map((n) => [n.id, n]))
  assert.ok(at.get('s')!.y < at.get('q')!.y && at.get('q')!.y < at.get('done')!.y, 'top-down in flow order')
  for (const e of g.edges) assert.ok(e.points.length >= 2, `edge ${e.id} has a route`)
  assert.ok(g.edges[1].labelAt && g.edges[1].labelAt.lines[0] === 'yes')
  assert.ok(g.w > 0 && g.h > 0)
})

test('layoutGraph: a cycle breaks against the input order, so the first node stays first', async () => {
  const g = await layoutGraph(
    [
      { id: '@initial', label: '', shape: 'initial' },
      { id: 'todo', label: 'Todo', shape: 'state' },
      { id: 'prog', label: 'In progress', shape: 'state' },
    ],
    [
      { id: 'a', from: 'todo', to: 'prog', label: 'start' },
      { id: 'b', from: 'prog', to: 'todo', label: 'cancel' },
      { id: 'i', from: '@initial', to: 'todo' },
    ],
    'RIGHT',
  )
  const x = new Map(g.nodes.map((n) => [n.id, n.x]))
  assert.ok(x.get('@initial')! < x.get('todo')! && x.get('todo')! < x.get('prog')!)
})
