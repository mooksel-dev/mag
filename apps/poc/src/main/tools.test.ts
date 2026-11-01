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
    addRepo: async (id, ref, worktree) => {
      calls.push(`add ${ref} to ${store.task(id).key}${worktree ? ' as a worktree' : ''}`)
      const local = ref === 'web'
      const r = { repo: `/nowhere/${ref}`, branch: 'mag/t-1-1', worktree: local ? '/nowhere/web' : `/nowhere/w/${ref}`, prUrl: null, prState: null, ...(local && { local }) }
      const w = store.task(id).work!
      store.updateTask(id, { work: { ...w, repos: [...w.repos, r] } })
      return r
    },
    setReview: (id, verdict, findings) => {
      calls.push(`review ${store.task(id).key}: ${verdict} ${findings.map((f) => `${f.where ?? ''}|${f.text}`).join(';')}`)
      return 'Recorded.'
    },
  }
  const tools = createTools(store, actions)
  const task = store.createTask({ projectId: project.id, title: 'Big', type: 'dev', description: '', status: 'grooming' })
  const groomer = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'running' })
  // The user has answered the groomer's checkpoint: it may plan steps.
  groomer.items.push({ kind: 'user', text: 'Option A', at: 1 })
  const call = (name: string, args: Record<string, unknown> = {}, sessionId = groomer.id) => tools({ taskId: task.id, sessionId }, name, args)
  return { store, project, task, tools, call, calls, groomer }
}

/** A step's work in a dir that does not exist: no commits of its own. */
const work = (prUrl: string | null = null): TaskWork => ({
  repos: [{ repo: '/nowhere/app', branch: 'mag/t-1-1', worktree: '/nowhere/w/app', prUrl, prState: prUrl ? 'open' : null }],
  dir: '/nowhere/w',
  feedbackSeenAt: 0,
})

test('the groomer cannot move a task to todo: mark_groomed is gone', async () => {
  const { store, task, call } = setup()
  await call('create_subtask', { title: 'Core', note: 'models', start_manually: true })
  await assert.rejects(call('mark_groomed'), /Unknown tool mark_groomed/)
  assert.equal(store.task(task.id).status, 'grooming')
  const [step] = store.data.tasks.filter((t) => t.parentId === task.id)
  assert.deepEqual([step.key, step.description, step.startManually, step.work], ['T-1.1', 'models', true, null])
})

test('checkpoint: a groomer plans steps only after the user answered it in its chat (T-55.2)', async () => {
  const { store, project, task, tools, call } = setup()
  const fresh = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'running' })
  const own = (name: string, args: Record<string, unknown> = {}) => tools({ taskId: task.id, sessionId: fresh.id }, name, args)
  await assert.rejects(own('create_subtask', { title: 'a' }), /Checkpoint first/)
  await call('create_subtask', { title: 'a' })
  await call('create_subtask', { title: 'b' })
  await assert.rejects(own('reorder_subtasks', { keys: ['T-1.2', 'T-1.1'] }), /Checkpoint first/)
  fresh.items.push({ kind: 'user', text: 'B', at: 2 })
  await own('create_subtask', { title: 'c' })
  assert.deepEqual(store.data.tasks.filter((t) => t.parentId === task.id).map((t) => t.title), ['a', 'b', 'c'])
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

test('create_task ticket_url and link_ticket: one ticket, one task', async () => {
  const { store, project, tools } = setup()
  const ctx = { projectId: project.id }
  assert.equal(await tools(ctx, 'create_task', { title: 'X', type: 'dev', description: 'd', ticket_url: 'https://acme.atlassian.net/browse/abc-12' }), 'Created T-2 in the backlog.')
  const x = store.data.tasks.find((t) => t.key === 'T-2')!
  assert.deepEqual(x.tracker, { kind: 'jira', key: 'ABC-12', url: 'https://acme.atlassian.net/browse/ABC-12', importedAt: null })
  const count = store.data.tasks.length
  await assert.rejects(tools(ctx, 'create_task', { title: 'Y', type: 'dev', description: 'd', ticket_url: 'https://acme.atlassian.net/browse/ABC-12' }), /ABC-12 is already linked to T-2/)
  await assert.rejects(tools(ctx, 'create_task', { title: 'Y', type: 'dev', description: 'd', ticket_url: 'ABC-13' }), /Not a Jira or Linear ticket link/)
  assert.equal(store.data.tasks.length, count, 'nothing created')

  assert.equal(await tools(ctx, 'link_ticket', { key: 't-1', url: 'https://linear.app/acme/issue/ENG-7/slug' }), 'Linked T-1 to ENG-7.')
  assert.deepEqual(store.data.tasks.find((t) => t.key === 'T-1')!.tracker, { kind: 'linear', key: 'ENG-7', url: 'https://linear.app/acme/issue/ENG-7', importedAt: null })
  await assert.rejects(tools(ctx, 'link_ticket', { key: 'T-1', url: 'https://acme.atlassian.net/browse/ABC-12' }), /ABC-12 is already linked to T-2/)
  const step = store.createTask({ projectId: project.id, parentId: x.id, title: 's', type: 'dev', description: '' })
  await assert.rejects(tools(ctx, 'link_ticket', { key: step.key, url: 'https://linear.app/acme/issue/ENG-8' }), /is a step; link its task T-2 instead/)
})

test('steps change only while grooming: never in a task in progress', async () => {
  const { store, task, call } = setup()
  for (const title of ['a', 'b']) await call('create_subtask', { title })
  const [a, b] = store.data.tasks.filter((t) => t.parentId === task.id)
  store.updateTask(a.id, { status: 'in_progress', work: work() })
  store.updateTask(task.id, { status: 'in_progress' })

  await assert.rejects(call('create_subtask', { title: 'c' }), /in_progress; its steps change only while grooming/)
  await assert.rejects(call('update_subtask', { key: b.key, title: 'x' }), /only while grooming/)
  await assert.rejects(call('delete_subtask', { key: b.key }), /only while grooming/)
  await assert.rejects(call('reorder_subtasks', { keys: [b.key, a.key] }), /only while grooming/)
  const dev = store.createSession({ projectId: task.projectId, taskId: task.id, stepId: a.id, role: 'developer', agent: 'claude-code', status: 'running' })
  await assert.rejects(call('create_subtask', { title: 'c' }, dev.id), /only while grooming/)
  assert.equal(store.data.tasks.filter((t) => t.parentId === task.id).length, 2)
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
  const link = { kind: 'jira' as const, key: 'ABC-12', url: null, importedAt: null }
  const task = store.createTask({ projectId: project.id, title: 'ABC-12', type: 'dev', description: '', tracker: link })
  const tracker = store.createSession({ projectId: project.id, taskId: task.id, role: 'tracker', agent: 'claude-code', status: 'running' })
  const groomer = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'running' })
  const call = (name: string, args: Record<string, unknown> = {}, sessionId = tracker.id) => tools({ taskId: task.id, sessionId }, name, args)

  assert.deepEqual(JSON.parse(await call('get_import')), { key: 'ABC-12', url: null, kind: 'jira' })
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

test('set_architecture records a module tree, drops unknown and self uses, rejects repeated ids', async () => {
  const { store, project, tools } = setup()
  const ctx = { projectId: project.id }
  const mod = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, description: 'd', uses: [], ...extra })
  const modules = [
    mod('app', {
      kind: 'Electron app',
      children: [
        mod('ui', { layer: 'app', uses: [{ to: 'tasks', calls: ['groom(id)'] }, { to: 'gone', calls: [] }, 'github', { to: 'tasks', calls: ['list()', 'groom(id)'] }] }),
        mod('tasks', { layer: 'service', uses: [{ to: 'tasks', calls: [] }], children: [] }),
      ],
    }),
    mod('github', { kind: '3rd-party API' }),
  ]
  const out = await tools(ctx, 'set_architecture', { summary: 's', modules })
  assert.equal(out, 'Recorded 4 module(s), 2 on the top level. Dropped 2 use(s) of unknown ids or of the module itself.')
  const arch = store.project(project.id).architecture!
  const [ui, tasks] = arch.modules[0].children!
  assert.deepEqual(ui.uses, [{ to: 'tasks', calls: ['groom(id)', 'list()'] }, { to: 'github', calls: [] }])
  assert.deepEqual(tasks.uses, [])
  assert.equal(tasks.children, undefined)
  await assert.rejects(tools(ctx, 'set_architecture', { summary: 's', modules: [mod('a', { children: [mod('a')] })] }), /repeated: a/)
  await assert.rejects(tools(ctx, 'set_architecture', { summary: 's', apps: [] }), /modules is required/)
})

test('show_diagram validates, saves a diagram canvas and lists it in get_task and get_diagrams', async () => {
  const { store, task, call } = setup()
  const diagram = { type: 'component', summary: 'Tasks get a queue.', modules: [{ id: 'tasks', name: 'Tasks', interface: ['list()', { text: 'groom(id)', diff: 'add' }], uses: ['queue'] }, { id: 'queue', name: 'Queue', diff: 'add' }] }
  await assert.rejects(call('show_diagram', { title: 'Bad', diagram: { type: 'component', modules: [{ id: 'a', name: 'A', uses: ['nope'] }] } }), /Not saved[\s\S]*uses "nope": no such module/)
  assert.equal(Object.keys(store.data.canvases).length, 0)
  assert.equal(await call('get_diagrams'), 'This task has no diagrams.')

  const out = await call('show_diagram', { title: 'Queue', diagram })
  const [c] = Object.values(store.data.canvases)
  assert.equal(out, `Diagram ${c.id} (v1): +2 ~1 −0. Link it as [Queue](canvas:${c.id}), a node as canvas:${c.id}#<node-id>.`)
  assert.deepEqual([c.kind, c.taskId, c.html], ['diagram', task.id, undefined])
  assert.deepEqual(c.diagram!.type === 'component' && c.diagram!.modules[0].uses, [{ to: 'queue', calls: [] }])
  assert.equal(store.data.sessions[0].items.at(-1)?.kind, 'canvas')

  assert.deepEqual(JSON.parse(await call('get_task')).diagrams, [{ id: c.id, type: 'component', title: 'Queue', changes: '+2 ~1 −0' }])
  assert.equal(JSON.parse(await call('get_diagrams'))[0].diagram.modules[1].id, 'queue')

  await call('show_diagram', { id: c.id, title: 'Queue v2', diagram: { type: 'state', entity: 'Job', states: [{ id: 'a' }], transitions: [] } })
  assert.deepEqual([store.data.canvases[c.id].version, store.data.canvases[c.id].diagram!.type], [2, 'state'])
  // An HTML canvas is not revised as a diagram, nor the other way round; neither is listed as a diagram.
  await call('show_canvas', { title: 'Mock', html: '<p>hi</p>' })
  const html = Object.values(store.data.canvases).find((x) => x.kind === 'html')!
  await assert.rejects(call('show_diagram', { id: html.id, title: 'X', diagram }), /is HTML: revise it with show_canvas/)
  await assert.rejects(call('show_canvas', { id: c.id, title: 'X', html: '<p/>' }), /is a diagram: revise it with show_diagram/)
  assert.equal(JSON.parse(await call('get_task')).diagrams.length, 1)
})

test('show_diagram: one flowchart per method of; the same one is revised by id', async () => {
  const { store, call } = setup()
  const flow = (of: string) => ({ type: 'flowchart', of, summary: 'Queue first.', changes: ['Queues the job'], nodes: [{ id: 's', label: 'Start', shape: 'start' }], edges: [] })
  await call('show_diagram', { title: 'groom()', diagram: flow('tasks#groom') })
  const [c] = Object.values(store.data.canvases)
  assert.deepEqual(c.diagram, { type: 'flowchart', of: 'tasks#groom', summary: 'Queue first.', changes: ['Queues the job'], nodes: [{ id: 's', label: 'Start', shape: 'start' }], edges: [] })
  await assert.rejects(call('show_diagram', { title: 'Again', diagram: flow(' tasks#groom ') }), new RegExp(`flowchart ${c.id} \\("groom\\(\\)"\\) already shows tasks#groom; revise it with id ${c.id}`))
  await assert.rejects(call('show_diagram', { title: 'Bad', diagram: flow('tasks') }), /of must be "<moduleId>#<method>"/)
  // Revising the flow itself, and a flow of another method, are fine; a module or method need not exist yet.
  await call('show_diagram', { id: c.id, title: 'groom() v2', diagram: flow('tasks#groom') })
  await call('show_diagram', { title: 'list()', diagram: flow('tasks#list') })
  assert.deepEqual([store.data.canvases[c.id].version, Object.keys(store.data.canvases).length], [2, 2])
})

test('steps get repos from the groomer: names or paths of project repos; get_task lists them (T-50)', async () => {
  const { store, project, task, call } = setup()
  store.updateProject(project.id, { repos: ['/w/app', '/w/api'] })
  await call('create_subtask', { title: 'a', repos: ['api', '/w/app/'] })
  await call('create_subtask', { title: 'b', repos: [] })
  await call('create_subtask', { title: 'c' })
  await assert.rejects(call('create_subtask', { title: 'd', repos: ['web'] }), /Not a repository of the project: web; one of app, api/)
  const [a, b, c] = store.data.tasks.filter((t) => t.parentId === task.id)
  assert.deepEqual([a.repos, b.repos, c.repos], [['/w/app', '/w/api'], [], undefined], 'paths in project order; missing = every repository')
  await call('update_subtask', { key: c.key, repos: ['app'] })
  await assert.rejects(call('update_subtask', { key: c.key, repos: 'app' }), /must be an array/)
  assert.deepEqual(store.task(c.id).repos, ['/w/app'])
  const info = JSON.parse(await call('get_task'))
  assert.deepEqual(info.subtasks.map((s: { repos?: string[] }) => s.repos), [['app', 'api'], [], ['app']])
})

test('add_repo: the developer of a step in progress only', async () => {
  const { store, task, call, calls } = setup()
  await call('create_subtask', { title: 'a' })
  const [a] = store.data.tasks.filter((t) => t.parentId === task.id)
  await assert.rejects(call('add_repo', { repo: 'api' }), /for the developer of a step/)
  store.updateTask(task.id, { status: 'in_progress' })
  store.updateTask(a.id, { status: 'in_progress', work: work() })
  const dev = store.createSession({ projectId: task.projectId, taskId: task.id, stepId: a.id, role: 'developer', agent: 'claude-code', status: 'running' })
  await assert.rejects(call('add_repo', {}, dev.id), /Pass repo/)
  assert.match(await call('add_repo', { repo: 'api' }, dev.id), /^api: worktree \/nowhere\/w\/api on branch mag\/t-1-1\./)
  assert.match(await call('add_repo', { repo: 'web' }, dev.id), /^web: the main checkout \/nowhere\/web, on branch mag\/t-1-1 \(the task works there locally\)/)
  await call('add_repo', { repo: 'db', worktree: true }, dev.id)
  assert.deepEqual(calls, ['add api to T-1.1', 'add web to T-1.1', 'add db to T-1.1 as a worktree'])
})

test('set_review is the reviewer\'s alone and records the verdict of its step', async () => {
  const { store, project, task, call, calls } = setup()
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'in_progress' })
  const reviewer = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'reviewer', agent: 'claude-code', status: 'running' })
  await assert.rejects(call('set_review', { verdict: 'merge', findings: [] }), /not available to the groomer/)
  await assert.rejects(call('set_review', { verdict: 'ok', findings: [] }, reviewer.id), /verdict must be one of/)
  await assert.rejects(call('set_review', { verdict: 'look', findings: [] }, reviewer.id), /needs findings/)
  await assert.rejects(call('set_review', { verdict: 'changes', findings: [{ where: 'a.ts' }] }, reviewer.id), /needs a text/)
  await call('set_review', { verdict: 'changes', findings: JSON.stringify([{ text: ' no test ', where: 'a.ts:3' }, { text: 'scope' }]) }, reviewer.id)
  await call('set_review', { verdict: 'merge', findings: [] }, reviewer.id)
  assert.deepEqual(calls, ['review T-1.1: changes a.ts:3|no test;|scope', 'review T-1.1: merge '])
})

test('the reviewer reads the task but changes nothing', async () => {
  const { store, project, task, call } = setup()
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'in_progress' })
  const reviewer = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'reviewer', agent: 'claude-code', status: 'running' })
  assert.match(await call('get_doc', {}, reviewer.id), /empty/)
  for (const name of ['update_doc', 'set_pr', 'set_needs_input', 'complete_step', 'create_subtask'])
    await assert.rejects(call(name, { markdown: 'x', url: 'https://github.com/o/r/pull/1', reason: 'x', title: 'x' }, reviewer.id), /not available to the reviewer/)
})

test('create_task from a topic makes the topic the owner of the work', async () => {
  const { store, project, tools } = setup()
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  await tools({ projectId: project.id, sessionId: topic.id }, 'create_task', { title: 'Owned', type: 'dev', description: 'd' })
  await tools({ projectId: project.id }, 'create_task', { title: 'Orphan', type: 'dev', description: 'd' })
  assert.equal(store.data.tasks.find((t) => t.title === 'Owned')!.ownerSessionId, topic.id)
  assert.equal(store.data.tasks.find((t) => t.title === 'Orphan')!.ownerSessionId, undefined)
})
