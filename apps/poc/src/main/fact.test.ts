// Plan ↔ fact over real git (T-57.4): a step's PR against its plan diagram, the draft fact diagram and its revision.
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
import { stepFact } from './fact.ts'

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

test('stepFact: the PR against its plan diagram, levelled, with the threshold', async () => {
  const { store, project, step, repo, head } = setup()
  const fact = await stepFact(project, store.task(step.id), { [repo]: head }, Object.values(store.data.canvases))
  const rows = fact.comparison.items.map((i) => `${i.status} ${i.level} ${(i.plan ?? i.fact[0]).name ?? (i.plan ?? i.fact[0]).path}`)
  assert.deepEqual(rows, ['missing high remove', 'unplanned high extra', 'unplanned high save', 'match high load'])
  assert.deepEqual(fact.blockers, ['high: app function extra (src/extra.ts:1) is not on the plan', 'high: store function save (src/store.ts:5) is not on the plan'])
  // The playbook's rules level the fact: a project that does not care about src/extra.ts.
  store.updateProject(project.id, { playbook: { significance: 'low: src/extra.ts' } })
  const ruled = await stepFact(store.project(project.id), store.task(step.id), { [repo]: head }, Object.values(store.data.canvases))
  assert.deepEqual(ruled.blockers, ['high: store function save (src/store.ts:5) is not on the plan'])
})

test('factOf: records the fact, drafts the fact diagram; the reviewer may add to it, never drop', async () => {
  const { store, step, repo, head, plan, orch, show } = setup()
  const text = await orch.factOf(step.id, { [repo]: head })
  const fact = store.task(step.id).fact!
  assert.deepEqual(fact.counts, { match: 1, differs: 0, missing: 1, unplanned: 2, unchecked: 0 })
  assert.equal(fact.blockers.length, 2)
  const canvas = store.data.canvases[fact.canvasId!]
  assert.deepEqual([canvas.role, canvas.stepId, canvas.planOf, canvas.version, fact.canvasVersion], ['fact', step.id, plan.id, 1, 1])
  const d = canvas.diagram as ComponentDiagram
  assert.deepEqual(d.modules.map((m) => [m.id, m.interface?.map((l) => `${l.diff} ${l.text}`)]), [
    ['app', ['add extra()']],
    ['store', ['del load(id: string)', 'add load(id: string, fresh = false)', 'add save(id: string)']],
  ])
  assert.match(text, /Plan diagrams: \[Plan\]\(canvas:/)
  assert.match(text, /merge is NOT allowed/)
  assert.match(text, /mag's draft/)

  // Unrevised, the draft is redrawn on the next heads.
  await orch.factOf(step.id, { [repo]: head })
  assert.equal(store.data.canvases[fact.canvasId!].version, 2)

  // The reviewer's revision that drops save is saved, and told what it no longer shows.
  const revised = { ...d, summary: 'load gets a fresh flag; save and extra came along', modules: d.modules.map((m) => (m.id === 'store' ? { ...m, interface: m.interface!.slice(0, 2) } : m)) }
  const answer = await show(revised, fact.canvasId!)
  assert.match(answer, /no longer shows[\s\S]*- store function save \(src\/store\.ts:5\)/)
  await assert.rejects(show(revised, plan.id), /only the fact diagram/)
  await assert.rejects(show(revised), /only the fact diagram/)

  // A revised diagram stays; the reviewer hears what it misses.
  const again = await orch.factOf(step.id, { [repo]: head })
  assert.equal(store.data.canvases[fact.canvasId!].diagram!.type === 'component' && (store.data.canvases[fact.canvasId!].diagram as ComponentDiagram).summary, revised.summary)
  assert.match(again, /revised since mag drew it; it does not show:\n {2}- store function save/)
  assert.match(await show(d, fact.canvasId!), /shows every significant change of the code/)
})
