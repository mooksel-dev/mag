// The fact service knows no step and no git: changes from any source, against a plan or none (reviews-ahent-reviuit-pr-timeitiv.1,
// reviews-prybraty-spysok-pr-i.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Canvas, ComponentDiagram, Project } from '@mag/core'
import type { FileDiff } from '@mag/diff'
import { changes, check, factReport, hunk, seed, type ChangeSource } from './index.ts'

const project = {
  baseBranch: 'main',
  architecture: { summary: '', updatedAt: 1, modules: [{ id: 'api', name: 'api', description: '', uses: [], paths: ['src/api'] }] },
} as unknown as Project

const DIFF: FileDiff[] = [
  { path: 'src/api/users.ts', status: 'mod', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }] },
  { path: 'src/jobs/sync.ts', status: 'add', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }] },
] as FileDiff[]

/** A source that is not git: what a PR's diff from GitHub will be. */
const source: ChangeSource = {
  diffHunks: async (at, base, head) => (at === 'gh:o/app#7' && base === 'aaaaaaa' && head === 'bbbbbbb' ? DIFF : []),
  hunkLines: async (_at, _base, _head, ref) => [`+${ref.path}`],
}

const target = { repo: 'o/app', name: 'app', at: 'gh:o/app#7', base: 'aaaaaaa', head: 'bbbbbbb' }

const PLAN: ComponentDiagram = {
  type: 'component',
  summary: 'users gets list',
  modules: [
    { id: 'api', name: 'api', description: '', uses: [], interface: [{ text: 'list(): User[]', diff: 'add' }] },
    { id: 'jobs', name: 'jobs', description: '', uses: [], path: 'src/jobs', diff: 'add', interface: [{ text: 'sync(): void', diff: 'add' }] },
  ],
}

const canvas = (id: string, diagram: ComponentDiagram, version = 1) => ({ id, title: id, version, diagram }) as unknown as Canvas

test('changes: files of any source, owned by the architecture and the modules the plan adds', async () => {
  const none = await changes(project, [target], source)
  assert.deepEqual(none.files.map((f) => [f.repo, f.path, f.module]), [['app', 'src/api/users.ts', 'api'], ['app', 'src/jobs/sync.ts', null]])
  assert.deepEqual(none.repos, [{ repo: 'o/app', name: 'app', baseSha: 'aaaaaaa', headSha: 'bbbbbbb' }])
  const withPlan = await changes(project, [target], source, [canvas('plan', PLAN)])
  assert.deepEqual(withPlan.files.map((f) => f.module), ['api', 'jobs'])
})

test('seed and check: the fact starts as a copy of the plan and is checked against files and plan', async () => {
  const plan = [canvas('plan', PLAN)]
  const changed = await changes(project, [target], source, plan)
  const [start] = seed('o/app#7', plan, changed.files, project.architecture)
  assert.deepEqual([start.from, start.root, start.title], ['plan', true, 'o/app#7: fact'])
  assert.deepEqual((start.diagram as ComponentDiagram).modules, PLAN.modules)
  assert.match((start.diagram as ComponentDiagram).summary ?? '', /^Fact of o\/app#7, started as a copy/)

  const unchecked = check(project, changed, [], plan)
  assert.equal(unchecked.blockers[0], 'there is no fact diagram of the PRs yet')

  const drawn: ComponentDiagram = {
    ...PLAN,
    modules: [
      { ...PLAN.modules[0], interface: [{ text: 'list(): User[]', diff: 'add', files: ['src/api/users.ts'] }] },
      { ...PLAN.modules[1], interface: [{ text: 'sync(): void', diff: 'add', files: ['src/jobs/sync.ts'] }] },
    ],
  }
  const fact = check(project, changed, [canvas('fact', drawn, 2)], plan)
  assert.deepEqual(fact.coverage!.unshown, [])
  assert.deepEqual(fact.comparison.items.map((i) => i.status), ['match', 'match', 'match'])
  assert.deepEqual(fact.blockers, [])
  assert.match(factReport(fact, 1), /## Plan ↔ fact \(mag\)[\s\S]*Fact set: root \[fact\]\(canvas:fact\) \(v2\), revised\./)
})

test("check without a plan (a teammate's PR): coverage and grounding only, no plan ↔ fact (reviews-prybraty-spysok-pr-i.1)", async () => {
  const changed = await changes(project, [target], source)
  const seeded = seed('o/app#7', [], changed.files, project.architecture)
  assert.deepEqual(seeded.map((d) => [d.from, d.root]), [[null, true]])
  const start = seeded[0].diagram as ComponentDiagram
  // The architecture's api, then src/jobs by its folder: no module owns it.
  assert.deepEqual(start.modules.map((m) => [m.id, m.path]), [['api', undefined], ['src-jobs', 'src/jobs']])
  assert.match(start.summary ?? '', /no plan diagram/)

  // Everything on the fact would be unplanned against an empty plan; without one nothing is compared.
  const drawn: ComponentDiagram = {
    ...PLAN,
    modules: [
      { ...PLAN.modules[0], interface: [{ text: 'list(): User[]', diff: 'add', files: ['src/api/users.ts'] }] },
      { ...PLAN.modules[1], interface: [{ text: 'sync(): void', diff: 'add', files: ['src/jobs/sync.ts'] }] },
    ],
  }
  const fact = check(project, changed, [canvas('fact', drawn, 2)], null)
  assert.deepEqual([fact.plan, fact.comparison.items], [null, []])
  assert.deepEqual(fact.blockers, [])
  const empty = check(project, changed, [canvas('fact', drawn, 2)], []).comparison.items
  assert.ok(empty.length && empty.every((i) => i.status === 'unplanned'))
  const report = factReport(fact, 1)
  assert.match(report, /^## Fact \(mag\)\n/)
  assert.match(report, /### The fact is complete: it shows every changed code file, method, model, logic and dependency and rests on the PR\./)
  assert.doesNotMatch(report, /Plan|plan ↔ fact/)

  const unshown = factReport(check(project, changed, [canvas('fact', start, 1)], null), 1)
  assert.match(unshown, /started by mag: nothing on it rests on the PR yet[\s\S]*### The fact is not complete yet\n  - app:src\/api\/users\.ts \(api\) is changed/)
})

test('hunk: through the source, between commit shas only', async () => {
  assert.deepEqual(await hunk(source, target.at, target.base, target.head, { path: 'src/api/users.ts', ...DIFF[0].hunks[0] }), ['+src/api/users.ts'])
  await assert.rejects(hunk(source, target.at, 'HEAD', target.head, { path: 'x', ...DIFF[0].hunks[0] }), /commit shas/)
})

test('changes: a repository outside the project reads by its folders, not the project architecture (reviews-ahent-reviuit-pr-timeitiv.3)', async () => {
  const outside = await changes(project, [{ ...target, outside: true }], source, [canvas('plan', PLAN)])
  assert.equal(outside.outside, true)
  // The plan's jobs module (src/jobs) first, then the folders: src/api is a folder module, not the project's api.
  assert.deepEqual(outside.files.map((f) => [f.path, f.module]), [['src/api/users.ts', 'src-api'], ['src/jobs/sync.ts', 'jobs']])
  const fact = check(project, outside, [canvas('fact', PLAN, 2)], [canvas('plan', PLAN)])
  assert.equal(fact.outside, true)
  assert.match(factReport(fact, null), /Without the project architecture: the repository is outside the project/)
  assert.equal((await changes(project, [target], source)).outside, false)
})

/** A diff with hunk headers and lines, as local git gives it (povnyi-diff-nabir-pov-iazanykh.1). */
const UNITS_DIFF: FileDiff[] = [
  {
    path: 'src/api/users.ts',
    status: 'mod',
    hunks: [
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, header: 'export function list(limit: number): User[] {', lines: ['-  return all', '+  if (!limit) return []', '+  return all.slice(0, limit)'] },
      { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+import { sync } from '../jobs/sync'"] },
    ],
  },
] as FileDiff[]

const unitsSource: ChangeSource = { diffHunks: async () => UNITS_DIFF, hunkLines: async () => [] }

test('check: changed methods, logic and dependencies must be on the fact set or in its notes; links hold the set together (povnyi-diff-nabir-pov-iazanykh.1)', async () => {
  const arch = { ...project, architecture: { ...project.architecture!, modules: [...project.architecture!.modules, { id: 'jobs', name: 'jobs', description: '', uses: [], paths: ['src/jobs'] }] } } as Project
  const changed = await changes(arch, [target], unitsSource)
  assert.deepEqual(changed.units.map((u) => [u.kind, u.name, u.diff, u.confidence, u.bodyChanged]), [['method', 'list', 'mod', 'high', true], ['dependency', 'jobs', 'add', 'high', undefined]])
  // The files go on without the lines changedUnits read.
  assert.equal(changed.files[0].hunks[0].lines, undefined)

  const component = (iface: ComponentDiagram['modules'][number]['interface'], uses: ComponentDiagram['modules'][number]['uses'] = []): ComponentDiagram => ({
    type: 'component',
    summary: 's',
    modules: [{ id: 'api', name: 'api', description: '', uses, interface: iface }, { id: 'jobs', name: 'jobs', description: '', uses: [] }],
  })
  const line = { text: 'list(limit: number): User[]', diff: 'mod' as const, files: ['src/api/users.ts'] }
  const bare = check(arch, changed, [canvas('fact', component([line]), 2)], null)
  assert.deepEqual(bare.completeness!.missing.map((m) => m.rule), ['logic', 'dependency'])
  assert.equal(bare.blockers.length, 2)
  assert.match(factReport(bare, 1), /### Changed methods, models, logic and dependencies\n[\s\S]*the logic of list changes[\s\S]*api starts depending on jobs/)

  // A flowchart linked from the line, the dependency drawn: complete; the flowchart is reached from the root.
  const flow = { id: 'flow', title: 'list', version: 1, root: false, diagram: { type: 'flowchart', nodes: [{ id: 'a', label: 'a', shape: 'start' }], edges: [] } } as unknown as Canvas
  const linked = component([{ ...line, links: [{ to: 'flow', kind: 'logic' }] }], [{ to: 'jobs', calls: [], diff: 'add', files: ['src/api/users.ts'] }])
  const root = { ...canvas('fact', linked, 2), root: true }
  const done = check(arch, changed, [root, flow], null)
  assert.deepEqual([done.completeness!.missing, done.warnings, done.blockers], [[], [], []])
  assert.match(factReport(done, 1), /Other diagrams of the set: \[list\]\(canvas:flow\) \(flowchart, v1\)/)

  // Without the link the flowchart is an orphan, and the logic is not shown.
  const orphan = check(arch, changed, [{ ...canvas('fact', component([line], linked.modules[0].uses), 2), root: true }, flow], null)
  assert.deepEqual(orphan.completeness!.missing.map((m) => m.rule), ['logic'])
  assert.match(orphan.warnings.join('\n'), /"list" \(flow\) is not reached from the root/)

  // trivialLogic, or a note, explain it instead.
  const trivial = check(arch, changed, [canvas('fact', component([{ ...line, trivialLogic: 'логіка тривіальна: a guard' }], linked.modules[0].uses), 2)], null)
  assert.deepEqual(trivial.blockers, [])
  const noted = { ...canvas('fact', component([line], linked.modules[0].uses), 2), notes: [{ kind: 'logic' as const, name: 'list', why: 'a guard' }] }
  assert.deepEqual(check(arch, changed, [noted], null).blockers, [])
})
