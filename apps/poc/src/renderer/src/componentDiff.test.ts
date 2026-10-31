import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgesAt, normalizeDiagram, type ComponentDiagram } from '@mag/core'
import { callGroups, changedModule, edgePill, moveEdges, movedOut, unchangedAt } from './componentDiff.ts'

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
