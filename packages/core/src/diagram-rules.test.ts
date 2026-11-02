import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagramSummary, diagramWarnings, normalizeDiagram, validateDiagram, type ComponentDiagram, type DataDiagram } from './index.ts'

// The data of duff-brewery#297 as it should be drawn (canvas e73b7434): stored data in its modules, related.
const DATA = (): DataDiagram => ({
  type: 'data',
  entities: [
    {
      id: 'dar_jobs',
      name: 'dar_jobs',
      kind: 'collection',
      module: 'dar_jobs',
      fields: [
        { name: 'user_id', type: 'string' },
        { name: 'inbox_id', type: 'string' },
        { name: 'domain', type: 'string' },
        { name: 'alias', type: 'string' },
        { name: 'sent_at', type: 'time?', diff: 'add' },
      ],
      indexes: [{ fields: ['alias'], unique: true }],
    },
    { id: 'dar_user_states', name: 'dar_user_states', kind: 'collection', module: 'dar_user_states', fields: [{ name: 'user_id', type: 'string' }] },
    { id: 'phalcon_accounts', name: 'accounts', kind: 'table', module: 'phalcon', fields: [{ name: 'user_id', type: 'string' }] },
  ],
  relations: [
    { from: 'dar_jobs', to: 'dar_user_states', kind: 'N:1', field: 'user_id', cross: true },
    { from: 'dar_jobs', to: 'phalcon_accounts', kind: '1:1', field: 'inbox_id', cross: true },
  ],
})

test('validateDiagram data: an index is on fields of its entity; module and cross are typed (povnyi-diff-nabir-pov-iazanykh.3)', () => {
  assert.deepEqual(validateDiagram(DATA()), [])
  const d = DATA()
  d.entities[0].indexes!.push({ fields: ['user_id', 'inbox_id', 'nope'], unique: true, diff: 'add' })
  assert.deepEqual(validateDiagram(d), ['Index (user_id, inbox_id, nope) of dar_jobs: no field "nope" in dar_jobs; add it (unmarked, when it does not change)'])
  // Fields of an index given as one string; an added index counts as a change.
  const n = normalizeDiagram({ ...DATA(), entities: [{ ...DATA().entities[1], indexes: [{ fields: 'user_id', unique: true, diff: 'add' }] }], relations: [] }) as DataDiagram
  assert.deepEqual(n.entities[0].indexes, [{ fields: ['user_id'], unique: true, diff: 'add' }])
  assert.equal(diagramSummary(n).add, 1)
})

test('diagramWarnings data: an owner module, stored data only, a relation per reference field, cross between modules', () => {
  assert.deepEqual(diagramWarnings(DATA()), [])
  const d = DATA()
  delete d.entities[1].module
  d.relations[0].cross = undefined
  // Arguments of a call and a client on a data diagram (as #297 drew them).
  d.entities.push({ id: 'JobKey', name: 'JobKey', kind: 'struct', module: 'dar_jobs', fields: [{ name: 'UserID', type: 'string' }] })
  d.entities.push({ id: 'sendgrid', name: 'sendgrid.Client', kind: 'type', module: 'sendgrid', fields: [] })
  d.entities[0].fields.push({ name: 'signing_ceremony_id', type: 'string', diff: 'add' })
  const w = diagramWarnings(d)
  assert.equal(w.length, 4, w.join('\n'))
  assert.match(w[0], /^Field "signing_ceremony_id" of dar_jobs refers to another entity/)
  assert.match(w[1], /^Entity dar_user_states has no module/)
  assert.match(w[2], /^Entity JobKey \(struct\): not stored data\?/)
  assert.match(w[3], /^Entity sendgrid \(type\): not stored data\?/)
  // Without a module on one end, cross is not asked for; with both, it is.
  d.entities[1].module = 'dar_user_states'
  assert.match(diagramWarnings(d).join('\n'), /Relation dar_jobs → dar_user_states is between modules dar_jobs and dar_user_states: mark it cross: true/)
  // An embedded document a collection holds is stored; an unchanged entity's reference fields need nothing.
  const e = DATA()
  e.entities.push({ id: 'Response', name: 'Response', kind: 'struct', module: 'dar_jobs', fields: [{ name: 'from_email', type: 'string' }] })
  e.relations.push({ from: 'dar_jobs', to: 'Response', kind: '1:N' })
  e.entities[2].fields.push({ name: 'company_id', type: 'string' })
  assert.deepEqual(diagramWarnings(e), [])
})

test('diagramWarnings: no mocks or test-only types; a rename is one move line', () => {
  const c: ComponentDiagram = {
    type: 'component',
    summary: 's',
    modules: [
      {
        id: 'sendgrid',
        name: 'sendgrid',
        description: '',
        uses: [],
        interface: [
          { text: 'SendEmail(ctx, params): error', diff: 'add' },
          { text: 'MockClient.SendEmail(ctx, params): error - testify mock', diff: 'add' },
          { text: 'helper(x): void', diff: 'add', files: ['internal/clients/sendgrid/client_test.go'] },
          // The description may say "mock": the removed mocked sending is a change of the design.
          { text: 'RequestRemoval(ctx, in): Result - sends the email, no longer a mock', diff: 'mod' },
          { text: 'RenderAccountCleanupRequest(ctx, data): string', diff: 'del' },
          { text: 'RenderDarDeletionRequest(ctx, data): string', diff: 'add' },
          // One argument alike is no sign of a rename.
          { text: 'load(id): Item', diff: 'del' },
          { text: 'save(id): Item', diff: 'add' },
        ],
      },
    ],
  }
  const w = diagramWarnings(c)
  assert.equal(w.length, 3, w.join('\n'))
  assert.match(w[0], /^Interface line "MockClient\.SendEmail.*mocks, fakes and test-only types are never on a diagram/)
  assert.match(w[1], /^Interface line "helper\(x\): void" of sendgrid rests on test files only/)
  assert.match(w[2], /keep one line with diff move and from "sendgrid#RenderAccountCleanupRequest"/)

  const d: DataDiagram = {
    type: 'data',
    entities: [
      { id: 'AccountCleanupRequestData', name: 'AccountCleanupRequestData', kind: 'collection', module: 't', diff: 'del', fields: [{ name: 'a', type: 's' }, { name: 'b', type: 's' }, { name: 'c', type: 's' }] },
      { id: 'DarDeletionRequestData', name: 'DarDeletionRequestData', kind: 'collection', module: 't', diff: 'add', fields: [{ name: 'a', type: 's' }, { name: 'b', type: 's' }, { name: 'd', type: 's' }] },
      { id: 'MockStore', name: 'MockStore', kind: 'collection', module: 't', fields: [] },
    ],
    relations: [],
  }
  const dw = diagramWarnings(d)
  assert.equal(dw.length, 2, dw.join('\n'))
  assert.match(dw[0], /^Entity MockStore: mocks/)
  assert.match(dw[1], /draw DarDeletionRequestData once with diff move and from "AccountCleanupRequestData"/)
})
