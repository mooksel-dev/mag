import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callersOf, edgesAt, findNode, methodName, pathTo, walkArch, type ArchNode } from './arch.ts'

const node = (id: string, uses: [string, string[]?][] = [], children?: ArchNode[]): ArchNode => ({
  id,
  name: id.toUpperCase(),
  description: '',
  uses: uses.map(([to, calls = []]) => ({ to, calls })),
  ...(children ? { children } : {}),
})

// app: ui → tasks (service) → store (client) and github; worker → tasks; github is a top-level runtime.
const tree: ArchNode[] = [
  node('app', [], [
    node('ui', [['tasks', ['list()', 'groom(id)']]]),
    node('core', [], [
      node('tasks', [['store', ['load()']], ['github', ['openPr(b)']]]),
      node('store'),
    ]),
    node('worker', [['tasks', ['groom(id)']], ['app']]),
  ]),
  node('github'),
  node('cli', [['ui']]),
]

test('walkArch visits every module with its ancestors', () => {
  const seen: string[] = []
  walkArch(tree, (n, a) => seen.push([...a.map((x) => x.id), n.id].join('/')))
  assert.deepEqual(seen, ['app', 'app/ui', 'app/core', 'app/core/tasks', 'app/core/store', 'app/worker', 'github', 'cli'])
})

test('pathTo and findNode', () => {
  assert.deepEqual(pathTo(tree, 'store').map((n) => n.id), ['app', 'core', 'store'])
  assert.deepEqual(pathTo(tree, 'nope'), [])
  assert.equal(findNode(tree, 'tasks')?.name, 'TASKS')
  assert.equal(findNode(tree, 'nope'), undefined)
})

test('edgesAt the top level folds inner uses into their top-level module', () => {
  assert.deepEqual(edgesAt(tree, null), [
    { from: 'app', to: 'github', calls: ['openPr(b)'] },
    { from: 'cli', to: 'app', calls: [] },
  ])
})

test('edgesAt inside a module: siblings, merged calls and ports both ways', () => {
  assert.deepEqual(edgesAt(tree, 'app'), [
    { from: 'ui', to: 'core', calls: ['list()', 'groom(id)'] },
    { from: 'core', to: 'github', calls: ['openPr(b)'], port: 'out' },
    { from: 'worker', to: 'core', calls: ['groom(id)'] },
    { from: 'cli', to: 'ui', calls: [], port: 'in' },
  ])
})

test('edgesAt deeper: a port is the outermost module off the level path', () => {
  assert.deepEqual(edgesAt(tree, 'core'), [
    { from: 'ui', to: 'tasks', calls: ['list()', 'groom(id)'], port: 'in' },
    { from: 'tasks', to: 'store', calls: ['load()'] },
    { from: 'tasks', to: 'github', calls: ['openPr(b)'], port: 'out' },
    { from: 'worker', to: 'tasks', calls: ['groom(id)'], port: 'in' },
  ])
  assert.deepEqual(edgesAt(tree, 'nope'), [])
})

test('methodName and callersOf', () => {
  assert.equal(methodName('groom(taskId): void - starts grooming'), 'groom')
  assert.equal(methodName(' list'), 'list')
  assert.deepEqual(
    callersOf(tree, 'tasks').map((c) => [c.node.id, c.calls]),
    [['ui', ['list()', 'groom(id)']], ['worker', ['groom(id)']]],
  )
})
