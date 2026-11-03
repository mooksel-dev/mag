import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inventoryDiagrams, logicUnit, normalizeInventory, validateDiagram, validateLinks, withScenarioLinks, type ArchNode, type ChangeInventory, type ComponentDiagram, type SequenceDiagram } from './index.ts'

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({ id, name: id, description: '', uses: [], ...extra })
const architecture: ArchNode[] = [node('poc', { children: [node('orchestrator', { name: 'Orchestrator', layer: 'service' }), node('git', { layer: 'client' })] }), node('github', { kind: '3rd-party API' })]

test('normalizeInventory: JSON or an object, runs read as hunks, ids filled in; what is wrong is listed', () => {
  const { inventory, errors } = normalizeInventory(
    JSON.stringify({ summary: 'one', units: [{ kind: 'method', module: 'm', name: 'a', change: 'add', logic: 'trivial', runs: ['H1.1'], visibility: 'private', stored: 'yes' }], noise: [{ runs: 'H2 H3', reason: 'test' }] }),
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(inventory, { summary: ['one'], units: [{ id: 'u1', kind: 'method', module: 'm', name: 'a', change: 'add', hunks: ['H1.1'], visibility: 'private', logic: 'trivial', stored: false }], noise: [{ hunks: ['H2', 'H3'], reason: 'test' }] })
  const bad = normalizeInventory({ units: [{ id: 'x', kind: 'func', change: 'rename', hunks: [] }, { id: 'x', kind: 'method', module: 'm', name: 'b', change: 'mod', hunks: ['H1'] }], noise: [{ hunks: [] }] })
  assert.deepEqual(bad.errors, [
    'summary is required: 3–6 short bullets on what the change does, by meaning',
    'Unit x: kind must be one of method, model, field, index, dependency, config, template',
    'Unit x: name is required, copied from the diff',
    'Unit x (): module is required, the module of its hunks as the listing names it',
    'Unit x (): hunks is required, the ids of the blocks of changed lines it rests on',
    'Unit x (): rename needs from, the old name',
    'Unit x: repeated id',
    'Unit x (b): a method needs logic: none, trivial, nontrivial',
    'noise[0]: hunks is required',
    'noise[0]: reason is required, one line on why it is no change of the design',
  ])
  assert.deepEqual(normalizeInventory('{').errors, ['inventory must be an object (or its JSON)'])
})

const INVENTORY: ChangeInventory = {
  summary: ['The fact is an inventory.', 'mag draws Component and Data.'],
  units: [
    { id: 'u1', kind: 'method', module: 'orchestrator', owner: 'Orchestrator', name: 'factOf', change: 'mod', before: 'async factOf(stepId: string): Promise<string>', after: 'async factOf(stepId: string, heads: Heads): Promise<string>', logic: 'nontrivial', hunks: ['H1.1'] },
    { id: 'u2', kind: 'method', module: 'orchestrator', name: 'seed', change: 'del', before: 'function seed(of: string): SeedDiagram[]', logic: 'none', visibility: 'private', hunks: ['H2.1'] },
    { id: 'u3', kind: 'method', module: 'git', name: 'Repo.Send', change: 'rename', from: 'Repo.Deliver', after: 'func (r *Repo) Send(ctx context.Context) error', logic: 'trivial', hunks: ['H3.1'] },
    { id: 'u4', kind: 'method', module: 'git', name: 'diffText', change: 'mod', after: 'diffText(repo, base, head): Promise<string>', logic: 'trivial', hunks: ['H3.2'] },
    { id: 'u5', kind: 'config', module: 'orchestrator', name: 'DEFAULT_PLAYBOOK.fact', change: 'mod', hunks: ['H4.1'] },
    { id: 'u6', kind: 'model', module: 'git', name: 'MailParams', change: 'add', stored: false, after: 'struct { To string }', hunks: ['H5.1'] },
    { id: 'u7', kind: 'model', module: 'jobs', name: 'store.Job', change: 'mod', stored: true, hunks: ['H6.1'] },
    { id: 'u8', kind: 'field', module: 'jobs', name: 'Job.SentAt', change: 'add', stored: true, after: '*time.Time', hunks: ['H6.2'] },
    { id: 'u9', kind: 'field', module: 'jobs', name: 'Job.State', change: 'mod', stored: true, before: 'string', after: 'JobState', hunks: ['H6.3'] },
    { id: 'u10', kind: 'field', module: 'jobs', owner: 'Job', name: 'Job.sent', change: 'rename', from: 'Job.done', stored: true, after: 'bool', hunks: ['H6.4'] },
    { id: 'u11', kind: 'index', module: 'jobs', owner: 'Job', name: 'idx_job_key', change: 'add', after: 'unique (Key)', hunks: ['H7.1'] },
    { id: 'u12', kind: 'dependency', module: 'orchestrator', name: 'git', change: 'add', hunks: ['H1.1'] },
    { id: 'u13', kind: 'dependency', module: 'jobs', name: 'github.com/aws/aws-sdk-go', change: 'del', hunks: ['H8.1'] },
  ],
  noise: [],
}

test('inventoryDiagrams: Component has the units as lines of their modules, with marks, badges and files; deps are uses', () => {
  const files: Record<string, string> = { H1: 'apps/poc/src/main/orchestrator.ts', H3: 'svc/git.go' }
  const { component, data } = inventoryDiagrams(INVENTORY, architecture, { filesOf: (ids) => [...new Set(ids.map((id) => files[id.split('.')[0]]).filter(Boolean))], dataId: 'data1' })
  assert.deepEqual(validateDiagram(component), [])
  assert.equal(component.summary, 'The fact is an inventory. mag draws Component and Data.')
  const byId = Object.fromEntries(component.modules.map((m) => [m.id, m]))
  assert.deepEqual(Object.keys(byId), ['orchestrator', 'git', 'jobs', 'github.com/aws/aws-sdk-go'])
  assert.deepEqual(byId.orchestrator.interface, [
    { text: 'factOf(stepId: string): Promise<string>', diff: 'del', files: ['apps/poc/src/main/orchestrator.ts'], logic: true },
    { text: 'factOf(stepId: string, heads: Heads): Promise<string>', diff: 'add', files: ['apps/poc/src/main/orchestrator.ts'], logic: true },
    { text: 'seed(of: string): SeedDiagram[]', diff: 'del', private: true },
    { text: 'DEFAULT_PLAYBOOK.fact', diff: 'mod' },
  ])
  assert.deepEqual(byId.git.interface, [
    { text: 'Send(ctx context.Context) error', diff: 'move', from: 'git#Deliver', files: ['svc/git.go'] },
    { text: 'diffText(repo, base, head): Promise<string>', diff: 'mod', files: ['svc/git.go'] },
    { text: 'MailParams: struct { To string }', diff: 'add' },
  ], 'argument structs are lines of their module, never data')
  assert.deepEqual([byId.orchestrator.diff, byId.git.diff, byId.jobs.diff, byId.orchestrator.name, byId.orchestrator.layer], ['mod', 'mod', 'add', 'Orchestrator', 'service'], 'a module the architecture lacks is new')
  assert.deepEqual(byId.orchestrator.uses, [{ to: 'git', calls: [], diff: 'add', files: ['apps/poc/src/main/orchestrator.ts'] }])
  assert.deepEqual(byId.jobs.uses, [{ to: 'github.com/aws/aws-sdk-go', calls: [], diff: 'del' }])
  assert.equal(byId['github.com/aws/aws-sdk-go'].kind, 'external')
  assert.equal(byId['github.com/aws/aws-sdk-go'].diff, undefined)
  assert.deepEqual(byId.jobs.links, [{ to: 'data1', kind: 'data' }])

  assert.ok(data)
  assert.deepEqual(validateDiagram(data), [])
  assert.deepEqual(data.entities, [
    {
      id: 'Job', name: 'Job', kind: 'table', module: 'jobs', diff: 'mod',
      fields: [
        { name: 'SentAt', type: '*time.Time', diff: 'add' },
        { name: 'State', type: 'string → JobState', diff: 'mod' },
        { name: 'sent', type: 'bool', diff: 'move', from: 'Job.done' },
        { name: 'Key', type: '…' },
      ],
      indexes: [{ fields: ['Key'], unique: true, diff: 'add' }],
    },
  ], 'only stored data, each field one line, a renamed one move')
  assert.equal(inventoryDiagrams({ ...INVENTORY, units: INVENTORY.units.slice(0, 6) }, architecture).data, null)
})

test('withScenarioLinks / logicUnit: modules link the scenarios they take part in; only a nontrivial method is a flowchart', () => {
  const seq: SequenceDiagram = { type: 'sequence', participants: [{ id: 'orchestrator', label: 'o' }, { id: 'git', label: 'g' }, { id: 'user', label: 'u' }], messages: [] }
  const { component } = inventoryDiagrams(INVENTORY, architecture, { scenarios: [{ id: 's1', diagram: seq }] })
  const links = (d: ComponentDiagram) => d.modules.map((m) => [m.id, m.links?.map((l) => l.to) ?? []])
  assert.deepEqual(links(component).filter(([, l]) => l.length), [['orchestrator', ['s1']], ['git', ['s1']]])
  assert.deepEqual(links(withScenarioLinks(component, [{ id: 's1', diagram: { ...seq, participants: [] } }])).filter(([, l]) => l.length), [], 'a scenario no longer of a module unlinks')
  const set = [
    { id: 'root', projectId: 'p', taskId: 't', kind: 'diagram' as const, diagram: component, role: 'fact' as const, stepId: 's', title: 'fact', root: true },
    { id: 's1', projectId: 'p', taskId: 't', kind: 'diagram' as const, diagram: seq, role: 'fact' as const, stepId: 's', title: 'scenario' },
  ]
  assert.deepEqual(validateLinks(set), [])
  assert.equal(logicUnit(INVENTORY, 'orchestrator', 'factOf')?.id, 'u1')
  assert.equal(logicUnit(INVENTORY, 'git', 'diffText'), undefined, 'trivial logic')
  assert.equal(logicUnit(INVENTORY, 'git', 'factOf'), undefined, 'another module')
})
