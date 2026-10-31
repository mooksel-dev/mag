import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edgesAt } from './arch.ts'
import { archToDNodes, boxLines, callsCount, componentSummary, dominantDiff, diagramSummary, fieldMoves, formatDiffCount, innerSummary, looksGrouped, moves, normalizeDiagram, sequenceActivations, validateDiagram, type ComponentDiagram, type DataDiagram, type DNode, type Diagram, type SequenceDiagram } from './diagram.ts'

// app (mod) holds ui and tasks; tasks gets a new client "queue" (add), drops "store" (del); github is context.
const component = normalizeDiagram({
  type: 'component',
  summary: 'Tasks queue their jobs instead of storing them.',
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
  assert.deepEqual(validateDiagram(normalizeDiagram({ type: 'component', summary: 'x', modules: [] })), ['modules is empty'])
})

test('validateDiagram: a component diagram needs a summary', () => {
  const d = (summary?: string) => validateDiagram(normalizeDiagram({ type: 'component', summary, modules: [{ id: 'a', name: 'A' }] }))
  assert.deepEqual(d('Adds A.'), [])
  for (const s of [undefined, '', '  ']) assert.deepEqual(d(s), ['summary is required: one or two sentences on what changes in substance'])
})

test('looksGrouped: several names joined by "/", "," or " + " in the signature', () => {
  for (const t of ['get / ensureActive', 'Get/EnsureActive/SetAgent', 'Users: DBR fields + their acquire/set methods', 'get, set', 'acquire(id) / release(id)'])
    assert.equal(looksGrouped(t), true, t)
  for (const t of [
    'get(id, opts): User - loads it, or null',
    'validateDiagram(d): string[] - errors before save',
    'merge(a: Map<string, number>, b): { x, y }',
    "formatDiffCount(c): string - '+a ~m −d'",
    'list(): Task[] — the open ones / done ones',
    'GET /users/:id - one user',
    'C++ code(x)',
  ])
    assert.equal(looksGrouped(t), false, t)
})

// users (mod) moves its DBR state methods to a new dbr service; app calls it.
const moved = (patch: (d: ComponentDiagram) => void = () => {}) => {
  const d = normalizeDiagram({
    type: 'component',
    summary: 'DBR state moves from users into its own service.',
    modules: [
      {
        id: 'users',
        name: 'Users',
        interface: [
          'get(id): User',
          { text: 'setAgent(id, a): void', diff: 'del' },
          { text: 'save(u): void', diff: 'del' },
          { text: 'save(u, opts): void', diff: 'add' },
          { text: 'touch(id): void', diff: 'mod' },
        ],
      },
      {
        id: 'dbr',
        name: 'DBR',
        diff: 'add',
        interface: [
          { text: 'getState(userId): State', diff: 'move', from: 'users' },
          { text: 'ensureActive(userId): void', diff: 'move', from: 'users' },
          { text: 'reset(userId): void', diff: 'add' },
          { text: 'audit(userId): Log[]', diff: 'add' },
        ],
      },
      {
        id: 'app',
        name: 'App',
        uses: [
          { to: 'users', calls: ['get(id)', { text: 'save(u)', diff: 'del' }, { text: 'save(u, opts)', diff: 'add' }, { text: 'setAgent(id, a)', diff: 'del' }] },
          { to: 'dbr', calls: ['getState(userId)', 'reset(userId)'] },
        ],
      },
    ],
  }) as ComponentDiagram
  patch(d)
  return d
}

test('validateDiagram component: one method or call per line', () => {
  const errors = validateDiagram(
    moved((d) => {
      d.modules[0].interface![0].text = 'get / ensureActive'
      d.modules[2].uses[0].calls[0].text = 'Get/Set'
    }),
  )
  assert.deepEqual(errors, [
    'Interface line "get / ensureActive" of users: one method per line with its signature "name(args): Result - what it does", never several joined by "/", "," or "+"; a changed method is a del line and an add line',
    'Call "Get/Set" of app → users: one call per line with its signature "name(args)", never several joined by "/", "," or "+"; a changed call is a del line and an add line',
  ])
})

test('validateDiagram component: move needs from, another module of the diagram', () => {
  assert.deepEqual(validateDiagram(moved()), [])
  const at = (l: object) => validateDiagram(moved((d) => Object.assign(d.modules[1].interface![0], l)))
  const what = 'Interface line "getState(userId): State" of dbr'
  assert.deepEqual(at({ from: undefined }), [`${what}: move needs from, the id of the module it moved from`])
  assert.deepEqual(at({ from: 'nope' }), [`${what}: moved from "nope", no such module`])
  assert.deepEqual(at({ from: 'dbr' }), [`${what}: moved from dbr itself; a changed method is a del line and an add line`])
  assert.deepEqual(at({ diff: 'add' }), [`${what}: from is only for diff move`])
  assert.deepEqual(at({ diff: 'moved' }), [`${what}: diff must be one of add, mod, del, move`, `${what}: from is only for diff move`])
  // move is for interface lines only.
  assert.deepEqual(validateDiagram(moved((d) => (d.modules[1].diff = 'move' as never))), ['Module dbr: diff must be one of add, mod, del'])
  assert.deepEqual(validateDiagram(moved((d) => (d.modules[2].uses[1].calls[0].diff = 'move' as never))), ['Call "getState(userId)" of app → dbr: diff must be one of add, mod, del'])
})

test('componentSummary: a del + add of one method is one change, a move counts once', () => {
  assert.deepEqual(componentSummary(moved()), {
    // users: its lines change; dbr: added.
    modules: { add: 1, mod: 1, del: 0, move: 0 },
    // save del + add → ~, touch ~; setAgent −; reset, audit +; getState, ensureActive ↷.
    methods: { add: 2, mod: 2, del: 1, move: 2 },
    // save del + add → ~; setAgent −; app → dbr is a use of an added module: its calls are added.
    calls: { add: 2, mod: 1, del: 1, move: 0 },
  })
  // A del and an add of different methods stay apart; the add may come first.
  const d = moved((x) => (x.modules[0].interface = [{ text: 'b(): void', diff: 'add' }, { text: 'a(): void', diff: 'del' }, { text: 'b(x): void', diff: 'del' }]))
  assert.deepEqual(componentSummary(d).methods, { add: 2, mod: 1, del: 1, move: 2 })
})

test('moves and boxLines', () => {
  const d = moved()
  assert.deepEqual(moves(d).map((m) => [m.line.text, m.from, m.to]), [
    ['getState(userId): State', 'users', 'dbr'],
    ['ensureActive(userId): void', 'users', 'dbr'],
  ])
  // A move whose source is missing is left out.
  assert.deepEqual(moves(moved((x) => (x.modules[1].interface![0].from = 'nope'))).length, 1)

  const dbr = boxLines(d.modules[1])
  assert.deepEqual(dbr.shown.map((l) => l.text), ['getState(userId): State', 'ensureActive(userId): void', 'reset(userId): void'])
  assert.equal(dbr.more, 1)
  // The source box lists the lines that left it after its own changes.
  const users = boxLines(d.modules[0], d)
  assert.deepEqual(users.shown.map((l) => [l.text, l.diff, l.to]), [
    ['setAgent(id, a): void', 'del', undefined],
    ['save(u): void', 'del', undefined],
    ['save(u, opts): void', 'add', undefined],
  ])
  assert.equal(users.more, 3)
  assert.deepEqual(boxLines(d.modules[2]), { shown: [], more: 0 })
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
  assert.deepEqual(diagramSummary(component), { add: 3, mod: 2, del: 2, move: 0 })
  assert.equal(formatDiffCount(diagramSummary(component)), '+3 ~2 −2')
  assert.equal(formatDiffCount({ add: 0, mod: 0, del: 0, move: 0 }), '')
  const seq = normalizeDiagram({ type: 'sequence', participants: [{ id: 'a', diff: 'add' }], messages: [{ from: 'a', to: 'a', text: 'x', kind: 'async', diff: 'del' }] })
  assert.deepEqual(diagramSummary(seq), { add: 1, mod: 0, del: 1, move: 0 })
})

test('innerSummary counts what changes inside a module', () => {
  assert.deepEqual(innerSummary(component.modules[0], component.modules), { add: 2, mod: 2, del: 2, move: 0 })
  assert.deepEqual(innerSummary(component.modules[1], component.modules), { add: 0, mod: 0, del: 0, move: 0 })
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

// DBR state moves out of users into dbr_user_states; both new collections link back to users.
const data = (patch: (d: DataDiagram) => void = () => {}) => {
  const d = normalizeDiagram({
    type: 'data',
    entities: [
      {
        id: 'users',
        fields: [
          { name: '_id', type: 'ObjectId' },
          { name: 'dbrState', type: 'object' },
          { name: 'dataRemovalState', type: 'object', diff: 'del' },
        ],
      },
      {
        id: 'dbr_user_states',
        diff: 'add',
        fields: [
          { name: 'userId', type: 'ObjectId', diff: 'add' },
          { name: 'state', type: 'object', diff: 'move', from: 'users.dbrState' },
          { name: 'optOutPriority', type: 'number', note: 'lower runs first', diff: 'add' },
        ],
      },
      { id: 'agents', name: 'Agents', kind: 'table', fields: [{ name: 'id', type: 'string' }] },
    ],
    relations: [
      { from: 'dbr_user_states', to: 'users', kind: 'N:1', field: 'userId', diff: 'add' },
      { from: 'dbr_user_states', to: 'agents' },
    ],
  }) as DataDiagram
  patch(d)
  return d
}

test('normalizeDiagram data: kind defaults to collection, name to id, relation kind to ref', () => {
  const d = data()
  assert.equal(d.entities[0].kind, 'collection')
  assert.equal(d.entities[0].name, 'users')
  assert.equal(d.entities[2].kind, 'table')
  assert.equal(d.relations[1].kind, 'ref')
  assert.deepEqual(normalizeDiagram({ type: 'data', entities: [{ id: 'x' }] }), { type: 'data', entities: [{ id: 'x', name: 'x', kind: 'collection', fields: [] }], relations: [] })
})

test('validateDiagram data: a valid diagram with a moved field', () => {
  assert.deepEqual(validateDiagram(data()), [])
  assert.deepEqual(fieldMoves(data()), [{ from: { entity: 'users', field: 'dbrState' }, to: { entity: 'dbr_user_states', field: 'state' } }])
  assert.deepEqual(validateDiagram(normalizeDiagram({ type: 'data', entities: [] })), ['entities is empty'])
})

test('validateDiagram data: a move needs a source field of another entity that is not added', () => {
  const at = (f: Partial<DataDiagram['entities'][number]['fields'][number]>) => validateDiagram(data((d) => Object.assign(d.entities[1].fields[1], f)))
  assert.deepEqual(at({ from: undefined }), ['Field "state" of dbr_user_states: move needs from, "<entity>.<field>" it moved from'])
  assert.deepEqual(at({ from: 'users.nope' }), ['Field "state" of dbr_user_states: moved from "users.nope", no such field; give "<entity>.<field>" of this diagram'])
  assert.deepEqual(at({ from: 'dbr_user_states.userId' }), ['Field "state" of dbr_user_states: moved within dbr_user_states; a renamed field is a del line and an add line'])
  assert.deepEqual(validateDiagram(data((d) => (d.entities[0].fields[1].diff = 'add'))), ['Field "state" of dbr_user_states: moved from "users.dbrState", which is added; mark the source as it was'])
  assert.deepEqual(at({ diff: 'add' }), ['Field "state" of dbr_user_states: from is only for diff move'])
})

test('validateDiagram data: a moved entity names its old id, not one of the diagram', () => {
  assert.deepEqual(validateDiagram(data((d) => Object.assign(d.entities[2], { diff: 'move', from: 'workers' }))), [])
  assert.deepEqual(validateDiagram(data((d) => Object.assign(d.entities[2], { diff: 'move', from: 'users' }))), [
    'Entity agents: moved from "users", which is an entity of this diagram; mark its fields with move instead',
  ])
  assert.deepEqual(validateDiagram(data((d) => Object.assign(d.entities[2], { diff: 'move' }))), ['Entity agents: move needs from, the old id of the entity'])
  assert.deepEqual(validateDiagram(data((d) => (d.relations[0].diff = 'move' as never))), ['Relation dbr_user_states → users: diff must be one of add, mod, del'])
})

test('validateDiagram data: one field per line', () => {
  const grouped = (name: string) => validateDiagram(data((d) => (d.entities[0].fields[2].name = name)))
  const err = (name: string) => [`Field "${name}" of users: one field per line; a changed field is a del line and an add line`]
  assert.deepEqual(grouped('a / b'), err('a / b'))
  assert.deepEqual(grouped('email,phone'), err('email,phone'))
  assert.deepEqual(grouped('old new'), err('old new'))
  // A type may hold separators.
  assert.deepEqual(validateDiagram(data((d) => (d.entities[0].fields[2].type = 'Map<string, number> | null'))), [])
  assert.deepEqual(validateDiagram(normalizeDiagram({ type: 'data', entities: [{ id: 'u', fields: ['email: string'] }] })), [
    'Entity u: field "email: string" must be an object { name, type }; one field per line',
  ])
  assert.deepEqual(validateDiagram(normalizeDiagram({ type: 'data', entities: [{ id: 'u', fields: [{ name: 'a', type: 'x' }, { name: 'a', type: 'y' }, { name: 'b' }] }] })), [
    'Entity u: repeated field "a"',
    'Field "b" of u has no type',
  ])
})

test('validateDiagram data: relations link existing entities by a field of the source', () => {
  assert.deepEqual(validateDiagram(data((d) => (d.relations[0].to = 'nope'))), ['Relation dbr_user_states → nope: no "nope"'])
  assert.deepEqual(validateDiagram(data((d) => (d.relations[0].field = 'nope'))), ['Relation dbr_user_states → users: no field "nope" in dbr_user_states'])
  assert.deepEqual(validateDiagram(data((d) => (d.relations[0].kind = '2:2' as never))), ['Relation dbr_user_states → users: kind must be one of 1:1, 1:N, N:1, N:M, ref'])
  assert.deepEqual(validateDiagram(data((d) => (d.entities[0].kind = 'view' as never))), ['Entity users: kind must be one of collection, table, struct, type'])
})

test('diagramSummary data: entities, fields and relations, moves apart', () => {
  // add: dbr_user_states, userId, optOutPriority, the users relation; del: dataRemovalState; move: state.
  assert.deepEqual(diagramSummary(data()), { add: 4, mod: 0, del: 1, move: 1 })
  assert.equal(formatDiffCount(diagramSummary(data())), '+4 ~0 −1 ↷1')
  assert.equal(formatDiffCount({ add: 0, mod: 0, del: 0, move: 2 }), '+0 ~0 −0 ↷2')
})

test('callsCount: changed calls of a use; unmarked calls take an added or removed use or target', () => {
  const calls = [{ text: 'list()' }, { text: 'get(id)', diff: 'del' as const }, { text: 'get(id, opts)', diff: 'add' as const }, { text: 'drop(id)', diff: 'add' as const }]
  assert.deepEqual(callsCount({ to: 'svc', calls }), { add: 1, mod: 1, del: 0, move: 0 })
  assert.deepEqual(callsCount({ to: 'svc', calls: [{ text: 'a()' }, { text: 'b()' }], diff: 'add' }), { add: 2, mod: 0, del: 0, move: 0 })
  assert.deepEqual(callsCount({ to: 'svc', calls: [{ text: 'a()' }, { text: 'b()', diff: 'mod' }], diff: 'mod' }), { add: 0, mod: 1, del: 0, move: 0 })
  const gone: DNode = { id: 'svc', name: 'Svc', diff: 'del', uses: [] }
  assert.deepEqual(callsCount({ to: 'svc', calls: [{ text: 'a()' }] }, gone), { add: 0, mod: 0, del: 1, move: 0 })
  assert.deepEqual(callsCount({ to: 'svc', calls: [{ text: 'a()' }] }), { add: 0, mod: 0, del: 0, move: 0 })
})

test('dominantDiff: the largest count; on a tie mod, then add, then del', () => {
  const c = (add: number, mod: number, del: number) => ({ add, mod, del, move: 0 })
  assert.equal(dominantDiff(c(2, 1, 1)), 'add')
  assert.equal(dominantDiff(c(0, 0, 3)), 'del')
  assert.equal(dominantDiff(c(1, 1, 1)), 'mod')
  assert.equal(dominantDiff(c(2, 0, 2)), 'add')
  assert.equal(dominantDiff(c(0, 0, 0)), undefined)
})
