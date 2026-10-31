import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgesAt, normalizeDiagram, type ComponentDiagram } from '@mag/core'
import { changedModule, edgeCalls, moveEdges, movedOut, unchangedAt } from './componentDiff.ts'

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

test('a changed arrow names its changed calls, a del and add of one method as one change', () => {
  const e = edgesAt(diagram.modules, null).find((x) => x.from === 'ui')!
  assert.deepEqual(edgeCalls(e), { calls: [{ name: 'get', mark: 'mod' }, { name: 'drop', mark: 'add' }], more: 0 })
})

test('an unchanged arrow keeps its count', () => {
  const e = edgesAt(diagram.modules, null).find((x) => x.from === 'svc')!
  assert.equal(edgeCalls(e), null)
})

test('a changed arrow shows at most three names and the rest as more', () => {
  const calls = ['a()', 'b()', 'c()', 'd()', 'e()']
  const e = { from: 'x', to: 'y', calls, diff: 'add' as const, callDiff: Object.fromEntries(calls.map((c) => [c, 'add' as const])) }
  const named = edgeCalls(e)!
  assert.deepEqual(named.calls.map((c) => c.name), ['a', 'b', 'c'])
  assert.equal(named.more, 2)
})

test('move arrows link the modules that stand for both ends on a level', () => {
  // On top, old → store is inside app: no arrow; svc → store shows as svc → app.
  assert.deepEqual(moveEdges(diagram, null), [{ from: 'svc', to: 'app', names: ['load'] }])
  // Inside app, svc is outside the level: only old → store.
  assert.deepEqual(moveEdges(diagram, 'app'), [{ from: 'old', to: 'store', names: ['save'] }])
})
