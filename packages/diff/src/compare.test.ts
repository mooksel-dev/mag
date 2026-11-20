import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ArchNode, ComponentDiagram, DataDiagram, Diagram, DNode } from '@mag/core'
import { deviationsLine } from '@mag/core'
import { additionLine, callSignature, compare, entityWord, formatComparison, planDeviations, backedBy, outsideLine, planOverlay, sameCall } from './compare.ts'
import { createDiff, fileKind } from './files.ts'
import { formatFiles } from './format.ts'
import { diagramChanges, lineName, planWarnings } from './plan.ts'
import { parseSignificance, significance, withLevels } from './significance.ts'
import { planVocabulary, vocabularyOf } from './vocabulary.ts'
import type { Change } from './types.ts'

const texts = (cmp: Parameters<typeof planDeviations>[0]) => planDeviations(cmp).map((d) => d.text)

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

test('callSignature: name and arguments, without the result and the description', () => {
  assert.equal(callSignature('check(project, set: Canvas[]): Fact - checks it'), 'check(project,set:Canvas[])')
  assert.equal(callSignature('run(fn: (x: number) => void) error'), 'run(fn:(x:number)=>void)')
  assert.equal(callSignature('DEFAULT_PLAYBOOK.fact: string - the fact'), 'DEFAULT_PLAYBOOK.fact')
  assert.equal(callSignature(undefined), '')
})

test('compare: match by key, mark and call (other text is a note), differs by mark or call, missing; a line of a planned module is an addition; inner modules stand for an outer one', () => {
  // The fact: the plan as it was done.
  const fact = diagram([
    dnode('orchestrator', {
      diff: 'mod',
      interface: [
        { text: 'review(stepId): void', diff: 'del', files: [ORCH] },
        { text: 'review(stepId, heads, round): void', diff: 'add', files: [ORCH] },
        { text: 'factOf( stepId ): Promise<Fact> - the fact of a step', diff: 'add', files: [ORCH] },
        { text: 'cancel(taskId): void' },
        { text: 'groom(taskId): void', diff: 'del', files: [ORCH] },
        { text: 'develop(stepId): void', diff: 'add', files: [ORCH] },
      ],
      uses: [{ to: 'git', calls: [], diff: 'add', files: [ORCH] }],
    }),
    dnode('git'),
  ])
  const cmp = compare(withLevels(diagramChanges(PLAN), []), withLevels(diagramChanges(fact), []), architecture)
  const rows = cmp.items.map((i) => [i.status, (i.plan ?? i.fact)!.key, i.how])
  assert.deepEqual(rows, [
    ['differs', 'orchestrator#review', 'signature'],
    ['differs', 'orchestrator#groom', 'mark'],
    ['missing', 'orchestrator#cancel', undefined],
    ['match', 'orchestrator#factOf', undefined],
    ['match', 'orchestrator -> git', undefined],
    ['match', 'orchestrator', undefined],
  ])
  assert.equal(cmp.items[0].note, 'planned review(stepId, heads): void, done review(stepId, heads, round): void')
  assert.equal(cmp.items[3].note, 'planned factOf(stepId): Fact, done factOf( stepId ): Promise<Fact> - the fact of a step', 'another result or description: a match')
  assert.deepEqual(cmp.additions.map((a) => [a.module, a.changes.map((c) => c.key)]), [['orchestrator', ['orchestrator#develop']]], 'a method in a planned module: an addition')
  assert.deepEqual(texts(cmp), [
    'orchestrator: review has another signature than planned',
    'orchestrator: groom is removed, planned changed inside',
    'orchestrator: cancel is planned, not done',
  ])
  // A plan drawn on the app is matched by the fact on its inner module.
  const outer = diagram([dnode('app', { interface: [{ text: 'factOf(stepId): Fact', diff: 'add' }] })])
  const inner = diagram([dnode('orchestrator', { interface: [{ text: 'factOf(stepId)  :  Fact', diff: 'add', files: [ORCH] }] })])
  assert.deepEqual(compare(diagramChanges(outer), diagramChanges(inner), architecture).items.map((i) => i.status), ['match'])
})

/** A plan of one changed method of the orchestrator, against a fact of it and `more`. */
const planned = (more: DNode[] = [], line = 'review(stepId, heads): void') => {
  const plan = diagram([dnode('orchestrator', { diff: 'mod', interface: [{ text: 'review(stepId): void', diff: 'del' }, { text: 'review(stepId, heads): void', diff: 'add' }] })])
  const fact = diagram([dnode('orchestrator', { diff: 'mod', interface: [{ text: 'review(stepId): void', diff: 'del', files: [ORCH] }, { text: line, diff: 'add', files: [ORCH] }] }), ...more])
  return compare(withLevels(diagramChanges(plan), []), withLevels(diagramChanges(fact), []), architecture)
}

test('compare: helpers of a planned module and an existing module changed outside the plan are no deviations; a new module is one, a new dependency none; neither blocks', () => {
  const ok = planned([
    dnode('orchestrator', { interface: [{ text: 'helper(x)', diff: 'add', files: [ORCH] }] }),
    dnode('git', { diff: 'mod', interface: [{ text: 'diffHunks(repo, base, head)', diff: 'mod', files: [GIT] }] }),
  ])
  assert.deepEqual(texts(ok), [])
  assert.deepEqual(ok.additions.map(additionLine), ['+1 helper in orchestrator'])
  assert.equal(outsideLine(ok.outside), 'Also changed outside the plan: git (1)')
  assert.match(formatComparison(ok, []), /^The fact is complete[\s\S]*Plan ↔ fact: as planned\. It never blocks[\s\S]*\+1 helper in orchestrator: add helper[\s\S]*Also changed outside the plan: git \(1\)/)

  const bad = planned([
    dnode('cache', { diff: 'add', path: 'apps/app/src/cache.ts', interface: [{ text: 'get(key)', files: ['apps/app/src/cache.ts'] }] }),
    dnode('tools', { uses: [{ to: 'git', diff: 'add', files: ['apps/app/src/tools.ts'], calls: [{ text: 'diffHunks(repo)', diff: 'add' }] }] }),
  ])
  assert.deepEqual(texts(bad), ['new module cache, not on the plan (1 change in it)'])
  assert.match(formatComparison(bad, ['H1.1 is changed code in no unit']), /^The fact is not complete, so merge is not allowed yet:\n  - H1\.1 is changed code in no unit\nPlan ↔ fact: 1 deviation\. It never blocks/)
  assert.match(formatComparison(bad, [], 'a cache module'), /Plan ↔ fact: 1 deviation \(1 backed by the doc\)[\s\S]*cache.*\[backed by the doc\]/)
  const overlay = planOverlay(bad, architecture)
  assert.deepEqual(overlay.modules, { orchestrator: 'match' })
  assert.deepEqual(overlay.unplanned, { modules: [{ id: 'cache', name: 'cache', within: [] }], edges: [{ from: 'tools', to: 'git' }] })
})

test('compare: a project rule at critical lifts a change inside the plan to a deviation (an external contract)', () => {
  const plan = diagram([dnode('tools', { diff: 'mod', interface: [{ text: 'run(args)', diff: 'mod' }] })])
  const fact = diagram([dnode('tools', { diff: 'mod', interface: [{ text: 'run(args)', diff: 'mod', files: ['apps/app/src/tools.ts'] }, { text: 'review_pr(url)', diff: 'add', files: ['apps/app/src/tool-defs.ts'] }] })])
  const rules = parseSignificance('critical: apps/app/src/tool-defs.ts')
  const cmp = compare(withLevels(diagramChanges(plan), rules), withLevels(diagramChanges(fact), rules), architecture)
  assert.deepEqual(texts(cmp), ['tools: review_pr is added, not on the plan (critical: an external contract)'])
  assert.deepEqual(cmp.additions, [])
  assert.deepEqual(planOverlay(cmp, architecture).modules, { tools: 'differs' })
})

test('sameCall: name and the number of required arguments; names, types and optional arguments aside; … stands for the existing ones', () => {
  assert.ok(sameCall('migratePrReview(raw): PrReview', 'migratePrReview(raw, sessionId?): PrReview - more'), 'an added optional argument')
  assert.ok(sameCall('runReviewFormat(taskId, format)', 'runReviewFormat(workId: string, format: ReviewFormat)'), 'renamed and typed')
  assert.ok(sameCall('FormatSwitch(review): JSX', 'FormatSwitch({work, review, running, onError}): JSX'), 'one argument, destructured')
  assert.ok(sameCall('load(id, fresh = false)', 'load(id)'), 'a default is optional')
  assert.ok(sameCall('review_pr(url, format?): text', 'review_pr - + format?'), 'a line without arguments names any call of its name')
  assert.ok(!sameCall('setPrReview(taskId, result): void', 'setPrReview(workId, sessionId, r)'), 'a new required argument')
  assert.ok(!sameCall('review(id)', 'groom(id)'))
  assert.ok(sameCall('reviewPr(…, format?)', 'reviewPr(projectId, url, by?, format?)'), '… is the existing arguments: only format counts')
  assert.ok(sameCall('reviewPr(..., format?)', 'reviewPr(projectId, url, format)'))
  assert.ok(!sameCall('reviewPr(…, format?)', 'reviewPr(projectId, url)'), 'the listed argument is not there')
  // In compare: an optional argument is as planned, a required one otherwise.
  assert.deepEqual(planned([], 'review(stepId, heads, round?): void').items.map((i) => i.status), ['match', 'match'])
  assert.deepEqual(planned([], 'review(stepId, heads, round): void').items.map((i) => [i.status, i.how]), [['differs', 'signature'], ['match', undefined]])
})

const DATA = (entities: DataDiagram['entities']): DataDiagram => ({ type: 'data', entities, relations: [] })

test('diagramChanges of a Data diagram: entities and fields, those of a new entity take its mark', () => {
  const changes = diagramChanges(DATA([
    { id: 'projects', name: 'projects (db.json)', kind: 'collection', module: 'store', diff: 'mod', fields: [{ name: 'reviewFormat', type: 'string', diff: 'add' }, { name: 'name', type: 'string' }] },
    { id: 'Result', name: 'Result', kind: 'table', module: 'store', diff: 'add', fields: [{ name: 'at', type: 'number' }] },
  ]))
  assert.deepEqual(changes.map((c) => [c.kind, c.key, c.diff, c.after]), [
    ['entity', 'store/projects', 'mod', undefined],
    ['field', 'store/projects.reviewFormat', 'add', 'reviewFormat: string'],
    ['entity', 'store/Result', 'add', undefined],
    ['field', 'store/Result.at', 'add', 'at: number'],
  ])
  assert.equal(entityWord('projects (db.json)'), entityWord('Project'))
  assert.notEqual(entityWord('sessions'), entityWord('AgentSession'))
})

test('compare of entities: by name across owner modules, a move out of a field is its del, a new entity is a deviation, another name stays one', () => {
  const plan = DATA([
    { id: 'projects', name: 'projects (db.json)', kind: 'collection', module: 'store', diff: 'mod', fields: [{ name: 'reviewFormat', type: 'string', diff: 'add' }] },
    { id: 'sessions', name: 'sessions', kind: 'collection', module: 'store', fields: [{ name: 'reviewFormat', type: 'string', diff: 'add' }] },
    { id: 'PrReview', name: 'Task.prReview (embedded)', kind: 'struct', module: 'review', diff: 'mod', fields: [{ name: 'verdict', type: 'string', diff: 'del' }] },
    { id: 'Result', name: 'Result', kind: 'struct', module: 'review', diff: 'add', fields: [{ name: 'verdict', type: 'string', diff: 'move', from: 'PrReview.verdict' }] },
  ])
  const fact = DATA([
    { id: 'Project', name: 'Project', kind: 'table', module: 'model', fields: [{ name: 'reviewFormat', type: 'ReviewFormat', diff: 'add' }, { name: 'theme', type: 'string', diff: 'add' }] },
    { id: 'AgentSession', name: 'AgentSession', kind: 'table', module: 'model', fields: [{ name: 'reviewFormat', type: 'string', diff: 'add' }] },
    { id: 'Result', name: 'Result', kind: 'table', module: 'review', diff: 'add', fields: [{ name: 'verdict', type: 'string', diff: 'move', from: 'PrReview.verdict' }] },
    { id: 'Legacy', name: 'Legacy', kind: 'table', module: 'review', diff: 'add', fields: [{ name: 'old', type: 'string' }] },
  ])
  const cmp = compare(diagramChanges(plan), diagramChanges(fact), [])
  assert.deepEqual(texts(cmp), ['store: sessions.reviewFormat is planned, not done', 'new entity Legacy (review), not on the plan (1 change in it)'])
  const matches = cmp.items.filter((i) => i.status === 'match')
  assert.deepEqual(matches.map((i) => i.plan!.key).sort(), ['review/PrReview', 'review/PrReview.verdict', 'review/Result', 'review/Result.verdict', 'store/projects', 'store/projects.reviewFormat'])
  assert.equal(matches.find((i) => i.plan!.key === 'review/PrReview.verdict')!.note, 'planned del, done move to Result.verdict')
  assert.deepEqual(cmp.additions.map(additionLine), ['+1 field in model/Project'], 'a field of a planned entity')
  assert.equal(outsideLine(cmp.outside), 'Also changed outside the plan: model/AgentSession (1)', 'sessions is not AgentSession')
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

test('compare on review-v2-part-2-v1-2.1 (a fixture of its plan and fact): only plan-level changes are deviations; helpers fold per module', async () => {
  const { readFileSync } = await import('node:fs')
  const { DEFAULT_PLAYBOOK } = await import('@mag/core')
  const x = JSON.parse(readFileSync(new URL('./fixtures/plan-fact-21.json', import.meta.url), 'utf8')) as { plan: Diagram[]; fact: Diagram[] }
  const rules = parseSignificance(DEFAULT_PLAYBOOK.significance)
  const cmp = compare(withLevels(x.plan.flatMap(diagramChanges), rules), withLevels(x.fact.flatMap(diagramChanges), rules), [], { calls: false })
  const blockers = texts(cmp)
  assert.deepEqual(blockers.filter((b) => !/^core-pr-review: (PrReview|ReviewResult)\./.test(b)), [
    'orchestrator: prReviewPrompt has another signature than planned',
    'orchestrator: setPrReview has another signature than planned',
    'store: sessions.reviewFormat is planned, not done',
    'new entity LegacyPrReview (core-pr-review), not on the plan',
  ])
  // The fact's moves into ReviewResult name ReviewResult itself as where they came from, so the planned dels of PrReview find none.
  assert.equal(blockers.length, 15)
  assert.equal(cmp.items.filter((i) => i.status === 'match').length, 33)
  assert.deepEqual(cmp.additions.map(additionLine), ['+12 helpers in core-pr-review', '+4 helpers in core-playbook', '+3 helpers, +1 call in store', '+6 helpers, +2 calls in agent-tools', '+7 helpers, +4 calls in orchestrator', '+3 helpers, +2 calls in reviews-view'])
  assert.equal(outsideLine(cmp.outside), 'Also changed outside the plan: main-entry (6), home-view (4), renderer-app (2), core-model/AgentSession (1), core-model (1), diff-set-view (1)')
})

test('planDeviations: the doc backs a deviation that names it, or every field folded under it; deviationsLine says it in one line (review-v3-concise-design-first.3)', () => {
  const fact = DATA([
    { id: 'IssuesReport', name: 'IssuesReport', kind: 'struct', module: 'review', diff: 'add', fields: [{ name: 'intent', type: 'string', diff: 'add' }, { name: 'issues', type: 'Issue[]', diff: 'add' }] },
    { id: 'LegacyReport', name: 'LegacyReport', kind: 'struct', module: 'review', diff: 'add', fields: [{ name: 'problem', type: 'string', diff: 'add' }] },
  ])
  const cmp = compare([], diagramChanges(fact), [])
  const plan = 'The new report: `intent`, `verdict`, `issues[]`.'
  assert.deepEqual(planDeviations(cmp, plan).map((d) => [d.text, d.backed]), [
    ['new entity IssuesReport (review), not on the plan (2 changes in it)', true],
    ['new entity LegacyReport (review), not on the plan (1 change in it)', false],
  ])
  assert.equal(backedBy(cmp.items[1], 'Old reports are read as LegacyReport.'), true, 'by its own name')
  assert.equal(backedBy(cmp.items[1], 'no problems here'), false, 'a word inside another is no mention')
  assert.equal(backedBy(cmp.items[0], ''), false)
  assert.equal(deviationsLine(planDeviations(cmp, plan)), '2 deviations (1 backed by the doc)')
  assert.equal(deviationsLine([]), 'as planned')
})
