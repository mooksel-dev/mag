import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskWork } from '@mag/core'
import { Store } from './store.ts'
import { createTools, type ToolActions } from './tools.ts'

const setup = () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-tools-')), 'db.json'))
  const project = store.createProject('p')
  const calls: string[] = []
  const actions: ToolActions = {
    groom: () => {},
    architect: () => {},
    cancel: async () => {},
    completeStep: async (id) => {
      calls.push(`complete ${store.task(id).key}`)
      store.updateTask(id, { status: 'done' })
    },
    regroomed: async (id) => void calls.push(`regroomed ${store.task(id).key}`),
  }
  const tools = createTools(store, actions)
  const task = store.createTask({ projectId: project.id, title: 'Big', type: 'dev', description: '', status: 'grooming' })
  const groomer = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'running' })
  const call = (name: string, args: Record<string, unknown> = {}, sessionId = groomer.id) => tools({ taskId: task.id, sessionId }, name, args)
  return { store, project, task, tools, call, calls }
}

/** A step's work in a dir that does not exist: no commits of its own. */
const work = (prUrl: string | null = null): TaskWork => ({
  repos: [{ repo: '/nowhere/app', branch: 'mag/t-1-1', worktree: '/nowhere/w/app', prUrl, prState: prUrl ? 'open' : null }],
  dir: '/nowhere/w',
  feedbackSeenAt: 0,
})

test('mark_groomed needs at least one step', async () => {
  const { store, task, call } = setup()
  await assert.rejects(call('mark_groomed'), /Add at least one step with create_subtask/)
  await call('create_subtask', { title: 'Core', note: 'models', start_manually: true })
  assert.equal(await call('mark_groomed'), 'Task groomed: it is in todo, ready for the user to start.')
  assert.equal(store.task(task.id).status, 'todo')
  const [step] = store.data.tasks.filter((t) => t.parentId === task.id)
  assert.deepEqual([step.key, step.description, step.startManually, step.work], ['T-1.1', 'models', true, null])
})

test('create_task with plan: true needs steps', async () => {
  const { store, project, tools } = setup()
  const ctx = { projectId: project.id }
  await assert.rejects(tools(ctx, 'create_task', { title: 'X', type: 'dev', description: 'd', doc: '# Doc', plan: true }), /needs steps/)
  await tools(ctx, 'create_task', { title: 'X', type: 'dev', description: 'd', doc: '# Doc', plan: true, steps: [{ title: 'One' }, { title: 'Two', start_manually: true }] })
  const x = store.data.tasks.find((t) => t.title === 'X')!
  assert.equal(x.status, 'todo')
  assert.deepEqual(store.data.tasks.filter((t) => t.parentId === x.id).map((t) => [t.title, t.startManually]), [['One', false], ['Two', true]])
})

test('remaining mode: done steps locked, the current one renamed only, todo ones free', async () => {
  const { store, task, call, calls } = setup()
  for (const title of ['a', 'b', 'c', 'd']) await call('create_subtask', { title })
  const [a, b, c, d] = store.data.tasks.filter((t) => t.parentId === task.id)
  store.updateTask(a.id, { status: 'done' })
  store.updateTask(b.id, { status: 'in_progress', work: work() })
  store.updateTask(task.id, { status: 'in_progress' })

  await assert.rejects(call('update_subtask', { key: a.key, title: 'x' }), /done steps are locked/)
  await call('update_subtask', { key: b.key, title: 'b2' })
  assert.equal(store.task(b.id).title, 'b2')
  await assert.rejects(call('delete_subtask', { key: b.key }), /current step/)
  await assert.rejects(call('reorder_subtasks', { keys: [b.key, a.key, c.key, d.key] }), /keep their places/)
  await call('reorder_subtasks', { keys: [a.key, b.key, d.key, c.key] })
  await call('delete_subtask', { key: c.key })
  await call('create_subtask', { title: 'e' })

  const dev = store.createSession({ projectId: task.projectId, taskId: task.id, stepId: b.id, role: 'developer', agent: 'claude-code', status: 'running' })
  await assert.rejects(call('create_subtask', { title: 'f' }, dev.id), /Only the groomer/)

  assert.match(await call('mark_groomed'), /continues with T-1.2/)
  assert.deepEqual(calls, ['regroomed T-1'])
})

test('step status follows the lifecycle: set_subtask_status is legacy only, complete_step closes a step without code', async () => {
  const { store, task, call, calls } = setup()
  await call('create_subtask', { title: 'a' })
  await call('create_subtask', { title: 'b' })
  const [a] = store.data.tasks.filter((t) => t.parentId === task.id)
  await assert.rejects(call('set_subtask_status', { key: a.key, status: 'done' }), /follows its lifecycle/)
  store.updateTask(task.id, { status: 'in_progress' })
  store.updateTask(a.id, { status: 'in_progress', work: work() })
  const dev = store.createSession({ projectId: task.projectId, taskId: task.id, stepId: a.id, role: 'developer', agent: 'claude-code', status: 'running' })
  assert.match(await call('complete_step', {}, dev.id), /T-1.1 is done. Next: T-1.2/)
  assert.deepEqual(calls, ['complete T-1.1'])
  await assert.rejects(call('complete_step', {}, dev.id), /No step is in progress/)
})

test('set_pr writes to the step; a second live PR for a repo is an error', async () => {
  const { store, task, call } = setup()
  await call('create_subtask', { title: 'a' })
  const [a] = store.data.tasks.filter((t) => t.parentId === task.id)
  store.updateTask(task.id, { status: 'in_progress' })
  store.updateTask(a.id, { status: 'in_progress', work: work() })
  const dev = store.createSession({ projectId: task.projectId, taskId: task.id, stepId: a.id, role: 'developer', agent: 'claude-code', status: 'running' })
  await call('set_pr', { url: 'https://github.com/o/app/pull/1' }, dev.id)
  assert.equal(store.task(a.id).work?.repos[0].prUrl, 'https://github.com/o/app/pull/1')
  assert.equal(store.task(task.id).work, null)
  await assert.rejects(call('set_pr', { url: 'https://github.com/o/app/pull/2' }, dev.id), /already has/)
  const info = JSON.parse(await call('get_task', {}, dev.id))
  assert.deepEqual(info.subtasks[0], { key: 'T-1.1', title: 'a', status: 'in_progress', startManually: false, prs: ['https://github.com/o/app/pull/1 (open)'], current: true })
  assert.equal(info.work.dir, '/nowhere/w')
})

test('tracker tools: get_import and set_brief for the tracker only; get_task shows the ticket', async () => {
  const { store, project, tools } = setup()
  const link = { integrationId: 'atl', kind: 'jira' as const, key: 'ABC-12', url: null, importedAt: null }
  const task = store.createTask({ projectId: project.id, title: 'ABC-12', type: 'dev', description: '', tracker: link })
  const tracker = store.createSession({ projectId: project.id, taskId: task.id, role: 'tracker', agent: 'claude-code', status: 'running' })
  const groomer = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'running' })
  const call = (name: string, args: Record<string, unknown> = {}, sessionId = tracker.id) => tools({ taskId: task.id, sessionId }, name, args)

  assert.deepEqual(JSON.parse(await call('get_import')), { key: 'ABC-12', url: null, kind: 'jira', scope: 'ABC' })
  await assert.rejects(call('update_doc', { markdown: 'x' }), /not available to the tracker agent/)
  await assert.rejects(call('set_brief', { title: 'T', brief: 'B' }, groomer.id), /not available to the groomer agent/)
  await assert.rejects(call('set_brief', { title: 'T', brief: ' ' }), /required/)
  await assert.rejects(call('set_brief', { title: 'T', brief: 'B', url: 'javascript:alert(1)' }), /https/)

  await call('set_brief', { title: ' Fix  login ', brief: '# Login\nbroken', url: 'https://acme.atlassian.net/browse/ABC-12' })
  const t = store.task(task.id)
  assert.deepEqual([t.title, t.description, t.tracker?.url], ['Fix login', '# Login\nbroken', 'https://acme.atlassian.net/browse/ABC-12'])
  assert.ok(t.tracker?.importedAt)
  assert.equal(JSON.parse(await call('get_task', {}, groomer.id)).tracker.key, 'ABC-12')
})
