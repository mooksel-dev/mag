// Plan diagrams against base over real git (T-57.3): show_diagram's warnings and the drift of base under a plan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchDiagram } from '@mag/core'
import { Store } from './store.ts'
import { createTools, type ToolActions } from './tools.ts'
import { diagramDrift } from './plan-check.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

const ARCH: ArchDiagram = {
  summary: '',
  updatedAt: 1,
  modules: [{ id: 'app', name: 'app', description: '', uses: [], paths: ['src'], children: [{ id: 'store', name: 'store', description: '', uses: [], paths: ['src/store.ts'] }] }],
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-plan-'))
  const repo = join(dir, 'app')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', repo)
  writeFileSync(join(repo, 'src/store.ts'), 'export function load(id: string) {\n  return id\n}\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  const store = new Store(join(dir, 'db.json'))
  const project = store.createProject('p')
  store.updateProject(project.id, { repos: [repo], architecture: ARCH })
  const task = store.createTask({ projectId: project.id, title: 'X', type: 'dev', description: '', status: 'planning' })
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'todo' })
  const tools = createTools(store, {} as ToolActions)
  const show = (diagram: unknown, id?: string) => tools({ taskId: task.id }, 'show_diagram', { title: 'Plan', diagram, role: 'plan', step: step.key, ...(id && { id }) })
  return { repo, store, project, task, step, show }
}

const plan = (lines: { text: string; diff?: string }[]) => ({ type: 'component', summary: 's', modules: [{ id: 'store', name: 'store', description: '', uses: [], interface: lines }] })

test('show_diagram: a plan is checked against base, saved with its warnings, and records the base commit', async () => {
  const { repo, store, show } = setup()
  const out = await show(plan([{ text: 'load(id)' }, { text: 'save(id)' }]))
  const id = /Diagram (\w+)/.exec(out)![1]
  assert.match(out, /\nSaved, but it disagrees with the code at main \(app@[0-9a-f]{8}\)\. Fix the diagram.*\n- store: "save" is not in its code at base [0-9a-f]{8}: mark it add if it is new/)
  assert.deepEqual(store.data.canvases[id].baseSha, { [repo]: git(repo, 'rev-parse', 'HEAD') })

  const fixed = await show(plan([{ text: 'load(id)' }, { text: 'save(id)', diff: 'add' }]), id)
  assert.match(fixed, /It agrees with main\.$/)
  assert.equal(store.data.canvases[id].version, 2)
})

test('show_diagram: other diagram types and projects without an architecture are not checked', async () => {
  const { store, project, show } = setup()
  const seq = await show({ type: 'sequence', participants: [{ id: 'a', label: 'a' }], messages: [] })
  assert.doesNotMatch(seq, /agrees|disagrees/)
  store.updateProject(project.id, { architecture: null })
  const out = await show(plan([{ text: 'nope()' }]))
  assert.doesNotMatch(out, /agrees|disagrees/)
  assert.equal(store.data.canvases[/Diagram (\w+)/.exec(out)![1]].baseSha, undefined)
})

test('diagramDrift: what a move of base breaks in a plan; none while base stays', async () => {
  const { repo, store, project, show } = setup()
  const id = /Diagram (\w+)/.exec(await show(plan([{ text: 'load(id)' }, { text: 'save(id)', diff: 'add' }])))![1]
  assert.deepEqual(await diagramDrift(project, store.data.canvases[id]), [])
  // Someone renamed load and added save on main meanwhile.
  writeFileSync(join(repo, 'src/store.ts'), 'export function read(id: string) {\n  return id\n}\nexport function save(id: string) {}\n')
  git(repo, 'commit', '-q', '-am', 'moved on')
  const drift = await diagramDrift(store.project(project.id), store.data.canvases[id])
  assert.deepEqual(drift.map((w) => `${w.code} ${w.item}`), ['not-in-base load(id)', 'exists save(id)'])
})
