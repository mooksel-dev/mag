// Plan diagrams against the vocabulary (T-58 Decision 8): show_diagram's warnings on module ids.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchDiagram } from '@mag/core'
import { Store } from './store.ts'
import { createTools, type ToolActions } from './tools.ts'

const ARCH: ArchDiagram = {
  summary: '',
  updatedAt: 1,
  modules: [{ id: 'app', name: 'app', description: '', uses: [], paths: ['src'], children: [{ id: 'store', name: 'store', description: '', uses: [], paths: ['src/store.ts'] }] }],
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-plan-'))
  const store = new Store(join(dir, 'db.json'))
  const project = store.createProject('p')
  store.updateProject(project.id, { repos: [join(dir, 'app')], architecture: ARCH })
  const task = store.createTask({ projectId: project.id, title: 'X', type: 'dev', description: '', status: 'planning' })
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'todo' })
  const tools = createTools(store, {} as ToolActions)
  const show = (diagram: unknown, id?: string) => tools({ taskId: task.id }, 'show_diagram', { title: 'Plan', diagram, role: 'plan', step: step.key, ...(id && { id }) })
  return { store, project, show }
}

const plan = (modules: unknown[]) => ({ type: 'component', summary: 's', modules })
const mod = (id: string, extra: object = {}) => ({ id, name: id, description: '', uses: [], ...extra })

test('show_diagram: a plan is checked against the architecture and saved with its warnings', async () => {
  const { store, show } = setup()
  const out = await show(plan([mod('store', { interface: [{ text: 'save(id)', diff: 'add' }] }), mod('cache'), mod('app', { children: [mod('queue', { diff: 'add', layer: 'service' })] })]))
  const id = /Diagram (\w+)/.exec(out)![1]
  assert.match(out, /\nSaved, but its modules disagree with the architecture \(get_architecture\)\. Fix the diagram.*\n- cache is not a module of the architecture.*\n- New module queue has no path/)
  const fixed = await show(plan([mod('store', { interface: [{ text: 'save(id)', diff: 'add' }] }), mod('cache', { diff: 'add', kind: 'database' })]), id)
  assert.match(fixed, /Its modules are those of the architecture\.$/)
  assert.equal(store.data.canvases[id].version, 2)
})

test('show_diagram: other diagram types and projects without an architecture are not checked', async () => {
  const { store, project, show } = setup()
  const seq = await show({ type: 'sequence', participants: [{ id: 'a', label: 'a' }], messages: [] })
  assert.doesNotMatch(seq, /architecture/)
  store.updateProject(project.id, { architecture: null })
  assert.doesNotMatch(await show(plan([mod('nope')])), /architecture/)
})
