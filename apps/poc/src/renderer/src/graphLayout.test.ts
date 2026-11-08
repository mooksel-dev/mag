import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDiagram, type DataDiagram } from '@mag/core'
import { DATA_ROW, FRAME_HEAD, GROUP_HEAD, clipToShape, fieldNotes, fieldKey, indexText, layoutData, layoutFramed, layoutGraph, measureNode, movePath, pathOf, wrap } from './graphLayout.ts'

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

const dbr = normalizeDiagram({
  type: 'data',
  entities: [
    { id: 'agents', fields: [{ name: 'id', type: 'string' }] },
    { id: 'users', fields: [{ name: '_id', type: 'ObjectId' }, { name: 'email', type: 'string', note: 'unique' }, { name: 'dbrState', type: 'object' }] },
    {
      id: 'dbr_user_states',
      diff: 'add',
      fields: [
        { name: 'userId', type: 'ObjectId', diff: 'add' },
        { name: 'agentId', type: 'string', diff: 'add' },
        { name: 'state', type: 'object', diff: 'move', from: 'users.dbrState' },
      ],
    },
  ],
  relations: [
    { from: 'dbr_user_states', to: 'users', kind: 'N:1', field: 'userId' },
    { from: 'dbr_user_states', to: 'agents', kind: 'N:1', field: 'agentId' },
  ],
}) as DataDiagram

test('fieldNotes: own notes and both ends of a move', () => {
  const n = fieldNotes(dbr)
  assert.equal(n.get(fieldKey('users', 'email')), 'unique')
  assert.equal(n.get(fieldKey('users', 'dbrState')), 'moved to dbr_user_states.state')
  assert.equal(n.get(fieldKey('dbr_user_states', 'state')), 'moved from users.dbrState')
})

test('layoutData: a row per field, relations leave from their field, a move keeps its entities apart in order', async () => {
  const l = await layoutData(dbr)
  const at = new Map(l.entities.map((e) => [e.id, e]))
  const users = at.get('users')!
  const states = at.get('dbr_user_states')!
  assert.equal(users.rows.length, 3)
  assert.ok(users.rows[1].h > users.rows[0].h, 'a row with a note is taller')
  assert.ok(users.rows.every((r, i) => !i || r.y === users.rows[i - 1].y + users.rows[i - 1].h), 'rows stack')
  assert.ok(users.rows[2].y + users.rows[2].h <= users.y + users.h)
  // The move edge is laid out, not returned: the source stands left of the target.
  assert.ok(users.x + users.w <= states.x, 'users left of dbr_user_states')
  assert.deepEqual(l.relations.map((r) => r.index), [0, 1])
  for (const r of l.relations) assert.ok(r.points.length >= 2 && r.labelAt?.lines[0].startsWith('N:1'))
  const userId = l.relations[0].points[0]
  assert.ok(Math.abs(userId.y - (states.rows[0].y + DATA_ROW / 2)) < 1, 'relation leaves from the userId row')
  assert.match(movePath(users, users.rows[2], states, states.rows[2]), /^M[\d.]+ [\d.]+ C/)
})

test('layoutData: entities stand in the box of their module, indexes are rows after the fields (povnyi-diff-nabir-pov-iazanykh.3)', async () => {
  const d: DataDiagram = {
    type: 'data',
    entities: [
      { id: 'dar_jobs', name: 'dar_jobs', kind: 'collection', module: 'dar_jobs', fields: [{ name: 'user_id', type: 'string' }, { name: 'sent_at', type: 'time', diff: 'add' }], indexes: [{ fields: ['user_id'], unique: true, diff: 'add' }] },
      { id: 'states', name: 'dar_user_states', kind: 'collection', module: 'dar_user_states', fields: [{ name: 'user_id', type: 'string' }] },
      { id: 'loose', name: 'loose', kind: 'table', fields: [{ name: 'id', type: 'int' }] },
    ],
    relations: [{ from: 'dar_jobs', to: 'states', kind: 'N:1', field: 'user_id', cross: true }],
  }
  const l = await layoutData(d)
  assert.deepEqual(l.entities.map((e) => e.id), ['dar_jobs', 'states', 'loose'])
  assert.deepEqual(l.groups.map((g) => g.module), ['dar_jobs', 'dar_user_states'])
  const jobs = l.entities[0]
  const box = l.groups[0]
  assert.ok(jobs.x >= box.x && jobs.y >= box.y + GROUP_HEAD && jobs.x + jobs.w <= box.x + box.w && jobs.y + jobs.h <= box.y + box.h, 'the entity is inside its module')
  assert.equal(jobs.indexRows.length, 1)
  assert.ok(jobs.indexRows[0].y >= jobs.rows[1].y + jobs.rows[1].h && jobs.indexRows[0].y + DATA_ROW <= jobs.y + jobs.h)
  assert.equal(indexText(d.entities[0].indexes![0]), 'unique (user_id)')
  // The relation leaves from its field's row, in the coordinates of the whole diagram.
  assert.ok(Math.abs(l.relations[0].points[0].y - (jobs.rows[0].y + DATA_ROW / 2)) < 1)
})

test('layoutFramed: boxes sit in nested frames, callers above what they call, an empty frame is left out', async () => {
  const boxes = [
    { id: 'app', w: 190, h: 64, frame: 'device' },
    { id: 'api', w: 190, h: 64, frame: 'aws' },
    { id: 'db', w: 240, h: 90, frame: 'vpc' },
    { id: 'loose', w: 190, h: 64 },
  ]
  const frames = [{ id: 'device' }, { id: 'aws' }, { id: 'vpc', parent: 'aws' }, { id: 'empty' }]
  const edges = [{ from: 'app', to: 'api' }, { from: 'api', to: 'db' }, { from: 'app', to: 'gone' }]
  const l = await layoutFramed(boxes, frames, edges)
  assert.deepEqual(l.frames.map((f) => f.id).sort(), ['aws', 'device', 'vpc'])
  assert.equal(l.frames.find((f) => f.id === 'vpc')!.depth, 1)
  const inFrame = (f: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    b.x >= f.x && b.y >= f.y + FRAME_HEAD && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h
  const at = (id: string) => l.boxes.get(id)!
  for (const b of boxes.filter((x) => x.frame)) assert.ok(inFrame(l.frames.find((f) => f.id === b.frame)!, { ...at(b.id), w: b.w, h: b.h }), `${b.id} is in its frame`)
  const vpc = l.frames.find((f) => f.id === 'vpc')!
  assert.ok(inFrame(l.frames.find((f) => f.id === 'aws')!, vpc), 'the VPC is in its account')
  assert.ok(at('app').y < at('api').y && at('api').y < at('db').y, 'callers above what they call')
})
