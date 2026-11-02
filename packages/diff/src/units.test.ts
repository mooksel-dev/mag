import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ArchNode, Diagram } from '@mag/core'
import { completeness } from './completeness.ts'
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
      // A field of an exported interface; a comment changes nothing.
      hunk('export interface User {', ['+  email: string', '+  // the login']),
      // A call with a callback is no declaration: the body of run changes.
      hunk('  run() {', ['+    walkArch(nodes, (n) => {', '+      seen.add(n.id)', '+    })']),
      // A private method, a module constant: not units.
      hunk('  private reset() {', ['-    this.n = 0', '+    this.n = 1']),
      hunk('export const LIMITS = {', ['-  max: 10,', '+  max: 20,']),
    ],
    'api',
  )
  assert.deepEqual(units(f), ['method api list mod high body', 'method api count add high body', 'method api remove mod high signature', 'model api User mod high', 'method api run mod high body'])
})

test('changedUnits: Go, Python and Swift by their own conventions of public', () => {
  const go = file(
    'src/store/db.go',
    [
      hunk('func (s *Store) Load(id string) (Item, error) {', ['-\treturn s.get(id)', '+\treturn s.cached(id)']),
      hunk('func (s *Store) cached(id string) (Item, error) {', ['+\tif x { return y }']),
      hunk('type Item struct {', ['+\tTags []string']),
      hunk('var (', ['+\tlimit = 10']),
    ],
    'store',
  )
  const py = file(
    'src/jobs/sync.py',
    [
      hunk('    def run(self, since):', ['-        return []', '+        return self._fetch(since)']),
      hunk('    def _fetch(self, since):', ['+        pass']),
      hunk('class Job:', ['+    retries: int = 3']),
      hunk(undefined, ['+TIMEOUT = 30']),
    ],
    'jobs',
  )
  const swift = file('src/api/View.swift', [hunk('    public func reload(force: Bool) {', ['+        if force { cache.clear() }']), hunk('    private func tick() {', ['+        n += 1'])], 'api')
  assert.deepEqual(units(go, py, swift), [
    'method store Load mod high body',
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
    ['model db public.items mod high', 'model db 004_fix mod high', 'model db User mod high', 'model db Charge add high', 'model db orders mod high'],
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
  assert.match(formatUnits(all), /Public methods:\n {2}~ api list \(r:src\/api\/users\.ts:3\), logic changes\nModels:[\s\S]*Unsure \(warnings only\):\n {2}~ api \(no name\)/)
})
