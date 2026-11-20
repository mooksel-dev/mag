// Plan ↔ fact over real git (T-57.4, T-58): a step's PR, the reviewer's change inventory of it and what mag generates and
// checks from it (diff-iak-inventar-zmin-ai.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchDiagram, ChangeInventory, ComponentDiagram, DataDiagram } from '@mag/core'
import { Store } from './store.ts'
import { Orchestrator } from './orchestrator.ts'
import { createTools, type ToolActions } from './tools.ts'
import { cachedDiffText, factHeads, factView, stepFact, stepHunk } from './fact.ts'
import { hunkLines } from './git.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

const ARCH: ArchDiagram = {
  summary: '',
  updatedAt: 1,
  modules: [{ id: 'app', name: 'app', description: '', uses: [], paths: ['src'], children: [{ id: 'store', name: 'store', description: '', uses: [], paths: ['src/store.ts'] }] }],
}

const PLAN: ComponentDiagram = {
  type: 'component',
  summary: 'load takes fresh; remove is new',
  modules: [
    {
      id: 'store', name: 'store', description: '', uses: [],
      interface: [{ text: 'load(id): Item', diff: 'del' }, { text: 'load(id, fresh?): Item', diff: 'add' }, { text: 'remove(id): void', diff: 'add' }],
    },
  ],
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-fact-'))
  const repo = join(dir, 'app')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'src/store.ts'), 'export function load(id: string) {\n  return id\n}\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'checkout', '-q', '-b', 'mag/x-1')
  writeFileSync(join(repo, 'src/store.ts'), 'export function load(id: string, fresh = false) {\n  return fresh ? id : id\n}\n\nexport function save(id: string) {\n  return id\n}\n')
  writeFileSync(join(repo, 'src/extra.ts'), 'export function extra() {\n  return 1\n}\n')
  writeFileSync(join(repo, 'README.md'), 'notes\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'step')
  const head = git(repo, 'rev-parse', 'HEAD')

  const store = new Store(join(dir, 'db.json'))
  const project = store.createProject('p')
  store.updateProject(project.id, { repos: [repo], architecture: ARCH })
  const task = store.createTask({ projectId: project.id, title: 'X', type: 'dev', description: '', status: 'in_progress' })
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'in_progress' })
  const work = { dir: join(dir, 'work'), repos: [{ repo, branch: 'mag/x-1', worktree: join(dir, 'work', 'app'), prUrl: 'https://github.com/o/app/pull/1', prState: 'open' as const }], feedbackSeenAt: 0 }
  store.updateTask(step.id, { work })
  const plan = store.saveCanvas({ projectId: project.id, taskId: task.id, sessionId: null, title: 'Plan', kind: 'diagram', diagram: PLAN, placement: { role: 'plan', option: null, stepId: step.id, repo, planOf: null } })
  const orch = new Orchestrator(store, { url: 'http://127.0.0.1:1', token: 't' }, {
    mcpScript: join(dir, 'task-mcp.js'), runsDir: join(dir, 'runs'), worktreesDir: join(dir, 'worktrees'), attachmentsDir: join(dir, 'att'), logsDir: join(dir, 'logs'),
  })
  const reviewer = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'reviewer', agent: 'claude-code', status: 'idle' })
  const tools = createTools(store, {} as ToolActions)
  const show = (diagram: unknown, id?: string) => tools({ taskId: task.id, sessionId: reviewer.id }, 'show_diagram', { title: 'Fact', diagram, ...(id && { id }) })
  const inventory = (inv: unknown) => tools({ taskId: task.id, sessionId: reviewer.id }, 'set_inventory', { inventory: inv })
  return { repo, head, store, project, task, step, plan, orch, show, inventory, tools, reviewer }
}

/** What the step did, as its reviewer lists it from the hunks: README is docs (H1), extra.ts H2, store.ts one block H3.1. */
const INVENTORY: ChangeInventory = {
  summary: ['load takes fresh', 'save and extra came instead of remove'],
  units: [
    { id: 'u1', kind: 'method', module: 'store', name: 'load', change: 'mod', before: 'load(id: string)', after: 'load(id: string, fresh = false)', note: 'can skip the cache', logic: 'nontrivial', hunks: ['H3.1'] },
    { id: 'u2', kind: 'method', module: 'store', name: 'save', change: 'add', after: 'save(id: string)', logic: 'trivial', hunks: ['H3.1'] },
    { id: 'u3', kind: 'method', module: 'app', name: 'extra', change: 'add', after: 'extra()', logic: 'trivial', hunks: ['H2.1'] },
  ],
  noise: [],
}

test('stepFact: changed files with numbered hunks; without an inventory nothing is on the fact and merge is blocked', async () => {
  const { store, project, step, repo, head } = setup()
  const none = await stepFact(project, store.task(step.id), { [repo]: head }, Object.values(store.data.canvases))
  assert.deepEqual(none.files.map((f) => [f.path, f.module, f.kind, f.hunks.map((h) => h.id).join()]), [['README.md', null, 'docs', 'H1'], ['src/extra.ts', 'app', 'code', 'H2'], ['src/store.ts', 'store', 'code', 'H3']])
  assert.equal(none.canvas, null)
  assert.deepEqual(none.comparison.items.map((i) => i.status), ['missing', 'missing'])
  assert.equal(none.blockers[0], 'there is no inventory of the PRs yet: the review writes it with set_inventory')
})

test('factOf and set_inventory: the reviewer gets the hunks, writes the inventory; mag generates the fact, checks and records it', async () => {
  const { store, step, repo, head, plan, orch, show, inventory } = setup()
  const text = await orch.factOf(step.id, { [repo]: head })
  assert.equal(store.task(step.id).fact!.canvasId, null, 'mag starts no fact set: the inventory makes it')
  assert.match(text, /Fact: no inventory yet: write it with set_inventory from the hunks below\./)
  assert.match(text, /### Changed files\napp: [0-9a-f]{12} → [0-9a-f]{12}, 3 file\(s\) changed, 2 of them code\./)
  assert.match(text, /### H3 {2}app:src\/store\.ts {2}\[module: store\] {2}@@ -1,3 \+1,7 @@\n\[H3\.1\]\n-export function load\(id: string\) \{/)
  assert.match(text, /\n\+export function save\(id: string\) \{\n {3}return id\n \}\n/, 'context lines as git gives them')
  assert.match(text, /Not code, need not be cited: app:README\.md \(docs: H1\)/)
  await assert.rejects(show({ type: 'flowchart', of: 'store#load', nodes: [], edges: [] }), /Write the inventory first/)

  await assert.rejects(inventory({ units: [] }), /Not saved\. Fix and call again:\n- summary is required/)
  const answer = await inventory(INVENTORY)
  const fact = store.task(step.id).fact!
  const root = store.data.canvases[fact.canvasId!]
  assert.deepEqual([root.role, root.stepId, root.root, root.inventory], ['fact', step.id, true, INVENTORY])
  assert.match(answer, /^Inventory saved: 3 units; mag generated \[x\.1: fact\]\(canvas:\w+\) \(v1, the root\)\. /)
  assert.match(answer, /Every block of changed code is in a unit or noise, and every unit rests on its hunks\./)
  const store_ = (root.diagram as ComponentDiagram).modules.find((m) => m.id === 'store')!
  assert.deepEqual(store_.interface, [
    { text: 'load(id: string)', diff: 'del', files: ['src/store.ts'], logic: true },
    { text: 'load(id: string, fresh = false) - can skip the cache', diff: 'add', files: ['src/store.ts'], logic: true },
    { text: 'save(id: string)', diff: 'add', files: ['src/store.ts'] },
  ])
  assert.deepEqual(fact.counts, { match: 1, differs: 0, missing: 1, unplanned: 0, additions: 1, outside: 1, unaccounted: 0, ungrounded: 0 }, 'load(id, fresh?) planned, load(id: string, fresh = false) done: as planned; save inside store, extra in app outside the plan')
  assert.equal(fact.compareVersion, 3)
  // A deviation is no blocker (review-v3-concise-design-first.3): it is recorded apart, backed by the doc or not.
  assert.deepEqual(fact.blockers, [])
  assert.deepEqual(fact.deviations, [{ text: 'store: remove is planned, not done', backed: false }])

  // A unit left out is a draft unit still without its meaning: mag parsed extra() (prompts-use-the-models-to.6).
  await assert.rejects(inventory({ ...INVENTORY, units: INVENTORY.units.slice(0, 2) }), /Unit d1 \(extra\): a method needs logic/)
  // Dropped, its block is in no unit; the inventory is written again whole and revises the same root.
  const again = await inventory({ ...INVENTORY, units: [...INVENTORY.units.slice(0, 2), { id: 'd1', drop: true }] })
  assert.match(again, /- H2\.1 \(app:src\/extra\.ts, app\) is changed code in no unit and not in noise/)
  assert.equal(store.task(step.id).fact!.canvasId, root.id)
  assert.equal(store.data.canvases[root.id].version, 2)
  assert.equal(store.task(step.id).fact!.counts.unaccounted, 1)
  await inventory(INVENTORY)

  // A fact set takes only scenarios and the logic of a nontrivial method.
  await assert.rejects(show(PLAN), /mag generates the fact's Component and Data diagrams from the inventory/)
  await assert.rejects(show({ type: 'flowchart', of: 'store#load', nodes: [], edges: [] }, root.id), /is generated by mag from the inventory/)
  await assert.rejects(show({ type: 'flowchart', of: 'store#save', nodes: [], edges: [] }), /store#save is no method unit of the inventory with logic nontrivial/)
  const flow = await show({ type: 'flowchart', of: 'store#load', summary: 'fresh', nodes: [{ id: 'a', label: 'fresh?', shape: 'decision' }], edges: [] })
  assert.match(flow, /^Diagram \w+ \(v1\) in the fact of /)
  const seq = await show({ type: 'sequence', participants: [{ id: 'app', label: 'app' }, { id: 'store', label: 'store' }], messages: [{ from: 'app', to: 'store', text: 'load(id, true)', kind: 'call' }] })
  const seqId = seq.match(/^Diagram (\w+)/)![1]
  assert.deepEqual((store.data.canvases[root.id].diagram as ComponentDiagram).modules.find((m) => m.id === 'store')!.links, [{ to: seqId, node: 'store', kind: 'scenario' }], 'the root links the scenario from its modules')
  assert.doesNotMatch(seq, /not reached from the root/)
  await assert.rejects(show(PLAN, plan.id), /only the fact set of the step under review/)

  // A plan the fact agrees with: merge is allowed.
  const agreed = store.data.canvases[root.id].diagram as ComponentDiagram
  store.saveCanvas({ id: plan.id, projectId: plan.projectId, taskId: plan.taskId, sessionId: null, title: 'Plan', kind: 'diagram', diagram: agreed })
  assert.match(await show({ type: 'flowchart', of: 'store#load', summary: 'fresh', nodes: [{ id: 'a', label: 'fresh?', shape: 'decision' }], edges: [] }, flow.match(/^Diagram (\w+)/)![1]), /merge is allowed\. Plan ↔ fact: as planned, never a blocker\.$/)
  assert.deepEqual(store.task(step.id).fact!.blockers, [])
})

test('set_inventory: stored data gets a Data diagram linked from its module; drawn Component and Data diagrams leave the set', async () => {
  const { store, project, step, repo, head, orch, inventory } = setup()
  await orch.factOf(step.id, { [repo]: head })
  // A fact set drawn before inventories: a component and a data diagram.
  const placement = { role: 'fact' as const, option: null, stepId: step.id, repo: null, planOf: null }
  const old = store.saveCanvas({ projectId: project.id, taskId: step.parentId, sessionId: null, title: 'Drawn', kind: 'diagram', diagram: PLAN, placement, root: true })
  const oldData = store.saveCanvas({ projectId: project.id, taskId: step.parentId, sessionId: null, title: 'Drawn data', kind: 'diagram', diagram: { type: 'data', entities: [{ id: 'x', name: 'x', kind: 'table', fields: [{ name: 'a', type: 'b' }] }], relations: [] }, placement })
  assert.match((await stepFact(project, store.task(step.id), { [repo]: head }, Object.values(store.data.canvases))).blockers[0], /no inventory .*restart the review/)
  const withData = { ...INVENTORY, units: [...INVENTORY.units, { id: 'u4', kind: 'field' as const, module: 'store', name: 'Item.stale', change: 'add' as const, stored: true, after: 'boolean', hunks: ['H3.1'] }] }
  const answer = await inventory(withData)
  const fact = store.task(step.id).fact!
  assert.equal(fact.canvasId, old.id, 'the drawn root is revised into the generated one')
  const data = store.data.canvases[oldData.id]
  assert.deepEqual((data.diagram as DataDiagram).entities.map((e) => [e.id, e.module, e.fields.map((f) => f.name)]), [['Item', 'store', ['stale']]])
  assert.match(answer, /and \[x\.1: fact — data\]\(canvas:\w+\) \(v2\)/)
  assert.deepEqual((store.data.canvases[old.id].diagram as ComponentDiagram).modules.find((m) => m.id === 'store')!.links, [{ to: oldData.id, kind: 'data' }])
  // stale is not a word of its hunks: the unit is not borne out.
  assert.ok(fact.blockers.includes('unit u4 (Item.stale): stale is not in its hunks'))
  const third = store.saveCanvas({ projectId: project.id, taskId: step.parentId, sessionId: null, title: 'Another', kind: 'diagram', diagram: PLAN, placement })
  await inventory(INVENTORY)
  assert.equal(store.data.canvases[third.id].role, null, 'a drawn Component diagram leaves the set')
  assert.equal(store.data.canvases[oldData.id].role, null, 'no stored data changes: the Data diagram leaves the set')
})

test('factView: files without lines, plan ↔ fact, the threshold and the inventory check; hunks open', async () => {
  const { store, step, repo, head, orch, inventory } = setup()
  // No open PR head yet, no recorded fact: nothing to show.
  assert.equal(await factView(store.project(store.task(step.id).projectId), store.task(step.id), Object.values(store.data.canvases)), null)
  store.updateTask(step.id, { work: { ...store.task(step.id).work!, repos: store.task(step.id).work!.repos.map((r) => ({ ...r, prHead: head })) } })
  await orch.factOf(step.id, { [repo]: head })
  await inventory({ ...INVENTORY, units: [...INVENTORY.units.slice(2), { id: 'd2', drop: true }, { id: 'd3', drop: true }] })
  const s = store.task(step.id)
  const view = (await factView(store.project(s.projectId), s, Object.values(store.data.canvases)))!
  assert.deepEqual(view.heads, { [repo]: head })
  assert.deepEqual(view.repos.map((r) => [r.repo, r.name, r.headSha]), [[repo, 'app', head]])
  assert.equal(view.files.length, 3)
  assert.ok(view.files.every((f) => f.hunks.every((h) => h.lines === undefined)), 'lines stay in the main process')
  assert.deepEqual(view.plans.map((p) => p.title), ['Plan'])
  assert.equal(view.fact!.id, s.fact!.canvasId)
  assert.deepEqual(view.inventory, { units: 1, summary: INVENTORY.summary })
  assert.deepEqual(view.check!.unaccounted.map((b) => [b.id, b.path]), [['H3.1', 'src/store.ts']])
  assert.equal('lines' in view.check!.unaccounted[0], false)
  assert.ok(view.blockers.includes('H3.1 (app:src/store.ts, store) is changed code in no unit and not in noise'))

  const save = view.files.find((f) => f.path === 'src/store.ts')!
  const hunk = { path: save.path, ...save.hunks.at(-1)! }
  const lines = await stepHunk(s, repo, view.repos[0].baseSha, head, hunk)
  assert.ok(lines.includes('+export function save(id: string) {'), lines.join('\n'))
  assert.ok(lines.includes(' }'), 'with its context')
  await assert.rejects(stepHunk(s, '/elsewhere', view.repos[0].baseSha, head, hunk), /does not change/)
  await assert.rejects(stepHunk(s, repo, 'HEAD', head, hunk), /commit shas/)

  assert.deepEqual(view.items.map((i) => i.phrase), ['store: load is planned, not done', 'store: remove is planned, not done'])
  assert.deepEqual([view.planDiagram?.title, view.planDiagram?.overlay.modules], ['Plan', { store: 'missing' }])

  // Merged: the PR is no longer open, the recorded heads stand; its changes are still from where it left main.
  store.updateTask(step.id, { work: { ...s.work!, repos: s.work!.repos.map((r) => ({ ...r, prState: 'merged' as const })) } })
  assert.deepEqual(factHeads(store.task(step.id)), { [repo]: head })
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(join(repo, 'later.ts'), 'export const later = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'later on main')
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'mag/x-1')
  const merged = (await factView(store.project(s.projectId), store.task(step.id), Object.values(store.data.canvases)))!
  assert.deepEqual([merged.repos[0].baseSha, merged.files.length], [view.repos[0].baseSha, 3])

  // A fact recorded by the compare before plan level is recorded again when read; a current one is left alone.
  const recorded: unknown[] = []
  const old = { ...store.task(step.id).fact!, compareVersion: undefined, blockers: ['high: store save(id: string) is on the fact, not on the plan'] }
  store.updateTask(step.id, { fact: old })
  await factView(store.project(s.projectId), store.task(step.id), Object.values(store.data.canvases), (f) => recorded.push(f))
  assert.equal(recorded.length, 1)
  assert.equal((recorded[0] as { compareVersion: number }).compareVersion, 3)
  assert.ok(!(recorded[0] as { blockers: string[] }).blockers.some((b) => b.startsWith('high:')))
  store.updateTask(step.id, { fact: recorded[0] as typeof old })
  await factView(store.project(s.projectId), store.task(step.id), Object.values(store.data.canvases), (f) => recorded.push(f))
  assert.equal(recorded.length, 1)
})

test('hunkLines: one hunk of one file with its context, renames by their new path, no-newline markers left out', () => {
  const text = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1,2 @@',
    '-old',
    '+new',
    '+-- not a header',
    '@@ -5,0 +7 @@ function x',
    '+later',
    '\\ No newline at end of file',
    'diff --git a/src/b.ts b/src/c.ts',
    'similarity index 90%',
    'rename from src/b.ts',
    'rename to src/c.ts',
    '--- a/src/b.ts',
    '+++ b/src/c.ts',
    '@@ -3,3 +3,3 @@',
    ' a',
    '-x',
    '+y',
    ' b',
    'diff --git a/src/d.ts b/src/d.ts',
  ].join('\n')
  assert.deepEqual(hunkLines(text, 'src/a.ts', { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }), ['-old', '+new', '+-- not a header'])
  assert.deepEqual(hunkLines(text, 'src/a.ts', { oldStart: 5, oldLines: 0, newStart: 7, newLines: 1 }), ['+later'])
  assert.deepEqual(hunkLines(text, 'src/c.ts', { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3 }), [' a', '-x', '+y', ' b'])
  assert.deepEqual(hunkLines(text, 'src/b.ts', { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3 }), [])
})

test('cachedDiffText: the hunks of one PR cost one diff; a failure is not kept; the oldest goes past max', async () => {
  const calls: string[] = []
  let fail = true
  const text = cachedDiffText(async (at, base, head) => {
    calls.push(`${at} ${base} ${head}`)
    if (at === 'bad' && fail) throw new Error('gh down')
    return `diff ${base}..${head}`
  }, 2)
  assert.deepEqual(await Promise.all([text('r', 'a', 'b'), text('r', 'a', 'b'), text('r', 'a', 'b')]), ['diff a..b', 'diff a..b', 'diff a..b'])
  assert.equal(calls.length, 1, 'concurrent opens share one fetch')
  await assert.rejects(text('bad', 'a', 'b'))
  fail = false
  assert.equal(await text('bad', 'a', 'b'), 'diff a..b', 'a failed fetch is tried again')
  await text('r', 'c', 'd')
  await text('r', 'e', 'f')
  calls.length = 0
  await text('r', 'a', 'b')
  assert.equal(calls.length, 1, 'past max the oldest is fetched anew')
})

test('factOf and set_inventory over the draft: the reviewer gets mag\'s units and gives only their meaning (prompts-use-the-models-to.6)', async () => {
  const { store, step, repo, head, orch, inventory, tools, reviewer, task } = setup()
  const text = await orch.factOf(step.id, { [repo]: head })
  assert.match(text, /### Draft units \(mag parsed the TS\/JS files: 3 unit\(s\)/)
  assert.match(text, /- d2 method mod load \[store, owner store, public\] before "load\(id: string\)" after "load\(id: string, fresh = false\)" hunks H3\.1 — needs logic, note/)
  assert.ok(text.indexOf('### Draft units') < text.indexOf('### Hunks'), 'the draft before the hunks it rests on')
  // get_pr_changes gives the reviewer the same draft at the heads under review.
  const listed = await tools({ taskId: task.id, sessionId: reviewer.id }, 'get_pr_changes', {})
  assert.match(listed, /- d3 method add save \[store, owner store, public\] after "save\(id: string\)" hunks H3\.1 — needs logic/)

  const answer = await inventory({
    summary: ['load takes fresh'],
    units: [{ id: 'd1', logic: 'trivial' }, { id: 'd2', logic: 'nontrivial', note: 'can skip the cache' }, { id: 'd3', logic: 'trivial' }],
    noise: [],
  })
  assert.match(answer, /^Inventory saved: 3 units/)
  assert.match(answer, /Every block of changed code is in a unit or noise, and every unit rests on its hunks\./)
  const saved = store.data.canvases[store.task(step.id).fact!.canvasId!].inventory!
  assert.deepEqual(saved.units.map((u) => [u.id, u.name, u.change, u.after, u.logic, u.parsed]), [
    ['d1', 'extra', 'add', 'extra()', 'trivial', true],
    ['d2', 'load', 'mod', 'load(id: string, fresh = false)', 'nontrivial', true],
    ['d3', 'save', 'add', 'save(id: string)', 'trivial', true],
  ])
})
