import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgesAt } from './arch.ts'
import { archToDNodes, diagramSummary, formatDiffCount, innerSummary, normalizeDiagram, sequenceActivations, validateDiagram, type DNode, type Diagram, type SequenceDiagram } from './diagram.ts'

// app (mod) holds ui and tasks; tasks gets a new client "queue" (add), drops "store" (del); github is context.
const component = normalizeDiagram({
  type: 'component',
  modules: [
    {
      id: 'app',
      name: 'App',
      children: [
        { id: 'ui', name: 'UI', uses: [{ to: 'tasks', calls: ['list()', { text: 'groom(id)', diff: 'add' }] }] },
        {
          id: 'tasks',
          name: 'Tasks',
          interface: ['list()', { text: 'groom(id)', diff: 'add' }],
          uses: [
            { to: 'queue', calls: ['push(job)'] },
            { to: 'store', calls: ['load()'] },
            'github',
          ],
        },
        { id: 'queue', name: 'Queue', diff: 'add', uses: [] },
        { id: 'store', name: 'Store', diff: 'del' },
      ],
    },
    { id: 'github', name: 'GitHub' },
    { id: 'cli', name: 'CLI', uses: [{ to: 'ui', calls: [], diff: 'add' }] },
  ],
}) as Extract<Diagram, { type: 'component' }>

test('normalizeDiagram: strings become lines and uses, missing lists empty', () => {
  const tasks = component.modules[0].children![1]
  assert.deepEqual(tasks.interface, [{ text: 'list()' }, { text: 'groom(id)', diff: 'add' }])
  assert.deepEqual(tasks.uses[2], { to: 'github', calls: [] })
  assert.deepEqual(component.modules[1].uses, [])
  assert.equal(component.modules[1].description, '')
})

test('validateDiagram: a valid component diagram has no errors', () => {
  assert.deepEqual(validateDiagram(component), [])
})

test('validateDiagram: unknown type, repeated ids, unknown targets, bad marks', () => {
  assert.match(validateDiagram({ type: 'pie' } as unknown as Diagram)[0], /type must be one of/)
  const bad = normalizeDiagram({
    type: 'component',
    modules: [
      { id: 'a', name: 'A', uses: ['b', 'a', 'nope'], diff: 'new' },
      { id: 'b', name: 'B', children: [{ id: 'a', name: 'A2' }] },
    ],
  })
  const errors = validateDiagram(bad)
  assert.ok(errors.includes('Repeated module id "a"'))
  assert.ok(errors.includes('Module a uses itself'))
  assert.ok(errors.includes('Module a uses "nope": no such module'))
  assert.ok(errors.some((e) => e.startsWith('Module a: diff must be')))
  assert.deepEqual(validateDiagram(normalizeDiagram({ type: 'component', modules: [] })), ['modules is empty'])
})

test('validateDiagram: sequence replies need an open call, before and after the change', () => {
  const seq = (messages: unknown[]) => validateDiagram(normalizeDiagram({ type: 'sequence', participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], messages }))
  assert.deepEqual(seq([
    { from: 'a', to: 'b', text: 'run', kind: 'call' },
    { from: 'b', to: 'c', text: 'ping', kind: 'async' },
    { from: 'b', to: 'a', text: 'ok', kind: 'reply' },
  ]), [])
  assert.match(seq([{ from: 'b', to: 'a', text: 'ok', kind: 'reply' }])[0], /without an open call a → b/)
  // The call is only in the old scenario, the reply in both.
  const errors = seq([
    { from: 'a', to: 'b', text: 'run', kind: 'call', diff: 'del' },
    { from: 'b', to: 'a', text: 'ok', kind: 'reply' },
  ])
  assert.deepEqual(errors, ['Message 2: reply b → a without an open call a → b (after the change)'])
  assert.ok(seq([{ from: 'a', to: 'x', text: 'run', kind: 'call' }]).includes('Message 1 a → x: no "x"'))
  assert.ok(seq([{ from: 'a', to: 'b', text: 'run', kind: 'shout' }]).some((e) => e.includes('kind must be')))
})

test('validateDiagram: state and flowchart links and fields', () => {
  assert.deepEqual(
    validateDiagram(normalizeDiagram({ type: 'state', entity: 'Task', states: [{ id: 'todo' }, { id: 'done' }], transitions: [{ from: 'todo', to: 'gone', event: '' }] })),
    ['Transition todo → gone: no "gone"', 'Transition todo → gone has no event'],
  )
  assert.deepEqual(
    validateDiagram(normalizeDiagram({ type: 'flowchart', nodes: [{ id: 's', shape: 'start' }, { id: 'x', shape: 'blob' }], edges: [{ from: 's', to: 'x' }] })),
    ['Node x: shape must be start, step, decision or end'],
  )
})

test('diagramSummary counts modules and uses; a use of an added or removed module takes its mark', () => {
  // mod: tasks (interface line), ui → tasks (call line); add: queue, tasks → queue, cli → ui; del: store, tasks → store.
  assert.deepEqual(diagramSummary(component), { add: 3, mod: 2, del: 2 })
  assert.equal(formatDiffCount(diagramSummary(component)), '+3 ~2 −2')
  assert.equal(formatDiffCount({ add: 0, mod: 0, del: 0 }), '')
  const seq = normalizeDiagram({ type: 'sequence', participants: [{ id: 'a', diff: 'add' }], messages: [{ from: 'a', to: 'a', text: 'x', kind: 'async', diff: 'del' }] })
  assert.deepEqual(diagramSummary(seq), { add: 1, mod: 0, del: 1 })
})

test('innerSummary counts what changes inside a module', () => {
  assert.deepEqual(innerSummary(component.modules[0], component.modules), { add: 2, mod: 2, del: 2 })
  assert.deepEqual(innerSummary(component.modules[1], component.modules), { add: 0, mod: 0, del: 0 })
})

test('edgesAt marks arrows and calls of a diagram', () => {
  const inside = edgesAt(component.modules, 'app')
  const at = (from: string, to: string) => inside.find((e) => e.from === from && e.to === to)
  assert.deepEqual(at('ui', 'tasks'), { from: 'ui', to: 'tasks', calls: ['list()', 'groom(id)'], diff: 'mod', callDiff: { 'groom(id)': 'add' } })
  assert.deepEqual(at('tasks', 'queue'), { from: 'tasks', to: 'queue', calls: ['push(job)'], diff: 'add', callDiff: { 'push(job)': 'add' } })
  assert.equal(at('tasks', 'store')?.diff, 'del')
  assert.equal(at('tasks', 'github')?.diff, undefined)
  // On the top level the app's arrows fold: unchanged github use + nothing else → no mark; cli → app is added.
  const top = edgesAt(component.modules, null)
  assert.equal(top.find((e) => e.from === 'app' && e.to === 'github')?.diff, undefined)
  assert.equal(top.find((e) => e.from === 'cli' && e.to === 'app')?.diff, 'add')
})

test('archToDNodes turns the architecture into an unmarked tree', () => {
  const nodes: DNode[] = archToDNodes([{ id: 'a', name: 'A', description: 'd', interface: ['f()'], uses: [{ to: 'b', calls: ['f()'] }], children: [{ id: 'b', name: 'B', description: '', uses: [] }] }])
  assert.deepEqual(nodes, [{ id: 'a', name: 'A', description: 'd', interface: [{ text: 'f()' }], uses: [{ to: 'b', calls: [{ text: 'f()' }] }], children: [{ id: 'b', name: 'B', description: '', uses: [] }] }])
})

test('sequenceActivations: a call opens a bar on its target, the reply closes it; nested calls stack', () => {
  const d = normalizeDiagram({
    type: 'sequence',
    participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    messages: [
      { from: 'a', to: 'b', text: 'run()', kind: 'call' },
      { from: 'b', to: 'b', text: 'check()', kind: 'call' },
      { from: 'b', to: 'b', text: 'ok', kind: 'reply' },
      { from: 'b', to: 'c', text: 'notify', kind: 'async' },
      { from: 'b', to: 'a', text: 'done', kind: 'reply' },
      { from: 'a', to: 'c', text: 'log()', kind: 'call' },
    ],
  }) as SequenceDiagram
  const { bars, ends } = sequenceActivations(d)
  assert.deepEqual(bars, [
    { on: 'b', from: 0, to: 4, depth: 0, diff: undefined },
    { on: 'b', from: 1, to: 2, depth: 1, diff: undefined },
    { on: 'c', from: 5, to: 6, depth: 0, diff: undefined },
  ])
  assert.deepEqual(ends, [
    { from: -1, to: 0 },
    { from: 0, to: 1 },
    { from: 1, to: 0 },
    { from: 0, to: -1 },
    { from: 0, to: -1 },
    { from: -1, to: 0 },
  ])
})

test('sequenceActivations: a swapped call ends at the shared reply; a reply closes the calls opened after its own', () => {
  const swapped = normalizeDiagram({
    type: 'sequence',
    participants: [{ id: 'a' }, { id: 'b' }],
    messages: [
      { from: 'a', to: 'b', text: 'old()', kind: 'call', diff: 'del' },
      { from: 'a', to: 'b', text: 'new()', kind: 'call', diff: 'add' },
      { from: 'b', to: 'a', text: 'ok', kind: 'reply' },
    ],
  }) as SequenceDiagram
  assert.deepEqual(
    sequenceActivations(swapped).bars.map((b) => [b.from, b.to, b.depth, b.diff]),
    [[0, 2, 0, 'del'], [1, 2, 1, 'add']],
  )
  const unanswered = normalizeDiagram({
    type: 'sequence',
    participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    messages: [
      { from: 'a', to: 'b', text: 'x', kind: 'call' },
      { from: 'b', to: 'c', text: 'y', kind: 'call' },
      { from: 'b', to: 'a', text: 'ok', kind: 'reply' },
      { from: 'a', to: 'c', text: 'z', kind: 'call' },
    ],
  }) as SequenceDiagram
  assert.deepEqual(sequenceActivations(unanswered).bars.map((b) => [b.on, b.from, b.to]), [['b', 0, 2], ['c', 1, 2], ['c', 3, 4]])
})
