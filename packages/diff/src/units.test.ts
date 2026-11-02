import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ArchNode, Diagram } from '@mag/core'
import { completeness, describeMissing } from './completeness.ts'
import { mergeBlockers } from './compare.ts'
import { fileKind } from './files.ts'
import { formatUnits } from './format.ts'
import { FUNCNAME_DRIVERS, changedUnits, funcnameAttributes, importsOf, isPublicName } from './units.ts'
import { vocabularyOf } from './vocabulary.ts'
import type { ChangedUnit, FileChange, Hunk } from './types.ts'

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({ id, name: id, description: '', uses: [], ...extra })
const ARCH: ArchNode[] = [
  node('app', {
    paths: ['src'],
    children: [node('api', { paths: ['src/api'], uses: [{ to: 'store', calls: [] }] }), node('store', { paths: ['src/store'] }), node('jobs', { paths: ['src/jobs'] })],
  }),
  node('core', { paths: ['packages/core'] }),
  node('db', { paths: ['db'] }),
]
const VOCABULARY = vocabularyOf(ARCH)

/** One hunk: its header (what git's driver named) and its changed lines. */
const hunk = (header: string | undefined, lines: string[], at = 10): Hunk => {
  const dels = lines.filter((l) => l[0] === '-').length
  return { oldStart: at, oldLines: dels, newStart: at, newLines: lines.length - dels, ...(header && { header }), lines }
}
const file = (path: string, hunks: Hunk[], module: string | null = null): FileChange => ({ path, status: 'mod', hunks, repo: 'r', module, kind: fileKind(path) })
const units = (...files: FileChange[]) =>
  changedUnits(files, ARCH, VOCABULARY).map((u) => `${u.kind} ${u.module} ${u.name} ${u.diff} ${u.confidence}${u.bodyChanged === undefined ? '' : u.bodyChanged ? ' body' : ' signature'}`)

test('changedUnits, TypeScript: the method a header names, declarations among the changed lines, public by export (povnyi-diff-nabir-pov-iazanykh.1)', () => {
  const f = file(
    'src/api/users.ts',
    [
      // A change in the body of a method git named, cut to 80 characters (no "{" at its end).
      hunk('  async list(limit: number, offset: number, filter: UserFilter): Promise<Use', ['-    return all', '+    return all.slice(0, limit)']),
      // A new exported function and a new private helper among the changed lines.
      hunk('export function list(limit: number) {', ['+', '+export function count(): number {', '+  return all.length', '+}', '+', '+function helper() {', '+  return 1', '+}']),
      // Only the signature changes.
      hunk(undefined, ['-export const remove = (id: string) => store.del(id)', '+export const remove = (id: string, soft = false) => store.del(id, soft)']),
      // A field of an exported interface is no stored data (povnyi-diff-nabir-pov-iazanykh.3); a comment changes nothing.
      hunk('export interface User {', ['+  email: string', '+  // the login']),
      // A call with a callback is no declaration: the body of run changes.
      hunk('  run() {', ['+    walkArch(nodes, (n) => {', '+      seen.add(n.id)', '+    })']),
      // A private method without logic, a module constant: not units.
      hunk('  private reset() {', ['-    this.n = 0', '+    this.n = 1']),
      hunk('export const LIMITS = {', ['-  max: 10,', '+  max: 20,']),
    ],
    'api',
  )
  assert.deepEqual(units(f), ['method api list mod high body', 'method api count add high body', 'method api remove mod high signature', 'method api run mod high body'])
})

test('changedUnits: Go, Python and Swift by their own conventions of public', () => {
  const go = file(
    'src/store/db.go',
    [
      hunk('func (s *Store) Load(id string) (Item, error) {', ['-\treturn s.get(id)', '+\treturn s.cached(id)']),
      hunk('func (s *Store) cached(id string) (Item, error) {', ['+\tif x { return y }']),
      hunk('type Item struct {', ['+\tTags []string `bson:"tags"`']),
      // Arguments of a call: no stored data.
      hunk('type ItemKey struct {', ['+\tID string']),
      hunk('var (', ['+\tlimit = 10']),
    ],
    'store',
  )
  const py = file(
    'src/jobs/sync.py',
    [
      hunk('    def run(self, since):', ['-        return []', '+        return self._fetch(since)']),
      hunk('    def _fetch(self, since):', ['+        pass']),
      hunk('class Job(Base):', ['+    retries = Column(Integer, default=3)']),
      hunk('class JobIn(BaseModel):', ['+    retries: int = 3']),
      hunk(undefined, ['+TIMEOUT = 30']),
    ],
    'jobs',
  )
  const swift = file('src/api/View.swift', [hunk('    public func reload(force: Bool) {', ['+        if force { cache.clear() }']), hunk('    private func tick() {', ['+        n += 1'])], 'api')
  assert.deepEqual(units(go, py, swift), [
    'method store Load mod high body',
    // A private method with logic (povnyi-diff-nabir-pov-iazanykh.3): its flowchart, no interface line.
    'method store cached mod high body',
    'model store Item mod high',
    'method jobs run mod high body',
    'model jobs Job mod high',
    'method api reload mod high body',
  ])
  assert.deepEqual([isPublicName('go', 'Load'), isPublicName('go', 'load'), isPublicName('py', '_x'), isPublicName('ts', '#x')], [true, false, false, false])
})

test('changedUnits: schemas are models by their tables, models and messages; Terraform only by its tables', () => {
  assert.deepEqual(
    units(
      file('db/migrations/003_tags.sql', [hunk(undefined, ['+ALTER TABLE public.items ADD COLUMN tags text[];'])], 'db'),
      file('db/migrations/004_fix.sql', [hunk(undefined, ["+UPDATE items SET tags = '{}';"])], 'db'),
      file('db/schema.prisma', [hunk('model User {', ['+  email String @unique'])], 'db'),
      file('db/api.proto', [hunk(undefined, ['+message Charge {', '+  string id = 1;', '+}'])], 'db'),
      file('db/tables.tf', [hunk('resource "aws_dynamodb_table" "orders" {', ['+  stream_enabled = true'])], 'db'),
      file('db/queue.tf', [hunk('resource "aws_sqs_queue" "jobs" {', ['+  delay_seconds = 5'])], 'db'),
    ),
    // A unique field is an index too (povnyi-diff-nabir-pov-iazanykh.3).
    ['model db public.items mod high', 'model db 004_fix mod high', 'index db User add high', 'model db User mod high', 'model db Charge add high', 'model db orders mod high'],
  )
})

test('changedUnits: imports added between modules; none inside a module or one the architecture has; removed and outside ones are unsure', () => {
  const ts = file(
    'src/api/users.ts',
    [
      hunk(
        undefined,
        [
          "+import { sync } from '../jobs/sync.ts'",
          "+import { load } from '../store/load'",
          "+import { helper } from './helper.ts'",
          "+import { thing } from '@acme/core'",
          "+import express from 'express'",
          "+import { readFileSync } from 'node:fs'",
          "-import { old } from '../../db/old.ts'",
        ],
        1,
      ),
    ],
    'api',
  )
  // store: the architecture has api using it; helper: api's own; node:fs: the standard library. @acme/core: the one
  // package folder named core. A removed import may leave others to the same module: unsure.
  assert.deepEqual(units(ts), ['dependency api jobs add high', 'dependency api core add high', 'dependency api express add low', 'dependency api db del low'])
  // An import moved between two files of a module cancels out.
  const moved = [file('src/api/a.ts', [hunk(undefined, ["-import { x } from '../jobs/x.ts'"], 1)], 'api'), file('src/api/b.ts', [hunk(undefined, ["+import { x } from '../jobs/x.ts'"], 1)], 'api')]
  assert.deepEqual(units(...moved), [])
  const go = file('src/store/db.go', [hunk(undefined, ['+\t"example.com/app/src/jobs"', '+\t"fmt"', '+\t"github.com/lib/pq"'], 3)], 'store')
  assert.deepEqual(units(go), ['dependency store jobs add high', 'dependency store github.com/lib/pq add low'])
  assert.deepEqual(units(file('src/jobs/run.py', [hunk(undefined, ['-from src.store.items import Item'], 1)], 'jobs')), ['dependency jobs store del low'])
  assert.deepEqual(importsOf('ts', "} from './x'"), ['./x'])
  assert.deepEqual(importsOf('py', 'import os, sys as s'), ['os', 'sys'])
})

test('changedUnits: code under no declaration mag can name is a low unit of its file; tests are not read', () => {
  assert.deepEqual(units(file('src/api/x.ts', [hunk(undefined, ['+    weird()'])], 'api'), file('src/api/x.test.ts', [hunk('export function t() {', ['+  x()'])], 'api')), [
    'method api  mod low signature',
  ])
})

test("funcname drivers: mag's TypeScript, Go, Python and Swift patterns, git's own for the rest", () => {
  assert.match(funcnameAttributes(), /^\*\.ts diff=magts$/m)
  assert.match(funcnameAttributes(), /^\*\.java diff=java$/m)
  const ts = FUNCNAME_DRIVERS.find((d) => d.name === 'magts')!.xfuncname!.split('\n')
  // The negation of a call with a callback comes before the method pattern that would take it.
  assert.ok(ts.findIndex((l) => l.startsWith('!') && l.includes('=>')) < ts.findIndex((l) => l.includes('public|private')))
})

const unit = (u: Partial<ChangedUnit>): ChangedUnit => ({ repo: 'r', file: 'src/api/users.ts', kind: 'method', name: 'list', module: 'api', diff: 'mod', confidence: 'high', line: 3, ...u })
const component = (modules: Extract<Diagram, { type: 'component' }>['modules']): Diagram => ({ type: 'component', summary: 's', modules })

test('completeness: each kind on its diagram or in a note; sure ones block merge, unsure ones only warn', () => {
  const all = [
    unit({ bodyChanged: true }),
    unit({ kind: 'model', name: 'users', file: 'db/1.sql', module: 'db' }),
    unit({ kind: 'dependency', name: 'core', module: 'api', diff: 'add' }),
    unit({ kind: 'method', name: '', confidence: 'low', file: 'src/api/x.ts' }),
  ]
  const missing = (set: Parameters<typeof completeness>[0]) => completeness(set, all, ARCH).missing.map((m) => `${m.rule} ${m.unit.name}`)
  assert.deepEqual(missing([]), ['method list', 'model users', 'dependency core', 'method '])

  const app = component([
    // A line of the module around api shows its method; the use goes from app, around api, too.
    { id: 'app', name: 'app', description: '', uses: [{ to: 'core', calls: [], diff: 'add' }], interface: [{ text: 'list(limit): User[]', diff: 'mod', files: ['src/api/x.ts'], links: [{ to: 'f', kind: 'logic' }] }] },
    { id: 'core', name: 'core', description: '', uses: [] },
  ])
  const data: Diagram = { type: 'data', entities: [{ id: 'public.User', name: 'User', kind: 'table', fields: [{ name: 'email', type: 'text', diff: 'add' }] }], relations: [] }
  const flow: Diagram = { type: 'flowchart', nodes: [], edges: [] }
  assert.deepEqual(missing([{ id: 'c', diagram: app }, { id: 'f', diagram: flow }, { id: 'd', diagram: data }]), [])
  // A logic link to a diagram outside the set shows no logic; a note explains it.
  assert.deepEqual(missing([{ id: 'c', diagram: app }, { id: 'd', diagram: data }]), ['logic list'])
  assert.deepEqual(missing([{ id: 'c', diagram: app, notes: [{ kind: 'logic', name: 'list', why: 'a guard' }] }, { id: 'd', diagram: data }]), [])

  const blockers = mergeBlockers({ items: [] }, { shown: [], unshown: [] }, { grounded: [], unverified: [] }, completeness([], all, ARCH))
  assert.equal(blockers.length, 3, 'the unsure unit is no blocker')
  assert.match(blockers[0], /^r:src\/api\/users\.ts:3: public method list changes: no changed interface line of api shows it/)
  assert.match(blockers[2], /api starts depending on core: no use api -> core is marked add on the set/)
  assert.match(formatUnits(all), /Public methods:\n {2}~ api list \(r:src\/api\/users\.ts:3\), logic changes\nModels \(stored data\):[\s\S]*Unsure \(warnings only\):\n {2}~ api \(no name\)/)
})

test('changedUnits: a PR diff with context lines, as duff-brewery#297 (povnyi-diff-nabir-pov-iazanykh.3)', () => {
  // The model: context lines say SentAt is in Job, a stored struct; JobKey has no tags, the arguments of a call.
  const models = file(
    'src/store/models.go',
    [
      hunk('type Response struct {', [
        ' \tAICategory AICategoryType `bson:"ai_category"`',
        ' }',
        ' ',
        '+type JobKey struct {',
        '+\tUserID  string',
        '+}',
        '+',
        ' type Job struct {',
        ' \tUserID    string     `bson:"user_id"`',
        '+\tSentAt    *time.Time `bson:"sent_at,omitempty"`',
        ' \tCreatedAt time.Time  `bson:"created_at"`',
        ' }',
      ]),
    ],
    'store',
  )
  const service = file(
    'src/api/request_removal.go',
    [
      hunk('func (s *Service) RequestRemoval(ctx context.Context, in Input) (*Result, error) {', [
        '-\ts.sendDeletionRequest(ctx, account)',
        '+\tif err := s.doSend(ctx, account); err != nil {',
        '+\t\treturn nil, err',
        '+\t}',
        ' ',
        ' \treturn &Result{}, nil',
        ' }',
        ' ',
        '+func keyFilter(key JobKey) bson.M {',
        '+\treturn bson.M{"user_id": key.UserID}',
        '+}',
        '+',
        '+func (s *Service) doSend(',
        '+\tctx context.Context,',
        '+\taccount *Account,',
        '+) error {',
        '+\tjob, err := s.repos.DarJobs.Ensure(ctx, key)',
        '+\tif err != nil {',
        '+\t\treturn err',
        '+\t}',
        '+\treturn nil',
        '+}',
        '+',
        '+func (s *Service) render(name string) string {',
        '+\treturn fmt.Sprintf("%s", name)',
        '+}',
        '-func (*Service) sendDeletionRequest(ctx context.Context, account *Account) {',
        '-\tlogger.Warn(ctx).Msg("mocked")',
        '-}',
      ]),
    ],
    'api',
  )
  // An index created; a mock of the repository is a test file, never read.
  const repo = file('src/store/repository.go', [hunk('func (r *repository) EnsureIndexes(ctx context.Context) error {', ['+\t\t{Keys: bson.D{{"user_id", 1}}, Options: options.Index().SetUnique(true)},'])], 'store')
  const mock = file('src/store/mock.go', [hunk('func (m *MockRepository) Ensure(ctx context.Context, key JobKey) (*Job, error) {', ['+\targs := m.Called(ctx, key)'])], 'store')
  const all = changedUnits([models, service, repo, mock], ARCH, VOCABULARY)
  assert.deepEqual(units(models, service, repo, mock), [
    'model store Job mod high',
    'method api RequestRemoval mod high body',
    // A private method with a branch: sure; with a call only: a guess; keyFilter has no logic, the removed one needs none.
    'method api doSend add high body',
    'method api render add low body',
    'index store EnsureIndexes add high',
    'method store EnsureIndexes mod high body',
  ])
  assert.deepEqual(all.filter((u) => u.kind === 'method').map((u) => [u.name, u.public, u.line]), [
    ['RequestRemoval', true, 10],
    ['doSend', false, 21],
    ['render', false, 32],
    ['EnsureIndexes', true, 10],
  ])
  assert.equal(fileKind('src/store/mock.go'), 'test')
  assert.equal(fileKind('internal/clients/sendgrid/mocks/client.go'), 'test')
  assert.equal(fileKind('src/api/users.mock.ts'), 'test')
})

test('changedUnits: stored types by ORM decorators and bases; indexes in schemas and migrations', () => {
  const ts = file('src/store/user.ts', [hunk(undefined, ['+@Entity()', '+export class User {', '+  @Column()', '+  email: string', '+}', '+export class UserInput {', '+  email: string', '+}'])], 'store')
  const swift = file('src/api/Item.swift', [hunk(undefined, ['+@Model', '+final class Item {', '+    var title: String', '+}'])], 'api')
  const sql = file('db/migrations/005_idx.sql', [hunk(undefined, ['+CREATE UNIQUE INDEX dar_jobs_key ON dar_jobs (user_id, inbox_id, domain);'])], 'db')
  const prisma = file('db/schema.prisma', [hunk('model User {', ['+  @@unique([email, tenant])'])], 'db')
  assert.deepEqual(units(ts, swift, sql, prisma), [
    'model store User add high',
    'model api Item add high',
    'index db dar_jobs add high',
    'model db 005_idx mod high',
    'index db User add high',
    'model db User mod high',
  ])
})

test('completeness: a private method shows its logic by a flowchart of it, an index by a changed index (povnyi-diff-nabir-pov-iazanykh.3)', () => {
  const all = [
    unit({ name: 'doSend', public: false, bodyChanged: true, diff: 'add' }),
    unit({ kind: 'index', name: 'EnsureIndexes', module: 'store', file: 'src/store/repository.go' }),
  ]
  const missing = (set: Parameters<typeof completeness>[0]) => completeness(set, all, ARCH).missing.map((m) => `${m.rule} ${m.unit.name}`)
  // No interface line is asked of a private method: only its logic.
  assert.deepEqual(missing([]), ['logic doSend', 'index EnsureIndexes'])
  assert.match(describeMissing(completeness([], all, ARCH).missing[0]), /the logic of private method doSend changes: no flowchart of the set has of api#doSend/)
  const data: Diagram = {
    type: 'data',
    entities: [{ id: 'dar_jobs', name: 'dar_jobs', kind: 'collection', module: 'store', fields: [{ name: 'user_id', type: 'string' }], indexes: [{ fields: ['user_id'], unique: true, diff: 'add' }] }],
    relations: [],
  }
  const flow: Diagram = { type: 'flowchart', of: 'api#doSend', nodes: [], edges: [] }
  assert.deepEqual(missing([{ id: 'd', diagram: data }, { id: 'f', diagram: flow }]), [])
  // A step of the caller's flowchart that names it and links its flowchart shows it too.
  const caller: Diagram = { type: 'flowchart', of: 'api#RequestRemoval', nodes: [{ id: 's', label: 'doSend(account)', shape: 'step', links: [{ to: 'g', kind: 'logic' }] }], edges: [] }
  const callee: Diagram = { type: 'flowchart', nodes: [], edges: [] }
  assert.deepEqual(missing([{ id: 'd', diagram: data }, { id: 'c', diagram: caller }, { id: 'g', diagram: callee }]), [])
  assert.deepEqual(missing([{ id: 'd', diagram: data, notes: [{ kind: 'logic', name: 'doSend', why: 'one guard' }] }]), [])
  assert.match(formatUnits(all), /Private methods with logic[^\n]*:\n {2}\+ api doSend \(r:src\/api\/users\.ts:3\), logic changes, private\nIndexes:\n {2}~ store EnsureIndexes/)
})

test('changedUnits: a Go method whose receiver alone changes is no change; a renamed Go module path resolves', () => {
  const go = file('src/store/client.go', [hunk('func (c *Client) ensure() {', ['-func (c *Client) Get(id string) error {', '+func (c *client) Get(id string) error {', '-func (c *Client) Put(id string) error {', '+func (c *client) Put(id string, v []byte) error {'])], 'store')
  assert.deepEqual(units(go), ['method store Put mod high signature'])
  // A Go module named without a dot is the project's, not the standard library.
  assert.deepEqual(units(file('src/api/h.go', [hunk(undefined, ['+\t"duff-brewery/src/jobs"', '+\t"strings"'], 3)], 'api')), ['dependency api jobs add high'])
})

test('completeness: a method renamed is one move line; it shows the removed old name too', () => {
  const all = [unit({ name: 'renderOld', diff: 'del' }), unit({ name: 'renderNew', diff: 'add', bodyChanged: true })]
  const app = component([
    { id: 'api', name: 'api', description: '', uses: [], interface: [{ text: 'renderNew(data): string', diff: 'move', from: 'api#renderOld', trivialLogic: 'renamed only' }] },
  ])
  assert.deepEqual(completeness([{ id: 'c', diagram: app }], all, ARCH).missing, [])
})
