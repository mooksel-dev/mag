import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ArchNode, ComponentDiagram, DNode } from '@mag/core'
import { compare, coverage, formatComparison, grounding, mergeBlockers } from './compare.ts'
import { createDiff, fileKind } from './files.ts'
import { formatFiles } from './format.ts'
import { diagramChanges, lineName, planWarnings } from './plan.ts'
import { parseSignificance, significance, withLevels } from './significance.ts'
import { moduleResolver, planVocabulary, vocabularyOf } from './vocabulary.ts'
import type { Change, FileChange } from './types.ts'

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({ id, name: id, description: '', uses: [], ...extra })
const architecture: ArchNode[] = [
  node('app', {
    level: 'system',
    paths: ['apps/app'],
    children: [
      node('orchestrator', { layer: 'service', paths: ['apps/app/src/orchestrator.ts'] }),
      node('git', { layer: 'client', paths: ['apps/app/src/git.ts'] }),
      node('tools', { layer: 'app', paths: ['apps/app/src/tools.ts', 'apps/app/src/tool-defs.ts'] }),
    ],
  }),
  node('github', { level: 'system', kind: '3rd-party API' }),
]

const ORCH = 'apps/app/src/orchestrator.ts'
const GIT = 'apps/app/src/git.ts'
const dnode = (id: string, extra: Partial<DNode> = {}): DNode => ({ id, name: id, description: '', uses: [], ...extra })
const diagram = (modules: DNode[]): ComponentDiagram => ({ type: 'component', summary: 's', modules })
const file = (path: string, status: FileChange['status'] = 'mod', extra: Partial<FileChange> = {}): FileChange => ({
  path, status, hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 }], repo: 'r', module: null, kind: fileKind(path), ...extra,
})
const ownerOf = moduleResolver(vocabularyOf(architecture))
const owned = (files: FileChange[]) => files.map((f) => ({ ...f, module: ownerOf(f.path) }))

test('fileKind: code by default, whatever the language; tests, styles, locks, generated and docs are not', () => {
  const kinds = (paths: string[]) => paths.map(fileKind)
  assert.deepEqual(kinds(['a.ts', 'svc/main.go', 'app/models.py', 'App/View.swift', 'infra/main.tf', 'db/1.sql', 'package.json']), Array(7).fill('code'))
  assert.deepEqual(kinds(['a.test.ts', 'x_test.go', 'tests/test_a.py', 'test_b.py', 'AppTests/ViewTests.swift', 'src/__tests__/a.ts']), Array(6).fill('test'))
  assert.deepEqual(kinds(['a.css', 'b.module.scss']), ['style', 'style'])
  assert.deepEqual(kinds(['pnpm-lock.yaml', 'go.sum', 'poetry.lock', 'web/package-lock.json']), Array(4).fill('lock'))
  assert.deepEqual(kinds(['dist/a.js', 'api/x.pb.go', 'x_pb2.py', 'a.min.js']), Array(4).fill('generated'))
  assert.deepEqual(kinds(['README.md', 'docs/arch.ts', 'LICENSE', 'logo.png']), Array(4).fill('docs'))
})

test('changedFiles: the diff with the owner module and kind of each file', async () => {
  const engine = createDiff({ diffHunks: async () => [{ path: ORCH, status: 'mod', hunks: [] }, { path: 'x.test.ts', status: 'add', hunks: [] }, { path: GIT, oldPath: 'apps/app/src/g.ts', status: 'rename', hunks: [] }] })
  const files = await engine.changedFiles({ path: '/r', name: 'r' }, 'a', 'b', vocabularyOf(architecture))
  assert.deepEqual(files.map((f) => [f.path, f.module, f.kind, f.repo]), [[ORCH, 'orchestrator', 'code', 'r'], ['x.test.ts', null, 'test', 'r'], [GIT, 'git', 'code', 'r']])
  const text = formatFiles('r', 'a'.repeat(40), 'b'.repeat(40), files)
  assert.match(text, /3 file\(s\) changed, 2 of them code/)
  assert.match(text, /\n {2}> apps\/app\/src\/git\.ts \(from apps\/app\/src\/g\.ts\): 0 hunk\(s\)/)
  assert.match(text, /not code: \+ x\.test\.ts \(test\)$/)
})

test('lineName: the name a line is about, past its keywords', () => {
  assert.equal(lineName('review(stepId): void'), 'review')
  assert.equal(lineName('export async function factOf(stepId: string)'), 'factOf')
  assert.equal(lineName('interface StepFact { heads }'), 'StepFact')
  assert.equal(lineName('Task.fact?: StepFact'), 'Task.fact?')
  assert.equal(lineName('resource "aws_dynamodb_table" "users"'), 'aws_dynamodb_table')
})

test('diagramChanges: modules, lines (a del + add of one name is a signature change), dependencies and calls, with files', () => {
  const changes = diagramChanges(
    diagram([
      dnode('orchestrator', {
        diff: 'mod',
        interface: [
          { text: 'review(stepId): void', diff: 'del', files: [ORCH] },
          { text: 'review(stepId, heads): void', diff: 'add', files: [ORCH] },
          { text: 'groom(taskId)', diff: 'mod' },
          { text: 'cancel(taskId)' },
        ],
        uses: [{ to: 'git', diff: 'add', files: [ORCH], calls: [{ text: 'diffHunks(repo, base, head)' }] }],
      }),
      dnode('git'),
      dnode('fact', { diff: 'add', path: 'apps/app/src/fact.ts', interface: [{ text: 'stepFact(step): Fact' }] }),
    ]),
  )
  assert.deepEqual(changes.map((c) => [c.kind, c.key, c.diff, c.part, c.files]), [
    ['module', 'orchestrator', 'mod', undefined, undefined],
    ['element', 'orchestrator#review', 'mod', 'signature', [ORCH]],
    ['element', 'orchestrator#groom', 'mod', 'body', undefined],
    ['edge', 'orchestrator -> git', 'add', undefined, [ORCH]],
    ['call', 'orchestrator -> git#diffHunks', 'add', undefined, [ORCH]],
    ['module', 'fact', 'add', undefined, undefined],
    ['element', 'fact#stepFact', 'add', undefined, undefined],
  ])
  assert.equal(changes[1].before, 'review(stepId): void')
  assert.equal(changes[5].path, 'apps/app/src/fact.ts')
})

test('significance: defaults by kind of change, the project rules first (by files and name)', () => {
  const ch = (extra: Partial<Change>): Change => ({ key: 'k', kind: 'element', diff: 'add', module: 'orchestrator', name: 'review', ...extra })
  const lvl = (c: Change, rules = '') => significance(c, parseSignificance(rules))
  assert.equal(lvl(ch({ diff: 'mod', part: 'signature' })), 'high')
  assert.equal(lvl(ch({ diff: 'mod', part: 'body' })), 'medium')
  assert.equal(lvl(ch({ kind: 'edge', name: 'git' })), 'high')
  assert.equal(lvl(ch({ kind: 'call' })), 'medium')
  assert.equal(lvl(ch({ kind: 'module', diff: 'add' })), 'high')
  const rules = 'Prose is ignored.\nhigh: #*prompt*\nnoise: apps/app/src/git.ts\nlow: apps/app/src/tools.ts#run'
  assert.equal(lvl(ch({ name: 'reviewPrompt', diff: 'mod', part: 'body' }), rules), 'high')
  assert.equal(lvl(ch({ name: 'diffHunks', files: [GIT] }), rules), 'noise')
  assert.equal(lvl(ch({ name: 'run', files: ['apps/app/src/tools.ts'] }), rules), 'low')
  assert.equal(lvl(ch({ name: 'run' }), rules), 'high', 'a path rule needs the files')
  assert.deepEqual(parseSignificance('high: #*PROMPT*\nhuge: x\nlow: a/b'), [
    { level: 'high', path: null, name: '*PROMPT*' },
    { level: 'low', path: 'a/b', name: null },
  ])
})

const PLAN = diagram([
  dnode('orchestrator', {
    diff: 'mod',
    interface: [
      { text: 'review(stepId): void', diff: 'del' },
      { text: 'review(stepId, heads): void', diff: 'add' },
      { text: 'factOf(stepId): Fact', diff: 'add' },
      { text: 'cancel(taskId): void', diff: 'del' },
      { text: 'groom(taskId): void', diff: 'mod' },
    ],
    uses: [{ to: 'git', calls: [], diff: 'add' }],
  }),
  dnode('git'),
])

test('compare: match by key, differs by mark or line, missing, unplanned; inner modules stand for an outer one', () => {
  // The fact: a copy of the plan, revised under the diff.
  const fact = diagram([
    dnode('orchestrator', {
      diff: 'mod',
      interface: [
        { text: 'review(stepId): void', diff: 'del', files: [ORCH] },
        { text: 'review(stepId, heads, round): void', diff: 'add', files: [ORCH] },
        { text: 'factOf(stepId): Fact', diff: 'add', files: [ORCH] },
        { text: 'cancel(taskId): void' },
        { text: 'groom(taskId): void', diff: 'del', files: [ORCH] },
        { text: 'develop(stepId): void', diff: 'add', files: [ORCH] },
      ],
      uses: [{ to: 'git', calls: [], diff: 'add', files: [ORCH] }],
    }),
    dnode('git'),
  ])
  const { items } = compare(withLevels(diagramChanges(PLAN), []), withLevels(diagramChanges(fact), []), architecture)
  const rows = items.map((i) => [i.status, (i.plan ?? i.fact)!.key, i.level])
  assert.deepEqual(rows, [
    ['differs', 'orchestrator#review', 'high'],
    ['differs', 'orchestrator#groom', 'high'],
    ['missing', 'orchestrator#cancel', 'high'],
    ['unplanned', 'orchestrator#develop', 'high'],
    ['match', 'orchestrator#factOf', 'high'],
    ['match', 'orchestrator -> git', 'high'],
    ['match', 'orchestrator', 'medium'],
  ])
  assert.equal(items[0].note, 'planned review(stepId, heads): void, done review(stepId, heads, round): void')
  assert.equal(items[1].note, 'planned mod (body), done del')
  // A plan drawn on the app is matched by the fact on its inner module.
  const outer = diagram([dnode('app', { interface: [{ text: 'factOf(stepId): Fact', diff: 'add' }] })])
  const inner = diagram([dnode('orchestrator', { interface: [{ text: 'factOf(stepId)  :  Fact', diff: 'add', files: [ORCH] }] })])
  assert.deepEqual(compare(diagramChanges(outer), diagramChanges(inner), architecture).items.map((i) => i.status), ['match'])
})

test('coverage: a changed code file is shown only when a changed line gives it in files', () => {
  const files = owned([file(ORCH), file(GIT), file('apps/app/src/tools.ts'), file('scripts/x.ts'), file('apps/app/src/a.test.ts'), file('README.md')])
  const fact = diagram([
    dnode('orchestrator', { interface: [{ text: 'factOf(stepId): Fact', diff: 'add', files: [ORCH, 'scripts/x.ts'] }] }),
    dnode('git'),
    dnode('tools', { interface: [{ text: 'run()' }] }),
  ])
  const cov = coverage(files, fact)
  assert.deepEqual(cov.shown.map((f) => f.path), [ORCH, 'scripts/x.ts'])
  assert.deepEqual(cov.unshown.map((f) => f.path), [GIT, 'apps/app/src/tools.ts'], 'tests and docs are not code')
  // A module marked changed without lines that give files shows none of them (Decision 11).
  const marked = diagram([dnode('app', { diff: 'mod' }), dnode('orchestrator', { diff: 'mod', interface: [{ text: 'run()', diff: 'mod' }] })])
  assert.deepEqual(coverage(files, marked).shown, [])
  const blockers = mergeBlockers({ items: [] }, coverage(files, marked), grounding(marked, files, architecture))
  assert.ok(blockers.includes('r:apps/app/src/orchestrator.ts (orchestrator) is changed, the fact diagram does not show it'))
})

test('repo:path: the same path in two repositories is told apart; a plain one is ambiguous (Decision 13)', () => {
  const files = [file(ORCH, 'mod', { module: 'orchestrator' }), file(ORCH, 'mod', { repo: 'web', module: 'orchestrator' }), file(GIT, 'mod', { repo: 'web', module: 'git' })]
  const fact = diagram([
    dnode('orchestrator', {
      interface: [
        { text: 'factOf()', diff: 'add', files: [`r:${ORCH}`] },
        { text: 'groom()', diff: 'mod', files: [ORCH] },
      ],
    }),
    dnode('git', { interface: [{ text: 'diffHunks()', diff: 'add', files: [GIT] }] }),
  ])
  assert.deepEqual(coverage(files, fact).unshown.map((f) => `${f.repo}:${f.path}`), [`web:${ORCH}`])
  const g = grounding(fact, files, architecture)
  assert.deepEqual(g.grounded.map((c) => c.key), ['orchestrator#factOf', 'git#diffHunks'], 'a path only one repository changes needs no repo')
  assert.deepEqual(g.unverified.map((u) => [u.change.key, u.reason, u.files]), [['orchestrator#groom', 'ambiguous', [ORCH]]])
  assert.match(mergeBlockers({ items: [] }, coverage(files, fact), g).join('\n'), /orchestrator groom\(\): gives a path several repositories change: write <repo>:<path>/)
})

test('grounding: files in the PR and of the module; none, outside the PR or of another module is unverified', () => {
  const files = owned([file(ORCH), file(GIT), file('scripts/x.ts'), file('apps/app/src/fact.ts', 'add')])
  const fact = diagram([
    dnode('orchestrator', {
      interface: [
        { text: 'factOf(stepId): Fact', diff: 'add', files: [ORCH] },
        { text: 'groom(taskId)', diff: 'mod' },
        { text: 'cancel()', diff: 'del', files: ['apps/app/src/other.ts'] },
        { text: 'treeAt()', diff: 'add', files: [GIT] },
        { text: 'run()', diff: 'add', files: ['r:scripts/x.ts'] },
      ],
      uses: [{ to: 'git', diff: 'add', calls: [{ text: 'diffHunks()' }], files: [ORCH] }],
    }),
    dnode('git'),
    dnode('app', {
      interface: [{ text: 'boot()', diff: 'mod', files: ['apps/app/src/fact.ts'] }],
      children: [dnode('fact', { diff: 'add', path: 'apps/app/src/fact.ts', interface: [{ text: 'stepFact(step): Fact', files: ['apps/app/src/fact.ts'] }] })],
    }),
  ])
  const g = grounding(fact, files, architecture)
  assert.deepEqual(g.grounded.map((c) => c.key), ['orchestrator#factOf', 'orchestrator#run', 'orchestrator -> git', 'orchestrator -> git#diffHunks', 'app#boot', 'fact#stepFact'], 'a module the fact adds is inside the one it is drawn in')
  assert.deepEqual(g.unverified.map((u) => [u.change.key, u.reason, u.files]), [
    ['orchestrator#groom', 'no-files', []],
    ['orchestrator#cancel', 'not-in-pr', ['apps/app/src/other.ts']],
    ['orchestrator#treeAt', 'other-module', [GIT]],
  ])
})

test('mergeBlockers: unshown files, unverified lines and significant differences; none for a full, grounded, planned fact', () => {
  const files = owned([file(ORCH), file(GIT)])
  const fact = diagram([
    dnode('orchestrator', {
      diff: 'mod',
      interface: [
        { text: 'review(stepId): void', diff: 'del', files: [ORCH] },
        { text: 'review(stepId, heads): void', diff: 'add', files: [ORCH] },
        { text: 'factOf(stepId): Fact', diff: 'add', files: [ORCH] },
        { text: 'cancel(taskId): void', diff: 'del', files: [ORCH] },
        { text: 'groom(taskId): void', diff: 'mod', files: [ORCH] },
      ],
      uses: [{ to: 'git', calls: [], diff: 'add', files: [ORCH] }],
    }),
    dnode('git', { interface: [{ text: 'diffHunks(repo, base, head)', diff: 'add', files: [GIT] }] }),
  ])
  const plan = withLevels(diagramChanges(PLAN), [])
  const cmp = compare(plan, withLevels(diagramChanges(fact), []), architecture)
  const blockers = mergeBlockers(cmp, coverage(files, fact), grounding(fact, files, architecture))
  assert.deepEqual(blockers, ['high: git diffHunks(repo, base, head) is on the fact, not on the plan'])
  assert.match(formatComparison(cmp, blockers), /^Threshold: merge is NOT allowed/)

  const planned = { ...PLAN, modules: [PLAN.modules[0], fact.modules[1]] }
  const ok = compare(withLevels(diagramChanges(planned), []), withLevels(diagramChanges(fact), []), architecture)
  assert.deepEqual(mergeBlockers(ok, coverage(files, fact), grounding(fact, files, architecture)), [])
  assert.match(formatComparison(ok, []), /^Threshold: merge is allowed/)

  // The plan copied as it is: nothing rests on the PR.
  const copy = mergeBlockers(compare(plan, plan, architecture), coverage(files, PLAN), grounding(PLAN, files, architecture))
  assert.ok(copy.some((b) => b === 'r:apps/app/src/git.ts (git) is changed, the fact diagram does not show it'))
  assert.equal(copy.filter((b) => b.endsWith('gives no files of the PR')).length, 5)
  assert.deepEqual(mergeBlockers({ items: [] }, null, null), ['there is no fact diagram of the PRs yet'])
})

test('planWarnings: ids the architecture lacks, adds of what it has, new modules without a path', () => {
  const d = diagram([
    dnode('app', { children: [dnode('fact', { diff: 'add', path: 'apps/app/src/fact.ts' }), dnode('store', { diff: 'add', layer: 'service' })] }),
    dnode('orchestrator', { diff: 'add' }),
    dnode('cache'),
  ])
  assert.deepEqual(planWarnings(d, architecture).map((w) => [w.code, w.module]), [['no-path', 'store'], ['exists', 'orchestrator'], ['unknown-module', 'cache']])
  assert.deepEqual(planWarnings(d, []), [], 'no architecture, nothing to check against')
})

test('planVocabulary: a module the plan adds with a path joins the vocabulary', () => {
  const d = diagram([dnode('app', { children: [dnode('fact', { diff: 'add', path: 'apps/app/src/fact.ts' })] }), dnode('orchestrator')])
  assert.deepEqual(planVocabulary(architecture, [d]).modules.map((m) => m.id), [...vocabularyOf(architecture).modules.map((m) => m.id), 'fact'])
})
