import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgesAt, normalizeDiagram, type ComponentDiagram, type DNode } from '@mag/core'
import { appLanes, callGroups, changedModule, edgeLabel, edgePill, foldEdges, laneFrameId, quietZones, zoneId, zoneOwners, flowItems, flowLines, flowOf, methodCallers, moveEdges, movedOut, relatedFlows, unchangedAt } from './componentDiff.ts'

const diagram = normalizeDiagram({
  type: 'component',
  summary: 'Users move to a store.',
  modules: [
    { id: 'ui', name: 'UI', uses: [{ to: 'svc', calls: ['list()', { text: 'get(id)', diff: 'del' }, { text: 'get(id, opts)', diff: 'add' }, { text: 'drop(id)', diff: 'add' }] }] },
    { id: 'svc', name: 'Service', interface: ['list(): User[]', 'get(id): User'], uses: [{ to: 'db', calls: ['find()'] }] },
    { id: 'db', name: 'Db', uses: [] },
    { id: 'idle', name: 'Idle', uses: [{ to: 'db', calls: ['find()'] }] },
    {
      id: 'app',
      name: 'App',
      uses: [],
      children: [
        { id: 'old', name: 'Old', uses: [] },
        { id: 'store', name: 'Store', interface: [{ text: 'save(u): void', diff: 'move', from: 'old' }, { text: 'load(id): User', diff: 'move', from: 'svc' }], uses: [] },
      ],
    },
  ],
}) as ComponentDiagram

test('modules without a change of their own or inside fold into the unchanged row', () => {
  const folded = unchangedAt(diagram, diagram.modules)
  // ui: changed calls; svc: a line moved out; app: a changed inner module.
  assert.deepEqual([...folded], ['db', 'idle'])
})

test('a level in boundaries folds nothing: unchanged neighbours stay in their frames', () => {
  const framed = { ...diagram, boundaries: [{ id: 'aws', name: 'AWS' }], modules: diagram.modules.map((n) => (n.id === 'db' ? { ...n, boundary: 'aws' } : n)) }
  assert.deepEqual([...unchangedAt(framed, framed.modules)], [])
})

test('a module with only a line moved out of it still changes', () => {
  const out = movedOut(diagram)
  assert.deepEqual([...out].sort(), ['old', 'svc'])
  const old = diagram.modules[4].children![0]
  assert.equal(changedModule(old, new Set()), false)
  assert.equal(changedModule(old, out), true)
})

test('a changed arrow gets a count pill, a del and add of one method as one mod', () => {
  const e = edgesAt(diagram.modules, null).find((x) => x.from === 'ui')!
  assert.deepEqual(edgePill(e), { count: { add: 1, mod: 1, del: 0, move: 0 }, mark: 'mod' })
})

test('an arrow with no changed call has no pill', () => {
  const e = edgesAt(diagram.modules, null).find((x) => x.from === 'svc')!
  assert.equal(edgePill(e), null)
})

test('an arrow to a removed module counts every call as removed', () => {
  const d = normalizeDiagram({
    type: 'component',
    modules: [
      { id: 'ui', name: 'UI', uses: [{ to: 'old', calls: ['a()', 'b()'] }] },
      { id: 'old', name: 'Old', diff: 'del', uses: [] },
    ],
  }) as ComponentDiagram
  assert.deepEqual(edgePill(edgesAt(d.modules, null)[0]), { count: { add: 0, mod: 0, del: 2, move: 0 }, mark: 'del' })
})

test('callGroups: full call lists by target and by caller, marks of a whole use passed on', () => {
  const d = normalizeDiagram({
    type: 'component',
    modules: [
      { id: 'ui', name: 'UI', uses: [{ to: 'svc', calls: ['list()', { text: 'drop(id)', diff: 'add' }] }] },
      { id: 'jobs', name: 'Jobs', diff: 'add', uses: [{ to: 'svc', calls: ['list()'] }] },
      { id: 'svc', name: 'Service', uses: [{ to: 'db', calls: ['find()'] }] },
      { id: 'db', name: 'Db', uses: [] },
    ],
  }) as ComponentDiagram
  const svc = d.modules.find((m) => m.id === 'svc')!
  const g = callGroups(d.modules, svc)
  assert.deepEqual(g.calls, [{ id: 'db', diff: undefined, calls: [{ text: 'find()', diff: undefined }] }])
  assert.deepEqual(g.callers, [
    { id: 'ui', diff: 'mod', calls: [{ text: 'list()', diff: undefined }, { text: 'drop(id)', diff: 'add' }] },
    { id: 'jobs', diff: 'add', calls: [{ text: 'list()', diff: 'add' }] },
  ])
})

test('move arrows link the modules that stand for both ends on a level', () => {
  // On top, old → store is inside app: no arrow; svc → store shows as svc → app.
  assert.deepEqual(moveEdges(diagram, null), [{ from: 'svc', to: 'app', names: ['load'] }])
  // Inside app, svc is outside the level: only old → store.
  assert.deepEqual(moveEdges(diagram, 'app'), [{ from: 'old', to: 'store', names: ['save'] }])
})

const flow = (id: string, of: string, replaces?: string) => ({
  id,
  title: id,
  diagram: normalizeDiagram({ type: 'flowchart', of, replaces, nodes: [{ id: 's', label: 'Start', shape: 'start' }], edges: [] }),
})

test('flowItems and flowOf: flowcharts with of, found by module and method', () => {
  const flows = flowItems([{ id: 'c', title: 'c', diagram }, flow('f1', 'svc#get'), { id: 'f2', title: 'f2', diagram: normalizeDiagram({ type: 'flowchart', nodes: [], edges: [] }) }])
  assert.deepEqual(flows.map((f) => f.id), ['f1'])
  assert.equal(flowOf(flows, 'svc', 'get')?.id, 'f1')
  assert.equal(flowOf(flows, 'svc', 'list'), undefined)
})

test('flowLines: lines with a flow that are not changed lines, a bare method() when not in the interface', () => {
  const svc = { ...diagram.modules[1], interface: [{ text: 'list(): User[]' }, { text: 'get(id): User' }, { text: 'put(u)', diff: 'add' as const }] }
  const flows = flowItems([flow('f1', 'svc#get'), flow('f2', 'svc#put'), flow('f3', 'svc#sync'), flow('f4', 'db#find')])
  assert.deepEqual(flowLines(svc, flows), [{ text: 'get(id): User' }, { text: 'sync()' }])
})

test('methodCallers: callers of one method with only their calls of it', () => {
  const svc = diagram.modules[1]
  assert.deepEqual(methodCallers(diagram.modules, svc, 'get'), [{ id: 'ui', diff: 'mod', calls: [{ text: 'get(id)', diff: 'del' }, { text: 'get(id, opts)', diff: 'add' }] }])
  assert.deepEqual(methodCallers(diagram.modules, svc, 'save'), [])
})

test('relatedFlows: other flows of the module, what it replaces and what replaces it', () => {
  const flows = flowItems([flow('old', 'svc#get'), flow('new', 'svc#fetch', 'svc#get'), flow('list', 'svc#list'), flow('db', 'db#find')])
  const [old, neu] = flows
  const r = relatedFlows(flows, old)
  assert.deepEqual(r.others.map((f) => f.item.id), ['new', 'list'])
  assert.equal(r.replaces, undefined)
  assert.deepEqual(r.replacedBy.map((l) => [l.module, l.method, l.flow?.id]), [['svc', 'fetch', 'new']])
  const n = relatedFlows(flows, neu)
  assert.deepEqual([n.replaces?.method, n.replaces?.flow?.id, n.replacedBy.length], ['get', 'old', 0])
  assert.deepEqual(relatedFlows(flowItems([flow('x', 'svc#a', 'gone#b')]), flowItems([flow('x', 'svc#a', 'gone#b')])[0]).replaces, { module: 'gone', method: 'b', flow: undefined })
})

test('a module with a flow of a method keeps its box, and so does its parent', () => {
  assert.deepEqual([...unchangedAt(diagram, diagram.modules, flowItems([flow('f', 'db#find')]))], ['idle'])
  const app: DNode = { id: 'app', name: 'App', description: '', uses: [], children: [{ id: 'inner', name: 'Inner', description: '', uses: [] }] }
  assert.equal(changedModule(app, new Set()), false)
  assert.equal(changedModule(app, new Set(), new Set(['inner'])), true)
})

test('edgeLabel: the first call, a changed one first on a diff, "+n" for the rest; counts and calls in the tooltip', () => {
  const e = edgesAt(diagram.modules, null).find((x) => x.from === 'ui')!
  assert.deepEqual(edgeLabel(e, true), { text: 'get(id)', more: 3, mark: 'mod', title: '+1 ~1 −0\n− get(id)\n+ get(id, opts)\n+ drop(id)\n  list()' })
  assert.deepEqual(edgeLabel(e, false), { text: 'list()', more: 3, title: 'list()\nget(id)\nget(id, opts)\ndrop(id)' })
  const plain = edgesAt(diagram.modules, null).find((x) => x.from === 'svc' && x.to === 'db')!
  assert.deepEqual(edgeLabel(plain, true), { text: 'find()', more: 0, title: '  find()' })
  assert.deepEqual(edgeLabel({ from: 'a', to: 'b', calls: ['run(job) - starts it'] }, false)?.text, 'run(job)')
  assert.equal(edgeLabel({ from: 'a', to: 'b', calls: [] }, true), null)
})

const system = (): ComponentDiagram => ({
  type: 'component',
  summary: 's',
  boundaries: [
    { id: 'aws', name: 'AWS' },
    { id: 'hub', name: 'hub', kind: 'app', parent: 'aws' },
    { id: 'other', name: 'other team', parent: 'aws' },
    { id: 'billing', name: 'billing', parent: 'other' },
    { id: 'saas', name: 'SaaS', diff: 'add' },
    { id: 'empty', name: 'empty' },
  ],
  modules: [
    { id: 'h', name: 'handler', description: '', layer: 'app', boundary: 'hub', uses: [{ to: 's', calls: [{ text: 'pay(id)', diff: 'add' }] }, { to: 'b1', calls: [{ text: 'GET /a' }], flow: 'f', step: '1' }] },
    { id: 's', name: 'svc', description: '', layer: 'service', boundary: 'hub', diff: 'add', uses: [{ to: 'b2', calls: [{ text: 'POST /b' }], diff: 'add', flow: 'f', step: '2' }, { to: 'ext', calls: [] }] },
    { id: 'b1', name: 'b1', description: '', boundary: 'other', uses: [{ to: 'b2', calls: [{ text: 'x()' }] }] },
    { id: 'b2', name: 'b2', description: '', boundary: 'billing', uses: [] },
    { id: 'ext', name: 'ext', description: '', boundary: 'saas', uses: [] },
  ],
})

test('quietZones: the outermost boundaries with no change in them or on them; zoneOwners maps their modules to the block', () => {
  const d = system()
  const zones = quietZones(d, d.modules, d.boundaries!)
  assert.deepEqual([...zones], ['other'])
  assert.deepEqual([...zoneOwners(d.modules, d.boundaries!, zones)], [['b1', zoneId('other')], ['b2', zoneId('other')]])
  d.modules[3].interface = [{ text: 'get()', diff: 'mod' }]
  assert.deepEqual([...quietZones(d, d.modules, d.boundaries!)], [])
  const marked = system()
  marked.boundaries![3].diff = 'mod'
  assert.deepEqual([...quietZones(marked, marked.modules, marked.boundaries!)], [])
})

test('foldEdges: ends in a zone move to its block, arrows merge with their calls and steps, one inside the block goes', () => {
  const d = system()
  const owners = zoneOwners(d.modules, d.boundaries!, quietZones(d, d.modules, d.boundaries!))
  const edges = foldEdges(edgesAt(d.modules, null), owners)
  const z = zoneId('other')
  assert.deepEqual(edges.map((e) => `${e.from}>${e.to}`), ['h>s', `h>${z}`, `s>${z}`, 's>ext'])
  assert.deepEqual(edges.find((e) => e.from === 'h' && e.to === z)?.calls, ['GET /a'])
  assert.deepEqual(edges.find((e) => e.from === 's' && e.to === z)?.steps, [{ flow: 'f', step: '2', calls: ['POST /b'] }])
  const merged = foldEdges(
    [
      { from: 'a', to: 'x', calls: ['one()'], steps: [{ flow: 'f', step: '1', calls: ['one()'] }], async: true },
      { from: 'a', to: 'y', calls: ['one()', 'two()'], diff: 'add', callDiff: { 'two()': 'add' }, steps: [{ flow: 'f', step: '2', calls: ['two()'] }], async: true },
      { from: 'x', to: 'y', calls: ['in()'] },
    ],
    new Map([['x', 'Z'], ['y', 'Z']]),
  )
  assert.deepEqual(merged, [{ from: 'a', to: 'Z', calls: ['one()', 'two()'], callDiff: { 'two()': 'add' }, diff: 'mod', async: true, steps: [{ flow: 'f', step: '1', calls: ['one()'] }, { flow: 'f', step: '2', calls: ['two()'] }] }])
  assert.equal(foldEdges(edges, new Map()), edges)
})

test('appLanes: layered modules in an app boundary go in the frame of their layer inside it', () => {
  const d = system()
  assert.deepEqual([...appLanes(d, d.modules)], [
    ['h', { frame: laneFrameId('hub', 'app'), boundary: 'hub', layer: 'app' }],
    ['s', { frame: laneFrameId('hub', 'service'), boundary: 'hub', layer: 'service' }],
  ])
  d.boundaries![1].kind = 'runtime'
  assert.equal(appLanes(d, d.modules).size, 0)
})
