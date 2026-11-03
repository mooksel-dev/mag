// The fact service knows no step and no git: changes from any source, against a plan or none (reviews-ahent-reviuit-pr-timeitiv.1,
// reviews-prybraty-spysok-pr-i.1); the fact is the reviewer's change inventory, checked against the hunks (diff-iak-inventar-zmin-ai.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Canvas, ChangeInventory, ComponentDiagram, Diagram, Project } from '@mag/core'
import type { FileDiff } from '@mag/diff'
import { changes, check, factDiagrams, factReport, filesOfHunks, flowchartRefusal, hunk, hunkListing, withoutLines, type ChangeSource } from './index.ts'

const project = {
  baseBranch: 'main',
  architecture: { summary: '', updatedAt: 1, modules: [{ id: 'api', name: 'api', description: '', uses: [], paths: ['src/api'] }] },
} as unknown as Project

const DIFF: FileDiff[] = [
  {
    path: 'src/api/users.ts',
    status: 'mod',
    hunks: [{ oldStart: 9, oldLines: 3, newStart: 9, newLines: 4, header: 'export class Users {', lines: ['   list(limit: number): User[] {', '-    return all', '+    if (!limit) return []', '+    return all.slice(0, limit)', '   }'] }],
  },
  { path: 'src/jobs/sync.ts', status: 'add', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+export function sync(): void {', '+}'] }] },
  { path: 'src/api/users.test.ts', status: 'mod', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+test()'] }] },
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
    { id: 'api', name: 'api', description: '', uses: [{ to: 'jobs', calls: [{ text: 'sync()', diff: 'add' }], diff: 'add' }], interface: [{ text: 'list(limit): User[]', diff: 'mod' }] },
    { id: 'jobs', name: 'jobs', description: '', uses: [], path: 'src/jobs', diff: 'add', interface: [{ text: 'sync(): void', diff: 'add' }] },
  ],
}

const canvas = (id: string, diagram: Diagram, extra: Partial<Canvas> = {}) => ({ id, title: id, version: 1, kind: 'diagram', diagram, ...extra }) as unknown as Canvas

const INVENTORY: ChangeInventory = {
  summary: ['list takes a limit', 'a sync job'],
  units: [
    { id: 'u1', kind: 'method', module: 'api', owner: 'Users', name: 'list', change: 'mod', before: 'list(limit: number): User[]', after: 'list(limit: number): User[]', note: 'at most limit users', logic: 'nontrivial', hunks: ['H1.1'] },
    { id: 'u2', kind: 'method', module: 'jobs', name: 'sync', change: 'add', after: 'sync(): void', logic: 'trivial', hunks: ['H2'] },
    { id: 'u3', kind: 'dependency', module: 'api', name: 'jobs', change: 'add', hunks: ['H1.1'] },
  ],
  noise: [],
}

test('changes: files of any source, owned by the architecture and the modules the plan adds, hunks numbered', async () => {
  const none = await changes(project, [target], source)
  assert.deepEqual(none.files.map((f) => [f.repo, f.path, f.module, f.hunks.map((h) => h.id)]), [['app', 'src/api/users.ts', 'api', ['H1']], ['app', 'src/jobs/sync.ts', null, ['H2']], ['app', 'src/api/users.test.ts', 'api', ['H3']]])
  assert.deepEqual(none.repos, [{ repo: 'o/app', name: 'app', baseSha: 'aaaaaaa', headSha: 'bbbbbbb' }])
  const withPlan = await changes(project, [target], source, [canvas('plan', PLAN)])
  assert.deepEqual(withPlan.files.map((f) => f.module), ['api', 'jobs', 'api'])
  assert.deepEqual(withoutLines(withPlan.files)[0].hunks[0].lines, undefined, 'lines stay in the main process')
  assert.match(hunkListing(withPlan), /^### Hunks \(cite their blocks in the inventory\)\n### H1 {2}app:src\/api\/users\.ts {2}\[module: api\]/)
})

test('check: no inventory blocks; the inventory is checked against the hunks and its generated fact against the plan', async () => {
  const plan = [canvas('plan', PLAN)]
  const changed = await changes(project, [target], source, plan)
  assert.equal(check(project, changed, [], plan).blockers[0], 'there is no inventory of the PRs yet: the review writes it with set_inventory')
  assert.deepEqual(check(project, changed, [canvas('drawn', PLAN, { root: true })], plan).blockers[0], 'the fact set has no inventory (drawn before mag checked inventories): restart the review')

  const { component, data } = factDiagrams(INVENTORY, changed, project, [])
  assert.equal(data, null)
  assert.deepEqual(component.modules.find((m) => m.id === 'api')!.interface, [{ text: 'list(limit: number): User[] - at most limit users', diff: 'mod', files: ['src/api/users.ts'], logic: true }])
  const root = canvas('root', component, { root: true, inventory: INVENTORY })
  const fact = check(project, changed, [root], plan)
  assert.deepEqual(fact.blockers, [])
  assert.equal(fact.canvas, root)
  assert.deepEqual(fact.comparison.items.map((i) => [i.status, (i.plan ?? i.fact)!.key]), [['differs', 'api#list'], ['unplanned', 'api'], ['match', 'api -> jobs'], ['match', 'jobs'], ['match', 'jobs#sync']], 'a planned call is not compared with the call units')
  assert.equal(fact.comparison.items[0].level, 'medium', 'another argument list differs without blocking')
  assert.match(factReport(fact), /### Inventory against the hunks\nInventory: 3 unit\(s\) over 2 block\(s\) of changed code \(3 in all\)\.\nEvery block/)
  assert.match(factReport(fact), /Threshold: merge is allowed/)

  // A unit left out: its block is in no unit; a planned line not on the fact is missing.
  const less = { ...INVENTORY, units: INVENTORY.units.filter((u) => u.id !== 'u2') }
  const short = check(project, changed, [canvas('root', factDiagrams(less, changed, project, []).component, { root: true, inventory: less })], plan)
  assert.deepEqual(short.blockers, ['H2.1 (app:src/jobs/sync.ts, jobs) is changed code in no unit and not in noise', 'high: module jobs is planned, not on the fact', 'high: jobs sync(): void is planned, not on the fact'])
})

test("check without a plan (a teammate's PR): only the inventory against the hunks, no plan ↔ fact (reviews-prybraty-spysok-pr-i.1)", async () => {
  const changed = await changes(project, [target], source)
  const wrong: ChangeInventory = {
    ...INVENTORY,
    units: [
      ...INVENTORY.units,
      { id: 'u4', kind: 'method', module: 'api', name: 'remove', change: 'del', logic: 'none', hunks: ['H1.1'] },
      // A call is checked against the project's modules (diff-iak-inventar-zmin-ai.2): billing is none, lodash says it is outside.
      { id: 'u5', kind: 'call', module: 'api', name: 'lodash#slice', change: 'add', after: 'all.slice(0, limit)', external: true, hunks: ['H1.1'] },
      { id: 'u6', kind: 'call', module: 'api', name: 'billing#slice', change: 'add', after: 'all.slice(0, limit)', hunks: ['H1.1'] },
    ],
  }
  const fact = check(project, changed, [canvas('root', factDiagrams(wrong, changed, project, []).component, { root: true, inventory: wrong })], null)
  assert.deepEqual(fact.comparison.items, [])
  assert.deepEqual(fact.blockers, ['unit u4 (remove): remove is not in its hunks', 'unit u6 (billing#slice): billing is no module of the project: name the module it calls, or say external: true'])
  assert.match(factReport(fact), /^## Fact \(mag\)\n/)
  assert.match(factReport(fact), /### The fact is not complete yet\n {2}- unit u4/)
})

test('flowchartRefusal and warnings: a fact flowchart is of a method with nontrivial logic; scenarios link from their modules', async () => {
  const flow = (of?: string): Diagram => ({ type: 'flowchart', ...(of && { of }), nodes: [{ id: 's', label: 's', shape: 'start' }], edges: [] })
  assert.match(flowchartRefusal(null, flow('api#list'))!, /Write the inventory first/)
  assert.equal(flowchartRefusal(INVENTORY, flow('api#list')), null)
  assert.match(flowchartRefusal(INVENTORY, flow('jobs#sync'))!, /no method unit of the inventory with logic nontrivial/)
  assert.match(flowchartRefusal(INVENTORY, flow())!, /needs of/)
  assert.equal(flowchartRefusal(INVENTORY, PLAN), null)

  const changed = await changes(project, [target], source)
  const seq = canvas('seq', { type: 'sequence', participants: [{ id: 'api', label: 'api' }, { id: 'jobs', label: 'jobs' }], messages: [] }, { role: 'fact' })
  const { component } = factDiagrams(INVENTORY, changed, project, [seq])
  assert.deepEqual(component.modules.find((m) => m.id === 'api')!.links, [{ to: 'seq', node: 'api', kind: 'scenario' }])
  const set = [canvas('root', component, { root: true, inventory: INVENTORY }), seq, canvas('old', flow('jobs#sync'))]
  assert.deepEqual(check(project, changed, set, null).warnings, ['"old" (old): its of jobs#sync is no method of the inventory with logic nontrivial.'])
})

test('filesOfHunks: blocks and hunks to paths; <repo>:<path> when the fact spans repositories', async () => {
  const one = await changes(project, [target], source)
  assert.deepEqual(filesOfHunks(one.files)(['H1.1', 'H2', 'H9']), ['src/api/users.ts', 'src/jobs/sync.ts'])
  const two = await changes(project, [target, { ...target, name: 'web' }], source)
  assert.deepEqual(two.files.flatMap((f) => f.hunks.map((h) => h.id)), ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'], 'numbered across repositories')
  assert.deepEqual(filesOfHunks(two.files)(['H4.1']), ['web:src/api/users.ts'])
})

test('hunk: through the source, between commit shas only', async () => {
  assert.deepEqual(await hunk(source, target.at, target.base, target.head, { path: 'src/api/users.ts', ...DIFF[0].hunks[0] }), ['+src/api/users.ts'])
  await assert.rejects(hunk(source, target.at, 'HEAD', target.head, { path: 'x', ...DIFF[0].hunks[0] }), /commit shas/)
})

test('changes: a repository outside the project reads by its folders, not the project architecture (reviews-ahent-reviuit-pr-timeitiv.3)', async () => {
  const outside = await changes(project, [{ ...target, outside: true }], source, [canvas('plan', PLAN)])
  assert.equal(outside.outside, true)
  // The plan's jobs module (src/jobs) first, then the folders: src/api is a folder module, not the project's api.
  assert.deepEqual(outside.files.map((f) => [f.path, f.module]), [['src/api/users.ts', 'src-api'], ['src/jobs/sync.ts', 'jobs'], ['src/api/users.test.ts', 'src-api']])
  const fact = check(project, outside, [], [canvas('plan', PLAN)])
  assert.equal(fact.outside, true)
  assert.match(factReport(fact), /Without the project architecture: the repository is outside the project/)
  assert.equal((await changes(project, [target], source)).outside, false)
})
