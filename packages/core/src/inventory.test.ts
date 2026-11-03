import { test } from 'node:test'
import assert from 'node:assert/strict'
import { folderLayer, inventoryDiagrams, logicUnit, groupedName, normalizeInventory, parseCall, unitRuleProblems, validateDiagram, validateLinks, withScenarioLinks, type ArchNode, type ChangeInventory, type ComponentDiagram, type SequenceDiagram } from './index.ts'

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
    'Unit x: kind must be one of method, model, field, index, dependency, call, config, template',
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

test('inventoryDiagrams: a signature that differs only by receiver or whitespace is one mod line, its logic badge kept', () => {
  const method = (id: string, before: string, after: string): ChangeInventory['units'][number] => ({ id, kind: 'method', module: 'docs', name: `Client.${id}`, change: 'mod', before, after, logic: 'nontrivial', visibility: 'private', hunks: ['H1.1'] })
  const inventory: ChangeInventory = {
    summary: ['s'],
    units: [
      method('fetch', 'func (c *Client) fetch(ctx context.Context, id string) ([]byte, error)', 'func (c *client) fetch(ctx context.Context, id string) ([]byte, error)'),
      method('store', 'func (Client) store(ctx context.Context,  doc Doc) error', 'func (cl client) store(ctx context.Context, doc Doc) error'),
      method('send', 'func (c *Client) send(ctx context.Context) error', 'func (c *client) send(ctx context.Context, to string) error'),
    ],
    noise: [],
  }
  const { component } = inventoryDiagrams(inventory, [])
  assert.deepEqual(component.modules[0].interface, [
    { text: 'fetch(ctx context.Context, id string) ([]byte, error)', diff: 'mod', logic: true, private: true },
    { text: 'store(ctx context.Context, doc Doc) error', diff: 'mod', logic: true, private: true },
    { text: 'send(ctx context.Context) error', diff: 'del', logic: true, private: true },
    { text: 'send(ctx context.Context, to string) error', diff: 'add', logic: true, private: true },
  ])
})

test('inventoryDiagrams without an architecture: own folder modules are not external and take their layer from the folder; a package is', () => {
  const unit = (id: string, module: string, extra: Partial<ChangeInventory['units'][number]> = {}): ChangeInventory['units'][number] => ({ id, kind: 'method', module, name: id, change: 'add', after: `${id}()`, logic: 'trivial', hunks: ['H1.1'], ...extra })
  const inventory: ChangeInventory = {
    summary: ['s'],
    units: [
      unit('serve', 'internal/handlers/billing'),
      unit('charge', 'internal/services/billing'),
      unit('save', 'internal/repositories/invoices'),
      unit('main', 'cmd'),
      unit('format', 'pkg/money'),
      unit('d1', 'internal/handlers/billing', { kind: 'dependency', name: 'internal/services/billing' }),
      unit('d2', 'internal/services/billing', { kind: 'dependency', name: 'internal/repositories/invoices' }),
      unit('d3', 'internal/services/billing', { kind: 'dependency', name: 'github.com/stripe/stripe-go' }),
    ],
    noise: [],
  }
  const { component } = inventoryDiagrams(inventory, [])
  assert.deepEqual(component.modules.map((m) => [m.id, m.layer ?? null, m.kind ?? null, m.diff ?? null]), [
    ['internal/handlers/billing', 'app', null, 'mod'],
    ['internal/services/billing', 'service', null, 'mod'],
    ['internal/repositories/invoices', 'client', null, 'mod'],
    ['cmd', 'app', null, 'mod'],
    ['pkg/money', null, null, 'mod'],
    ['github.com/stripe/stripe-go', null, 'external', null],
  ])
  assert.deepEqual([folderLayer('src-clients'), folderLayer('apps/web/handlers/x'), folderLayer('servicesx'), folderLayer('lib')], ['client', 'app', undefined, undefined])
})

test('inventoryDiagrams: a method line says what it does, "signature - note"; a changed signature carries the note on its add line (diff-iak-inventar-zmin-ai.2)', () => {
  const method = (id: string, change: 'add' | 'mod' | 'del', before: string | undefined, after: string | undefined, note?: string): ChangeInventory['units'][number] => ({ id, kind: 'method', module: 'svc', name: id, change, ...(before && { before }), ...(after && { after }), ...(note && { note }), logic: 'trivial', hunks: ['H1.1'] })
  const inventory: ChangeInventory = {
    summary: ['s'],
    units: [
      method('Send', 'add', undefined, 'func (s *Svc) Send(ctx context.Context) error', 'emails the request'),
      method('Log', 'del', 'func (s *Svc) Log(msg string)', undefined, 'the mock goes'),
      method('RequestRemoval', 'mod', 'func (s *Svc) RequestRemoval(ctx context.Context, id string) error', 'func (s *Svc) RequestRemoval(ctx context.Context, id string) error', 'sends the email   instead of logging'),
      method('Get', 'mod', 'func (s *Svc) Get(id string) Doc', 'func (s *Svc) Get(id string) (Doc, error)', 'returns integrity errors'),
      method('Plain', 'add', undefined, 'Plain()'),
    ],
    noise: [],
  }
  assert.deepEqual(inventoryDiagrams(inventory, []).component.modules[0].interface, [
    { text: 'Send(ctx context.Context) error - emails the request', diff: 'add' },
    { text: 'Log(msg string) - the mock goes', diff: 'del' },
    { text: 'RequestRemoval(ctx context.Context, id string) error - sends the email instead of logging', diff: 'mod' },
    { text: 'Get(id string) Doc', diff: 'del' },
    { text: 'Get(id string) (Doc, error) - returns integrity errors', diff: 'add' },
    { text: 'Plain()', diff: 'add' },
  ])
})

test('inventoryDiagrams: call units are marked lines on the use of their caller; one makes the use when no dependency did (diff-iak-inventar-zmin-ai.2)', () => {
  const call = (id: string, name: string, change: 'add' | 'mod' | 'del', before?: string, after?: string, extra: Partial<ChangeInventory['units'][number]> = {}): ChangeInventory['units'][number] => ({ id, kind: 'call', module: 'orchestrator', name, change, ...(before && { before }), ...(after && { after }), hunks: ['H1.1'], ...extra })
  const inventory: ChangeInventory = {
    summary: ['s'],
    units: [
      { id: 'd1', kind: 'dependency', module: 'orchestrator', name: 'git', change: 'add', hunks: ['H1.1'] },
      call('c1', 'git#Ensure', 'add', undefined, 'err := o.git.Ensure(ctx, key)'),
      call('c2', 'git#MarkSent', 'add', undefined, 'o.git.MarkSent(ctx, key, now)'),
      call('c3', 'github#Fetch', 'mod', 'gh.Fetch(ctx, id)', 'gh.Fetch(ctx, id, opts)'),
      call('c4', 'github#Close', 'mod', 'gh.Close(ctx,id)', 'gh.Close(ctx, id)'),
      call('c5', 'git#Deliver', 'del', 'o.git.Deliver(ctx)'),
      call('c6', 'github.com/sendgrid/sendgrid-go#Send', 'add', undefined, 'client.Send(msg)', { external: true, hunks: ['H2.1'] }),
    ],
    noise: [],
  }
  const files: Record<string, string> = { H1: 'orchestrator.ts', H2: 'mail.ts' }
  const { component } = inventoryDiagrams(inventory, architecture, { filesOf: (ids) => [...new Set(ids.map((id) => files[id.split('.')[0]]))] })
  assert.deepEqual(validateDiagram(component), [])
  const o = component.modules.find((m) => m.id === 'orchestrator')!
  assert.deepEqual(o.uses, [
    {
      to: 'git', diff: 'add', files: ['orchestrator.ts'],
      calls: [
        { text: 'Ensure(ctx, key)', diff: 'add', files: ['orchestrator.ts'] },
        { text: 'MarkSent(ctx, key, now)', diff: 'add', files: ['orchestrator.ts'] },
        { text: 'Deliver(ctx)', diff: 'del', files: ['orchestrator.ts'] },
      ],
    },
    {
      to: 'github', diff: 'mod', files: ['orchestrator.ts'],
      calls: [
        { text: 'Fetch(ctx, id)', diff: 'del', files: ['orchestrator.ts'] },
        { text: 'Fetch(ctx, id, opts)', diff: 'add', files: ['orchestrator.ts'] },
        { text: 'Close(ctx, id)', diff: 'mod', files: ['orchestrator.ts'] },
      ],
    },
    { to: 'github.com/sendgrid/sendgrid-go', diff: 'mod', files: ['mail.ts'], calls: [{ text: 'Send(msg)', diff: 'add', files: ['mail.ts'] }] },
  ], 'a use no dependency unit made changes by its calls: mod')
  assert.equal(o.interface, undefined, 'calls are no interface lines')
  assert.equal(component.modules.find((m) => m.id === 'github.com/sendgrid/sendgrid-go')?.kind, 'external')
  assert.equal(component.modules.find((m) => m.id === 'github')?.kind, '3rd-party API', 'a module of the architecture keeps its kind')
})

test('normalizeInventory / unitRuleProblems: one name per unit; a call is "<target>#<method>"; a changed method needs before, after and note (diff-iak-inventar-zmin-ai.2)', () => {
  const unit = (extra: Record<string, unknown>) => ({ id: 'u1', kind: 'method', module: 'm', change: 'add', logic: 'trivial', hunks: ['H1.1'], ...extra })
  for (const name of ['ErrDocumentIntegrity, ErrDocumentNotFound', 'get / ensureActive', 'Get/Set'])
    assert.deepEqual(normalizeInventory({ summary: ['s'], units: [unit({ kind: 'model', name })], noise: [] }).errors, [`Unit u1 (${name}): one name per unit; give each its own unit`])
  assert.deepEqual(normalizeInventory({ summary: ['s'], units: [unit({ name: 'app.whenReady callback' }), unit({ id: 'u2', kind: 'dependency', name: 'internal/services/billing' }), unit({ id: 'u3', kind: 'template', name: 'prompts/review.md' })], noise: [] }).errors, [])
  assert.equal(groupedName({ kind: 'dependency', name: 'a, b' }), true)
  assert.equal(groupedName({ kind: 'call', name: 'pkg/x#Get/Set' }), true)
  assert.deepEqual(normalizeInventory({ summary: ['s'], units: [unit({ kind: 'call', name: 'Ensure' }), unit({ id: 'u2', kind: 'call', name: 'git#Ensure', change: 'rename', from: 'git#Make' })], noise: [] }).errors, [
    'Unit u1 (Ensure): a call is named "<target module>#<method>" ("<package>#<func>" outside the project)',
    'Unit u2 (git#Ensure): a call changes by add, del or mod (its arguments)',
  ])
  const ok = normalizeInventory({ summary: ['s'], units: [unit({ kind: 'call', name: 'github.com/x/y#Send', external: true })], noise: [] })
  assert.deepEqual([ok.errors, ok.inventory.units[0].external], [[], true])
  assert.deepEqual([parseCall('dar_jobs#Ensure'), parseCall('a#b#c'), parseCall('#x'), parseCall('x#'), parseCall('x')], [{ target: 'dar_jobs', method: 'Ensure' }, { target: 'a#b', method: 'c' }, null, null, null])
  const mod = (extra: Partial<ChangeInventory['units'][number]>): ChangeInventory['units'][number] => ({ id: 'u1', kind: 'method', module: 'm', name: 'Get', change: 'mod', logic: 'trivial', hunks: ['H1.1'], ...extra })
  assert.deepEqual(unitRuleProblems(mod({ before: 'Get()', after: 'Get()', note: 'reads the cache first' })), [])
  assert.deepEqual(unitRuleProblems(mod({ after: 'Get()' })), ['a changed method needs before, note: its old and new signature and what changes in it'])
  assert.deepEqual(unitRuleProblems(mod({ kind: 'model' })), [], 'only methods')
  assert.deepEqual(unitRuleProblems(mod({ change: 'add', name: 'a, b' })), ['one name per unit: give each its own unit'])
})
