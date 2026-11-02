// Plan ↔ fact over real git (T-57.4, T-58): a step's PR, its fact diagram started as a copy of the plan, its revision.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchDiagram, ComponentDiagram } from '@mag/core'
import { Store } from './store.ts'
import { Orchestrator } from './orchestrator.ts'
import { createTools, type ToolActions } from './tools.ts'
import { factHeads, factSeed, factView, stepFact, stepFiles, stepHunk } from './fact.ts'
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
  return { repo, head, store, project, task, step, plan, orch, show }
}

const FACT: ComponentDiagram = {
  type: 'component',
  summary: 'load takes fresh; save and extra came instead of remove',
  modules: [
    {
      id: 'app', name: 'app', description: '', uses: [],
      interface: [{ text: 'extra(): number', diff: 'add', files: ['src/extra.ts'] }],
      children: [
        {
          id: 'store', name: 'store', description: '', uses: [],
          interface: [
            { text: 'load(id): Item', diff: 'del', files: ['src/store.ts'] },
            { text: 'load(id, fresh?): Item', diff: 'add', files: ['src/store.ts'] },
            { text: 'remove(id): void' },
            { text: 'save(id): Item', diff: 'add', files: ['src/store.ts'] },
          ],
        },
      ],
    },
  ],
}

test('stepFact: changed files; without a fact diagram nothing is shown; a revised one against files and plan', async () => {
  const { store, project, step, repo, head } = setup()
  const heads = { [repo]: head }
  const none = await stepFact(project, store.task(step.id), heads, Object.values(store.data.canvases))
  assert.deepEqual(none.files.map((f) => [f.path, f.module, f.kind]), [['README.md', null, 'docs'], ['src/extra.ts', 'app', 'code'], ['src/store.ts', 'store', 'code']])
  assert.equal(none.canvas, null)
  assert.deepEqual(none.comparison.items.map((i) => i.status), ['missing', 'missing'])
  assert.equal(none.blockers[0], 'there is no fact diagram of the PRs yet')

  store.saveCanvas({ projectId: project.id, taskId: step.parentId, sessionId: null, title: 'Fact', kind: 'diagram', diagram: FACT, placement: { role: 'fact', option: null, stepId: step.id, repo: null, planOf: null } })
  const fact = await stepFact(project, store.task(step.id), heads, Object.values(store.data.canvases))
  assert.deepEqual(fact.coverage!.unshown, [])
  assert.deepEqual(fact.grounding!.unverified, [])
  assert.deepEqual(fact.comparison.items.map((i) => `${i.status} ${i.level} ${(i.plan ?? i.fact)!.key}`), ['missing high store#remove', 'unplanned high app#extra', 'unplanned high store#save', 'match high store#load'])
  assert.deepEqual(fact.blockers, ['high: store remove(id): void is planned, not on the fact', 'high: app extra(): number is on the fact, not on the plan', 'high: store save(id): Item is on the fact, not on the plan'])
  // The playbook's rules level the fact by the files it gives: a project that does not care about src/extra.ts.
  store.updateProject(project.id, { playbook: { significance: 'low: src/extra.ts' } })
  const ruled = await stepFact(store.project(project.id), store.task(step.id), heads, Object.values(store.data.canvases))
  assert.equal(ruled.blockers.length, 2)
})

test('factOf: starts the fact diagram as a copy of the plan; the reviewer revises it and hears what mag checks', async () => {
  const { store, step, repo, head, plan, orch, show } = setup()
  const text = await orch.factOf(step.id, { [repo]: head })
  const fact = store.task(step.id).fact!
  const canvas = store.data.canvases[fact.canvasId!]
  assert.deepEqual([canvas.role, canvas.stepId, canvas.planOf, canvas.version, fact.canvasVersion], ['fact', step.id, plan.id, 1, 1])
  assert.deepEqual((canvas.diagram as ComponentDiagram).modules, PLAN.modules, 'a copy of the plan')
  // Nothing of the copy rests on the PR, so it shows no changed file (Decision 11).
  assert.deepEqual(fact.counts, { match: 2, differs: 0, missing: 0, unplanned: 0, unshown: 2, unverified: 2 })
  assert.match(text, /mag's copy of the plan: nothing on it rests on the PR yet\./)
  assert.match(text, /### Changed files\napp: [0-9a-f]{12} → [0-9a-f]{12}, 3 file\(s\) changed, 2 of them code\./)
  assert.match(text, /### Changed code the fact diagram does not show \(2\)\n- app:src\/extra\.ts \(app\)\n- app:src\/store\.ts \(store\)/)
  assert.match(text, /### Lines of the fact that do not rest on the PR \(2\)\n- store load\(id, fresh\?\): Item: no-files/)
  assert.match(text, /merge is NOT allowed/)

  // On the next heads the copy is not started again.
  await orch.factOf(step.id, { [repo]: head })
  assert.equal(store.data.canvases[fact.canvasId!].version, 1)

  // The reviewer's revision is checked and recorded at once.
  const answer = await show(FACT, fact.canvasId!)
  assert.match(answer, /Fact diagram: \[.*\]\(canvas:\w+\) \(v2\), revised\./)
  assert.doesNotMatch(answer, /does not show|do not rest/)
  assert.deepEqual(store.task(step.id).fact!.counts, { match: 1, differs: 0, missing: 1, unplanned: 2, unshown: 0, unverified: 0 })
  await assert.rejects(show(FACT, plan.id), /only the fact diagram/)
  await assert.rejects(show(FACT), /only the fact diagram/)

  // A plan the fact agrees with: merge is allowed.
  store.saveCanvas({ id: plan.id, projectId: plan.projectId, taskId: plan.taskId, sessionId: null, title: 'Plan', kind: 'diagram', diagram: { ...FACT, modules: FACT.modules } })
  assert.match(await show(FACT, fact.canvasId!), /merge is allowed\.$/)
  assert.deepEqual(store.task(step.id).fact!.blockers, [])
})

test('factSeed: without a plan, the modules that own the changed code, unmarked', async () => {
  const { store, project, step, repo, head, plan } = setup()
  const { files } = await stepFiles(project, store.task(step.id), { [repo]: head }, [plan])
  const seed = factSeed(store.task(step.id), [], files, project.architecture)!
  assert.deepEqual(seed.modules.map((m) => [m.id, m.diff, m.interface]), [['app', undefined, undefined], ['store', undefined, undefined]])
  assert.equal(factSeed(store.task(step.id), [], files.filter((f) => f.kind !== 'code'), project.architecture), null)
})

test('factView: files, plan ↔ fact, the threshold, coverage and unverified lines; hunks open', async () => {
  const { store, step, repo, head, orch } = setup()
  // No open PR head yet, no recorded fact: nothing to show.
  assert.equal(await factView(store.project(store.task(step.id).projectId), store.task(step.id), Object.values(store.data.canvases)), null)
  store.updateTask(step.id, { work: { ...store.task(step.id).work!, repos: store.task(step.id).work!.repos.map((r) => ({ ...r, prHead: head })) } })
  await orch.factOf(step.id, { [repo]: head })
  const s = store.task(step.id)
  const view = (await factView(store.project(s.projectId), s, Object.values(store.data.canvases)))!
  assert.deepEqual(view.heads, { [repo]: head })
  assert.deepEqual(view.repos.map((r) => [r.repo, r.name, r.headSha]), [[repo, 'app', head]])
  assert.equal(view.files.length, 3)
  assert.deepEqual(view.items.map((i) => i.status), ['match', 'match'])
  assert.deepEqual(view.plans.map((p) => p.title), ['Plan'])
  assert.equal(view.fact!.id, s.fact!.canvasId)
  assert.deepEqual(view.coverage!.unshown.map((f) => f.path), ['src/extra.ts', 'src/store.ts'])
  assert.deepEqual(view.unverified.map((u) => [u.change.key, u.reason]), [['store#load', 'no-files'], ['store#remove', 'no-files']])
  assert.equal(view.blockers.length, 4)

  const save = view.files.find((f) => f.path === 'src/store.ts')!
  const hunk = { path: save.path, ...save.hunks.at(-1)! }
  const lines = await stepHunk(s, repo, view.repos[0].baseSha, head, hunk)
  assert.ok(lines.includes('+export function save(id: string) {'), lines.join('\n'))
  await assert.rejects(stepHunk(s, '/elsewhere', view.repos[0].baseSha, head, hunk), /does not change/)
  await assert.rejects(stepHunk(s, repo, 'HEAD', head, hunk), /commit shas/)

  // Merged: the PR is no longer open, the recorded heads stand.
  store.updateTask(step.id, { work: { ...s.work!, repos: s.work!.repos.map((r) => ({ ...r, prState: 'merged' as const })) } })
  assert.deepEqual(factHeads(store.task(step.id)), { [repo]: head })
})

test('hunkLines: one hunk of one file, renames by their new path, no-newline markers left out', () => {
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
    '@@ -3 +3 @@',
    '-x',
    '+y',
    '',
  ].join('\n')
  assert.deepEqual(hunkLines(text, 'src/a.ts', { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }), ['-old', '+new', '+-- not a header'])
  assert.deepEqual(hunkLines(text, 'src/a.ts', { oldStart: 5, oldLines: 0, newStart: 7, newLines: 1 }), ['+later'])
  assert.deepEqual(hunkLines(text, 'src/c.ts', { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }), ['-x', '+y'])
  assert.deepEqual(hunkLines(text, 'src/b.ts', { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }), [])
})
