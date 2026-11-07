import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { emptyResult, type Diagram, type TaskWork } from '@mag/core'
import { Store } from './store.ts'
import { createTools, type ToolActions } from './tools.ts'
import { toolsFor } from './tool-defs.ts'

/** The chat's control tools: tested against the orchestrator (orchestrator.test.ts). */
const NO_CONTROL: Pick<ToolActions, 'startChild' | 'sessionInTree' | 'stop' | 'approve' | 'approveAndStart' | 'develop' | 'startStep' | 'restartReview' | 'agentOf' | 'send' | 'stopAgents' | 'closeChat' | 'closeWork' | 'deleteChat' | 'deleteWork' | 'restore'> = {
  approve: () => {},
  closeChat: async () => {},
  closeWork: () => {},
  deleteChat: async () => {},
  deleteWork: async () => {},
  restore: () => {},
  develop: async () => {},
  approveAndStart: async () => {},
  startStep: async () => {},
  restartReview: async () => {},
  agentOf: () => null,
  send: async () => {},
  stopAgents: async () => [],
  startChild: () => { throw new Error('Not ready') },
  sessionInTree: () => { throw new Error('Not ready') },
  stop: async () => {},
}

const setup = () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-tools-')), 'db.json'))
  const project = store.createProject('p')
  const calls: string[] = []
  /** What askOwner says: the owner takes the question (false: busy or gone). */
  let owner = false
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
      const r = { repo: `/nowhere/${ref}`, branch: 'mag/big-1', worktree: local ? '/nowhere/web' : `/nowhere/w/${ref}`, prUrl: null, prState: null, ...(local && { local }) }
      const w = store.task(id).work!
      store.updateTask(id, { work: { ...w, repos: [...w.repos, r] } })
      return r
    },
    setReview: (id, verdict, findings) => {
      calls.push(`review ${store.task(id).key}: ${verdict} ${findings.map((f) => `${f.where ?? ''}|${f.text}`).join(';')}`)
      return 'Recorded.'
    },
    reopen: () => 'Reopened.',
    askOwner: (id, question) => (calls.push(`ask owner of ${store.task(id).key}: ${question}`), owner),
    answerDeveloper: async (id, text) => {
      calls.push(`answer ${store.task(id).key}: ${text}`)
    },
    reviewPr: async (projectId, url, by, format) => {
      calls.push(`review_pr ${url} by ${by}${format ? ` ${format}` : ""}`)
      return { taskId: 'r', job: 'Review it.' }
    },
    exportReview: async (id, path) => (calls.push(`export ${store.task(id).key}${path ? ` to ${path}` : ''}`), `${path ?? '/Downloads'}/api-418-review.zip`),
    reviewFact: async (id) => (calls.push(`fact of ${store.task(id).key}`), 'Fact'),
    setPrReview: (id, _s, r) => (calls.push(`pr review ${store.task(id).key}: ${r.verdict} ${r.findings.map((f) => `${f.level}|${f.where ?? ''}|${f.node ?? ''}|${f.text}`).join(';')}`), 'Recorded.'),
    decideDirection: (id, d) => (calls.push(`direction ${store.task(id).key}: ${d.choice}${d.option ? ` ${d.option}` : ''}${d.principle ? ` (${d.principle})` : ''}`), 'Recorded.'),
    ...NO_CONTROL,
  }
  const tools = createTools(store, actions)
  const task = store.createTask({ projectId: project.id, title: 'Big', type: 'dev', description: '', status: 'planning' })
  const groomer = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'running' })
  // The user has answered the groomer's checkpoint: it may plan steps.
  groomer.items.push({ kind: 'user', text: 'Option A', at: 1 })
  const call = (name: string, args: Record<string, unknown> = {}, sessionId = groomer.id) => tools({ taskId: task.id, sessionId }, name, args)
  return { store, project, task, tools, call, calls, groomer, ownerTakes: (v: boolean) => (owner = v) }
}

/** A step's work in a dir that does not exist: no commits of its own. */
const work = (prUrl: string | null = null): TaskWork => ({
  repos: [{ repo: '/nowhere/app', branch: 'mag/big-1', worktree: '/nowhere/w/app', prUrl, prState: prUrl ? 'open' : null }],
  dir: '/nowhere/w',
  feedbackSeenAt: 0,
})

test('the groomer cannot approve its plan: mark_groomed is gone', async () => {
  const { store, task, call } = setup()
  await call('create_subtask', { title: 'Core', note: 'models', start_manually: true })
  await assert.rejects(call('mark_groomed'), /Unknown tool mark_groomed/)
  assert.equal(store.task(task.id).status, 'planning')
  const [step] = store.data.tasks.filter((t) => t.parentId === task.id)
  assert.deepEqual([step.key, step.description, step.startManually, step.work], ['big.1', 'models', true, null])
})

test('checkpoint: a groomer plans steps only after the user answered it in its chat (T-55.2)', async () => {
  const { store, project, task, tools, call } = setup()
  const fresh = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'running' })
  const own = (name: string, args: Record<string, unknown> = {}) => tools({ taskId: task.id, sessionId: fresh.id }, name, args)
  await assert.rejects(own('create_subtask', { title: 'a' }), /Checkpoint first/)
  await call('create_subtask', { title: 'a' })
  await call('create_subtask', { title: 'b' })
  await assert.rejects(own('reorder_subtasks', { keys: ['big.2', 'big.1'] }), /Checkpoint first/)
  fresh.items.push({ kind: 'user', text: 'B', at: 2 })
  await own('create_subtask', { title: 'c' })
  assert.deepEqual(store.data.tasks.filter((t) => t.parentId === task.id).map((t) => t.title), ['a', 'b', 'c'])
})

test('create_work with plan: true needs steps', async () => {
  const { store, project, tools } = setup()
  const ctx = { projectId: project.id }
  await assert.rejects(tools(ctx, 'create_work', { title: 'X', type: 'dev', description: 'd', doc: '# Doc', plan: true }), /needs steps/)
  await tools(ctx, 'create_work', { title: 'X', type: 'dev', description: 'd', doc: '# Doc', plan: true, steps: [{ title: 'One' }, { title: 'Two', start_manually: true }] })
  const x = store.data.tasks.find((t) => t.title === 'X')!
  assert.equal(x.status, 'ready')
  assert.deepEqual(store.data.tasks.filter((t) => t.parentId === x.id).map((t) => [t.title, t.startManually]), [['One', false], ['Two', true]])
})

test('create_work tickets and add_ticket: links only, any tracker, a ticket in several works (T-55.5)', async () => {
  const { store, project, tools } = setup()
  const ctx = { projectId: project.id }
  const jira = 'https://acme.atlassian.net/browse/abc-12'
  assert.equal(await tools(ctx, 'create_work', { title: 'X', description: 'd', tickets: [{ url: jira }, { url: 'https://github.com/o/r/issues/5', key: 'r#5' }] }), 'Created ABC-12 in planning; nobody owns it yet: start_grooming plans it.')
  const x = store.data.tasks.find((t) => t.key === 'ABC-12')!
  assert.equal(x.type, 'dev', 'type defaults to dev')
  assert.deepEqual(x.tickets, [{ url: jira, key: 'ABC-12' }, { url: 'https://github.com/o/r/issues/5', key: 'r#5' }])
  await tools(ctx, 'create_work', { title: 'Y', description: 'd', tickets: JSON.stringify([jira]) })
  assert.deepEqual(store.data.tasks.find((t) => t.key === 'ABC-12-2')!.tickets, [{ url: jira, key: 'ABC-12' }], 'the same ticket in another work')
  assert.equal(store.data.tasks.find((t) => t.title === 'Big')!.tickets, undefined, 'a work without a ticket')
  const count = store.data.tasks.length
  await assert.rejects(tools(ctx, 'create_work', { title: 'Z', description: 'd', tickets: [{ url: 'ABC-13' }] }), /Not a ticket link: ABC-13/)
  assert.equal(store.data.tasks.length, count, 'nothing created')

  assert.match(await tools(ctx, 'add_ticket', { key: 'big', url: 'https://linear.app/acme/issue/ENG-7/slug' }), /big is about ENG-7 now \(1 ticket/)
  await tools(ctx, 'add_ticket', { key: 'big', url: 'https://linear.app/acme/issue/ENG-7/slug' })
  await tools(ctx, 'add_ticket', { key: 'big', url: 'https://jira.example.com/issue/1', ticket_key: 'OPS-1' })
  assert.deepEqual(store.task(store.data.tasks.find((t) => t.key === 'big')!.id).tickets, [{ url: 'https://linear.app/acme/issue/ENG-7/slug', key: 'ENG-7' }, { url: 'https://jira.example.com/issue/1', key: 'OPS-1' }])
  const step = store.createTask({ projectId: project.id, parentId: x.id, title: 's', type: 'dev', description: '' })
  await assert.rejects(tools(ctx, 'add_ticket', { key: step.key, url: 'https://linear.app/acme/issue/ENG-8' }), /is a step; add the ticket to its work ABC-12/)
  assert.deepEqual(JSON.parse(await tools(ctx, 'list_tasks', {})).tasks.find((t: { key: string }) => t.key === 'ABC-12').tickets, [jira, 'https://github.com/o/r/issues/5'])
})

test('steps change only while planning: never in a task in progress', async () => {
  const { store, task, call } = setup()
  for (const title of ['a', 'b']) await call('create_subtask', { title })
  const [a, b] = store.data.tasks.filter((t) => t.parentId === task.id)
  store.updateTask(a.id, { status: 'in_progress', work: work() })
  store.updateTask(task.id, { status: 'in_progress' })

  await assert.rejects(call('create_subtask', { title: 'c' }), /in_progress; its steps change only while planning/)
  await assert.rejects(call('update_subtask', { key: b.key, title: 'x' }), /only while planning/)
  await assert.rejects(call('delete_subtask', { key: b.key }), /only while planning/)
  await assert.rejects(call('reorder_subtasks', { keys: [b.key, a.key] }), /only while planning/)
  const dev = store.createSession({ projectId: task.projectId, taskId: task.id, stepId: a.id, role: 'developer', agent: 'claude-code', status: 'running' })
  await assert.rejects(call('create_subtask', { title: 'c' }, dev.id), /only while planning/)
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
  assert.match(await call('complete_step', {}, dev.id), /big.1 is done. Next: big.2/)
  assert.deepEqual(calls, ['complete big.1'])
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
  assert.deepEqual(info.subtasks[0], { key: 'big.1', title: 'a', status: 'in_progress', startManually: false, prs: ['https://github.com/o/app/pull/1 (open)'], current: true })
  assert.equal(info.work.dir, '/nowhere/w')
})

test("set_needs_input of a step's developer goes to the work's owner first; answer_developer is the owner's (ahent-vede-robotu-vlasna-pozytsiia.2)", async () => {
  const { store, task, call, calls, groomer, ownerTakes } = setup()
  await call('create_subtask', { title: 'a' })
  const [a] = store.data.tasks.filter((t) => t.parentId === task.id)
  store.updateTask(task.id, { status: 'in_progress', ownerSessionId: groomer.id })
  store.updateTask(a.id, { status: 'in_progress', work: work() })
  const dev = store.createSession({ projectId: task.projectId, taskId: task.id, stepId: a.id, role: 'developer', agent: 'claude-code', status: 'running' })

  ownerTakes(true)
  assert.match(await call('set_needs_input', { reason: 'Which schema?' }, dev.id), /owner, who planned it, gets your question first/)
  assert.deepEqual(calls, ['ask owner of big.1: Which schema?'])
  assert.equal(store.task(task.id).needsInput, null, 'the user is not asked yet')

  await assert.rejects(call('answer_developer', { step: 'big.1', text: 'v2' }, dev.id), /answer_developer is for the owner of big/)
  await assert.rejects(call('answer_developer', { step: 'big.1', text: ' ' }), /text is required/)
  await assert.rejects(call('answer_developer', { step: 'big.9', text: 'v2' }), /big.9 is not a subtask of big/)
  assert.match(await call('answer_developer', { step: 'big.1', text: 'v2, by the decisions' }), /Sent to the developer of big.1/)
  assert.deepEqual(calls.at(-1), 'answer big.1: v2, by the decisions')

  // The owner busy or gone: the user is asked, as before.
  ownerTakes(false)
  assert.equal(await call('set_needs_input', { reason: 'Drop the cache?' }, dev.id), 'The user will be notified.')
  assert.equal(store.task(task.id).needsInput, 'Drop the cache?')
  // The owner's own question goes to the user.
  await call('set_needs_input', { reason: 'Plan changed: approve?' })
  assert.equal(store.task(task.id).needsInput, 'Plan changed: approve?')
  assert.equal(calls.filter((c) => c.startsWith('ask owner')).length, 2)
})

test('set_needs_input keeps the questions with their recommendations for the card; they go with needsInput (ux-odna-rozmova-na-robotu.2)', async () => {
  const { store, task, call } = setup()
  const questions = [{ text: 'Delete for good?', recommendation: 'Yes: nothing on GitHub' }, { text: 'One PR?', recommendation: 'Yes: small' }]
  assert.equal(await call('set_needs_input', { reason: '2 decisions', questions }), 'The user will be notified, with 2 questions and your recommendations on a card.')
  assert.deepEqual(store.task(task.id).needsQuestions, questions)
  await assert.rejects(call('set_needs_input', { reason: 'x', questions: [{ recommendation: 'y' }] }), /needs a text/)
  // Anything that clears or replaces needsInput takes the questions with it.
  store.updateTask(task.id, { needsInput: null })
  assert.equal(store.task(task.id).needsQuestions, null)
  await call('set_needs_input', { reason: 'Again', questions })
  assert.equal(await call('set_needs_input', { reason: null, questions }), 'Cleared.')
  assert.equal(store.task(task.id).needsQuestions, null)
})

test('get_task shows the work\'s tickets', async () => {
  const { store, task, call } = setup()
  store.updateTask(task.id, { tickets: [{ url: 'https://acme.atlassian.net/browse/ABC-12', key: 'ABC-12' }] })
  assert.deepEqual(JSON.parse(await call('get_task')).tickets, [{ url: 'https://acme.atlassian.net/browse/ABC-12', key: 'ABC-12' }])
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

test('set_architecture records levels and paths, keeps ids of the same code, lists files without a module', async () => {
  const { store, project, tools } = setup()
  const repo = mkdtempSync(join(tmpdir(), 'mag-arch-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  for (const f of ['app/ui/a.tsx', 'app/ui/b.tsx', 'app/store/s.ts', 'app/tasks/t.ts', 'tools/x.py', 'README.md']) {
    mkdirSync(join(repo, dirname(f)), { recursive: true })
    writeFileSync(join(repo, f), '')
  }
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  store.updateProject(project.id, { repos: [repo] })
  const ctx = { projectId: project.id }
  const mod = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, description: 'd', uses: [], ...extra })
  const first = [mod('app', { path: './app/', children: [mod('ui', { paths: ['app/ui'], uses: [{ to: 'store', calls: [] }] }), mod('store', { paths: ['app/store'] })] }), mod('github')]
  const out = await tools(ctx, 'set_architecture', { summary: 's', modules: first })
  assert.match(out, /1 code file\(s\) belong to no module: tools\/x\.py\. Every code file/)
  const [app, gh] = store.project(project.id).architecture!.modules
  assert.deepEqual([app.level, app.paths, app.path, app.children![0].level, gh.level, gh.paths], ['system', ['app'], undefined, 'module', 'system', undefined])
  // A new run calls ui "views" and covers every file: views gets ui's id back, in the uses too.
  const second = [
    mod('app', { paths: ['app', 'tools'], children: [mod('views', { paths: ['app/ui'], uses: [{ to: 'state', calls: [] }] }), mod('state', { paths: ['app/store'] }), mod('tasks', { paths: ['app/tasks'] })] }),
    mod('github', { level: 'system' }),
  ]
  const again = await tools(ctx, 'set_architecture', { summary: 's', modules: second })
  assert.equal(again, 'Recorded 5 module(s), 2 on the top level. Kept the previous ids of modules that own the same code: views → ui, state → store.')
  const kids = store.project(project.id).architecture!.modules[0].children!
  assert.deepEqual(kids.map((k) => k.id), ['ui', 'store', 'tasks'])
  assert.deepEqual(kids[0].uses, [{ to: 'store', calls: [] }])
  await assert.rejects(tools(ctx, 'set_architecture', { summary: 's', modules: [mod('a', { paths: ['app'] }), mod('b', { paths: ['./app'] })] }), /paths given by several: "app" \(a, b\)/)
  await assert.rejects(tools(ctx, 'set_architecture', { summary: 's', modules: [mod('a', { paths: ['/etc'] })] }), /relative to the repository/)
  await assert.rejects(tools(ctx, 'set_architecture', { summary: 's', modules: [mod('a', { children: [mod('b', { level: 'module', children: [mod('c', { level: 'system' })] })] })] }), /c: a system cannot be inside a module/)
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

test('show_diagram warns where a data diagram breaks the rules of the diff: owner, stored data, relations (povnyi-diff-nabir-pov-iazanykh.3)', async () => {
  const { call } = setup()
  const out = await call('show_diagram', {
    title: 'Data',
    diagram: {
      type: 'data',
      entities: [
        { id: 'jobs', name: 'dar_jobs', kind: 'collection', fields: [{ name: 'user_id', type: 'string' }, { name: 'sent_at', type: 'time', diff: 'add' }] },
        { id: 'MockClient', name: 'MockClient', kind: 'struct', module: 'sendgrid', fields: [] },
      ],
      relations: [],
    },
  })
  assert.match(out, /Saved, but fix it and revise it by id:\n- Entity MockClient: mocks, fakes and test-only types/)
  assert.match(out, /- Entity jobs has no module/)
  assert.match(out, /- Field "user_id" of jobs refers to another entity/)
  assert.match(out, /- Entity MockClient \(struct\): not stored data\?/)
})

test('show_diagram: one flowchart per method of; the same one is revised by id', async () => {
  const { store, call } = setup()
  const flow = (of: string) => ({ type: 'flowchart', of, summary: 'Queue first.', changes: ['Queues the job'], nodes: [{ id: 's', label: 'Start', shape: 'start' }], edges: [] })
  await call('show_diagram', { title: 'groom()', diagram: flow('tasks#groom') })
  const [c] = Object.values(store.data.canvases)
  assert.deepEqual(c.diagram, { type: 'flowchart', of: 'tasks#groom', summary: 'Queue first.', changes: ['Queues the job'], nodes: [{ id: 's', label: 'Start', shape: 'start' }], edges: [] })
  await assert.rejects(call('show_diagram', { title: 'Again', diagram: flow(' tasks#groom ') }), new RegExp(`flowchart ${c.id} \\("groom\\(\\)"\\) already shows tasks#groom in this set; revise it with id ${c.id}`))
  await assert.rejects(call('show_diagram', { title: 'Bad', diagram: flow('tasks') }), /of must be "<moduleId>#<method>"/)
  // Revising the flow itself, and a flow of another method, are fine; a module or method need not exist yet.
  await call('show_diagram', { id: c.id, title: 'groom() v2', diagram: flow('tasks#groom') })
  await call('show_diagram', { title: 'list()', diagram: flow('tasks#list') })
  assert.deepEqual([store.data.canvases[c.id].version, Object.keys(store.data.canvases).length], [2, 2])
})

test('diagrams as data: show_diagram and place_diagram place a diagram as an option or in a step and repo; get_diagrams(step) (T-55.3)', async () => {
  const { store, project, task, call } = setup()
  store.updateProject(project.id, { repos: ['/r/api', '/r/web'] })
  const state = { type: 'state', entity: 'Job', states: [{ id: 'a' }], transitions: [] }
  await call('show_diagram', { title: 'A', diagram: state, role: 'option', option: 'A' })
  const a = Object.values(store.data.canvases)[0]
  assert.deepEqual([a.role, a.option, a.stepId, a.repo], ['option', 'A', null, null])
  await assert.rejects(call('show_diagram', { title: 'X', diagram: state, role: 'option' }), /role option needs option/)
  await assert.rejects(call('show_diagram', { title: 'X', diagram: state, step: 'big.1' }), /go with a role/)
  await assert.rejects(call('show_diagram', { title: 'X', diagram: state, role: 'plan', step: 'big.1' }), /role plan needs step/)

  await call('create_subtask', { title: 'Api', repos: ['api'] })
  await call('create_subtask', { title: 'Web', repos: ['web'] })
  const out = await call('show_diagram', { title: 'Api plan', diagram: state, role: 'plan', step: 'big.1', repo: 'api' })
  const plan = Object.values(store.data.canvases).find((c) => c.title === 'Api plan')!
  assert.match(out, new RegExp(`^Diagram ${plan.id} \\(v1\\) in the plan of big.1 \\(api\\):`))
  assert.deepEqual([plan.role, plan.stepId, plan.repo], ['plan', store.data.tasks.find((t) => t.key === 'big.1')!.id, '/r/api'])
  await assert.rejects(call('show_diagram', { title: 'X', diagram: state, role: 'plan', step: 'big.1', repo: 'web' }), /big.1 does not change web; its repos: api/)
  await assert.rejects(call('show_diagram', { title: 'X', diagram: state, role: 'plan', step: 'big.1', repo: 'nope' }), /Not a repository of the project: nope/)
  // A revision without role keeps the place; place_diagram moves it without a new version.
  await call('show_diagram', { id: plan.id, title: 'Api plan', diagram: state })
  assert.deepEqual([store.data.canvases[plan.id].role, store.data.canvases[plan.id].version], ['plan', 2])
  assert.equal(await call('place_diagram', { id: a.id, role: 'plan', step: 'big.2' }), `Placed ${a.id} in the plan of big.2.`)
  assert.deepEqual([store.data.canvases[a.id].option, store.data.canvases[a.id].version], [null, 1])

  const step1 = JSON.parse(await call('get_diagrams', { step: 'big.1' }))
  assert.deepEqual(step1.map((d: { id: string; role: string; step: string; repo: string }) => [d.id, d.role, d.step, d.repo]), [[plan.id, 'plan', 'big.1', 'api']])
  assert.equal(JSON.parse(await call('get_diagrams')).length, 2)
  await assert.rejects(call('get_diagrams', { step: 'T-9' }), /T-9 is not a subtask of big/)
  assert.deepEqual(JSON.parse(await call('get_task')).diagrams.map((d: { role: string; step: string }) => [d.role, d.step]), [['plan', 'big.2'], ['plan', 'big.1']])
  await call('place_diagram', { id: a.id, role: 'none' })
  assert.equal(store.data.canvases[a.id].role, null)
  assert.equal(await call('get_diagrams', { step: 'big.2' }), 'big.2 has no diagrams of its own; get_diagrams without step lists all of big.')
})

test('a doc that links a project-chat diagram adopts it; one of another task stays there, listed, and place_diagram copies it (T-55.3)', async () => {
  const { store, project, task, call } = setup()
  const state: Diagram = { type: 'state', entity: 'Job', states: [{ id: 'a', label: 'A' }], transitions: [] }
  const chat = store.saveCanvas({ projectId: project.id, taskId: null, sessionId: null, title: 'Chat', kind: 'diagram', diagram: state })
  const other = store.createTask({ projectId: project.id, title: 'Research', type: 'research', description: '' })
  const old = store.saveCanvas({ projectId: project.id, taskId: other.id, sessionId: null, title: 'Old', kind: 'diagram', diagram: state })
  const out = await call('update_doc', { markdown: `[c](canvas:${chat.id}) [o](canvas:${old.id})` })
  assert.equal(out, `Document updated. Moved into big, as the doc links them: ${chat.id}.`)
  assert.deepEqual([store.data.canvases[chat.id].taskId, store.data.canvases[old.id].taskId], [task.id, other.id])
  assert.deepEqual(JSON.parse(await call('get_diagrams')).map((d: { id: string; of?: string }) => [d.id, d.of]), [[chat.id, undefined], [old.id, 'research']])

  await call('create_subtask', { title: 'Core' })
  const copied = await call('place_diagram', { id: old.id, role: 'plan', step: 'big.1' })
  const copy = Object.values(store.data.canvases).find((c) => c.taskId === task.id && c.title === 'Old')!
  assert.match(copied, new RegExp(`^${old.id} belongs to research: copied into big as ${copy.id} in the plan of big.1\\. Link \\[Old\\]\\(canvas:${copy.id}\\)`))
  assert.deepEqual([store.data.canvases[old.id].role, copy.role, copy.version], [undefined, 'plan', 1])
  // The project chat writes a doc through update_task_doc and adopts the same way.
  const loose = store.saveCanvas({ projectId: project.id, taskId: null, sessionId: null, title: 'Loose', kind: 'diagram', diagram: state })
  const tools = createTools(store, { groom() {}, architect() {}, cancel: async () => {}, completeStep: async () => {}, addRepo: async () => { throw new Error() }, setReview: () => '', reopen: () => '', askOwner: () => false, answerDeveloper: async () => {}, reviewPr: async () => { throw new Error() }, reviewFact: async () => '', exportReview: async () => '', setPrReview: () => '', decideDirection: () => '', ...NO_CONTROL })
  assert.match(await tools({ projectId: project.id }, 'update_task_doc', { key: 'big', markdown: `[l](canvas:${loose.id})` }), /Moved into big/)
  assert.equal(store.data.canvases[loose.id].taskId, task.id)
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
  assert.match(await call('add_repo', { repo: 'api' }, dev.id), /^api: worktree \/nowhere\/w\/api on branch mag\/big-1\./)
  assert.match(await call('add_repo', { repo: 'web' }, dev.id), /^web: the main checkout \/nowhere\/web, on branch mag\/big-1 \(the task works there locally\)/)
  await call('add_repo', { repo: 'db', worktree: true }, dev.id)
  assert.deepEqual(calls, ['add api to big.1', 'add web to big.1', 'add db to big.1 as a worktree'])
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
  // A report needs the inventory of the review's fact; its checks give the verdict (review-v2-questions-first-direction.1).
  const report = { direction: { decisions: [], options: [], facts: [], references: [] }, problem: [], conventions: [], risks: [], questions: [], changes: [], checks: { verdict: 'approve', why: 'w' } }
  await assert.rejects(call('set_review', { report }, reviewer.id), /Not recorded\. Fix the report[\s\S]*direction\.decisions: name the design decision[\s\S]*no inventory yet/)
  await assert.rejects(call('set_review', { report: { ...report, checks: { verdict: 'merge' } } }, reviewer.id), /checks\.verdict must be one of[\s\S]*checks\.why is required/)
  assert.deepEqual(calls, ['review big.1: changes a.ts:3|no test;|scope', 'review big.1: merge '])
})

test('the reviewer reads the task but changes nothing', async () => {
  const { store, project, task, call } = setup()
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'in_progress' })
  const reviewer = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'reviewer', agent: 'claude-code', status: 'running' })
  assert.match(await call('get_doc', {}, reviewer.id), /empty/)
  for (const name of ['update_doc', 'set_pr', 'set_needs_input', 'complete_step', 'create_subtask'])
    await assert.rejects(call(name, { markdown: 'x', url: 'https://github.com/o/r/pull/1', reason: 'x', title: 'x' }, reviewer.id), /not available to the reviewer/)
})

test('create_work from a topic: the topic owns the work and plans it, no groomer (T-55.5)', async () => {
  const { store, project, tools } = setup()
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  assert.match(await tools({ projectId: project.id, sessionId: topic.id }, 'create_work', { title: 'Owned', description: 'd' }), /you own it and plan it here: pass work: "owned"/)
  await tools({ projectId: project.id }, 'create_work', { title: 'Orphan', type: 'dev', description: 'd' })
  const owned = store.data.tasks.find((t) => t.title === 'Owned')!
  assert.deepEqual([owned.ownerSessionId, owned.status], [topic.id, 'planning'])
  const orphan = store.data.tasks.find((t) => t.title === 'Orphan')!
  assert.deepEqual([orphan.ownerSessionId, orphan.status], [undefined, 'planning'])
})

test('create_work in an idea\'s topic: the topic owns the work and the idea leaves the list; others stay', async () => {
  const { store, project, tools } = setup()
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  const other = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  const idea = store.addIdea(project.id, 'dark mode')
  const kept = store.addIdea(project.id, 'cache rates')
  store.updateIdea(idea.id, { topicId: topic.id })
  store.updateIdea(kept.id, { topicId: other.id })
  await tools({ projectId: project.id, sessionId: topic.id }, 'create_work', { title: 'Dark mode', description: 'd' })
  assert.equal(store.data.tasks.find((t) => t.title === 'Dark mode')!.ownerSessionId, topic.id)
  assert.deepEqual(store.data.ideas.map((i) => i.text), ['cache rates'])
})

test('owner tools in a project chat: the topic plans the works it owns, passing work (T-55.5)', async () => {
  const { store, project, tools } = setup()
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  const other = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  const chat = (name: string, args: Record<string, unknown>, sessionId = topic.id) => tools({ projectId: project.id, sessionId }, name, args)
  await chat('create_work', { title: 'Owned', description: 'd' })
  // No user message in the topic yet: the groomer's checkpoint is not the owner's.
  assert.equal(await chat('create_subtask', { work: 'OWNED', title: 'One', repos: [] }), 'Created owned.1.')
  await chat('create_subtask', { work: 'owned', title: 'Two' })
  assert.equal(await chat('reorder_subtasks', { work: 'owned', keys: ['owned.2', 'owned.1'] }), 'Order: owned.2, owned.1.')
  await chat('update_subtask', { work: 'owned', key: 'owned.1', note: 'the core' })
  await chat('delete_subtask', { work: 'owned', key: 'owned.2' })
  const owned = store.data.tasks.find((t) => t.key === 'owned')!
  assert.deepEqual(store.data.tasks.filter((t) => t.parentId === owned.id).map((t) => [t.key, t.description]), [['owned.1', 'the core']])

  const diagram = { type: 'state', entity: 'Work', states: [{ id: 'a', label: 'A', initial: true, diff: 'add' }], transitions: [] }
  const shown = await chat('show_diagram', { work: 'owned', title: 'States', diagram, role: 'plan', step: 'owned.1' })
  assert.match(shown, /in the plan of owned.1/)
  const id = /Diagram (\S+) /.exec(shown)![1]
  assert.equal(store.data.canvases[id].taskId, owned.id, 'the drawing belongs to the work')
  assert.ok(topic.items.some((i) => i.kind === 'canvas' && i.canvas.id === id), 'and shows in the topic')
  assert.match(await chat('get_diagrams', { work: 'owned', step: 'owned.1' }), /"States"/)
  assert.match(await chat('place_diagram', { work: 'owned', id, role: 'none' }), /unplaced/)
  const free = await chat('show_diagram', { title: 'Sketch', diagram })
  assert.equal(store.data.canvases[/Diagram (\S+) /.exec(free)![1]].taskId, null, 'without work: the project\'s')
  assert.match(await chat('update_doc', { work: 'owned', markdown: `# Plan\n[s](canvas:${id})` }), /Document updated/)
  assert.equal(store.data.docs[owned.id], `# Plan\n[s](canvas:${id})`)
  await chat('set_needs_input', { work: 'owned', reason: 'Plan ready for review' })
  assert.equal(store.task(owned.id).needsInput, 'Plan ready for review')
  assert.match(await chat('answer_developer', { work: 'owned', step: 'owned.1', text: 'yes' }), /Sent to the developer of owned.1/)
  await assert.rejects(chat('answer_developer', { work: 'owned', step: 'owned.1', text: 'yes' }, other.id), /owned is not planned in this topic/)

  await assert.rejects(chat('create_subtask', { title: 'x' }), /needs work/)
  await assert.rejects(chat('create_subtask', { work: 'T-9', title: 'x' }), /No work T-9/)
  await assert.rejects(chat('create_subtask', { work: 'owned', title: 'x' }, other.id), /owned is not planned in this topic/)
  await assert.rejects(chat('create_subtask', { work: 'big', title: 'x' }), /big is not planned in this topic/)
  await assert.rejects(tools({ projectId: project.id }, 'create_subtask', { work: 'owned', title: 'x' }), /needs a task/, 'only a chat')
})

test('toolsFor: a project chat lists the owner tools with work; task runs list them as they are (T-55.5)', () => {
  const chat = toolsFor('project', 'chat')
  const names = chat.map((t) => t.name)
  for (const n of ['create_work', 'add_ticket', 'create_subtask', 'place_diagram', 'get_diagrams', 'show_diagram']) assert.ok(names.includes(n), n)
  for (const n of ['get_import', 'set_brief', 'link_ticket', 'create_task', 'set_pr', 'complete_step']) assert.ok(!names.includes(n), n)
  const sub = chat.find((t) => t.name === 'create_subtask')!.inputSchema as { properties: Record<string, unknown>; required: string[] }
  assert.deepEqual(sub.required, ['work', 'title'])
  const show = chat.find((t) => t.name === 'show_diagram')!.inputSchema as { properties: Record<string, unknown>; required: string[] }
  assert.ok(show.properties.work && !show.required.includes('work'))
  assert.ok(!toolsFor('project', 'architect').some((t) => t.name === 'create_subtask'))
  const groomer = toolsFor('task', 'groomer').find((t) => t.name === 'create_subtask')!.inputSchema as { properties: Record<string, unknown> }
  assert.equal(groomer.properties.work, undefined)
})

test('add_idea: any agent puts a finding on the project ideas, with where it came from (T-55.6)', async () => {
  const { store, project, task, tools, call } = setup()
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'in_progress' })
  const dev = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'developer', agent: 'claude-code', status: 'running' })
  const reviewer = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'reviewer', agent: 'claude-code', status: 'running' })
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  assert.match(await call('add_idea', { text: ' retry logic is duplicated in web ' }, dev.id), /Added to the project's ideas/)
  await call('add_idea', { text: 'cache rates' })
  await call('add_idea', { text: 'flaky test' }, reviewer.id)
  await tools({ projectId: project.id, sessionId: topic.id }, 'add_idea', { text: 'dark mode' })
  await assert.rejects(call('add_idea', { text: ' ' }), /An idea needs a text/)
  assert.deepEqual(store.data.ideas.map((i) => [i.text, i.source]), [['retry logic is duplicated in web', 'big.1'], ['cache rates', 'big'], ['flaky test', 'big.1'], ['dark mode', undefined]])
  const listed = JSON.parse(await tools({ projectId: project.id, sessionId: topic.id }, 'list_tasks', {}))
  assert.deepEqual(listed.ideas[0], { text: 'dark mode' }, 'newest first')
  assert.ok(toolsFor('task', 'reviewer').some((t) => t.name === 'add_idea'))
})

test('reopen_work: a project chat continues a done work it then owns (T-55.6)', async () => {
  const { store, project, task, call } = setup()
  const reopened: string[] = []
  const tools = createTools(store, { groom() {}, architect() {}, cancel: async () => {}, completeStep: async () => {}, addRepo: async () => { throw new Error() }, setReview: () => '', reopen: (id, what, by) => (reopened.push(`${store.task(id).key}: ${what} by ${by}`), 'Back.'), askOwner: () => false, answerDeveloper: async () => {}, reviewPr: async () => { throw new Error() }, reviewFact: async () => '', exportReview: async () => '', setPrReview: () => '', decideDirection: () => '', ...NO_CONTROL })
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  assert.match(await tools({ projectId: project.id, sessionId: topic.id }, 'reopen_work', { key: 'big', what: 'web' }), /^Back\. Plan what is left right here: .*work: "big"/)
  assert.deepEqual(reopened, [`big: web by ${topic.id}`])
  const idea = store.addIdea(project.id, 'web too')
  store.updateIdea(idea.id, { topicId: topic.id })
  await tools({ projectId: project.id, sessionId: topic.id }, 'reopen_work', { key: 'big', what: 'web' })
  assert.deepEqual(store.data.ideas, [], 'the idea it discussed became the reopened work')
  await assert.rejects(tools({ projectId: project.id }, 'reopen_work', { key: 'big', what: 'web' }), /reopen_work is for a project chat/)
  await assert.rejects(call('reopen_work', { key: 'big', what: 'web' }), /reopen_work is for a project chat|needs a task|Unknown/)
  assert.ok(!toolsFor('task', 'groomer').some((t) => t.name === 'reopen_work'))
  assert.equal(store.task(task.id).status, 'planning')
})

test("a review of a teammate's PR: its v1 topic reads the fact, without an intent, and records findings by level", async () => {
  const { store, project, task, tools, calls } = setup()
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  const other = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const review = store.createTask({ projectId: project.id, title: 'api#418: Retry', type: 'review', description: '', status: 'in_progress', ownerSessionId: topic.id })
  const pr = { url: 'https://github.com/acme/api/pull/418', repo: '/r/api', number: 418, author: 'olena', base: 'main', head: 'abc' }
  store.updateTask(review.id, { prReview: { pr, results: { v1: emptyResult('v1', topic.id) }, shown: 'v1', posted: null } })
  const as = (sid: string) => (name: string, args: Record<string, unknown> = {}) => tools({ projectId: project.id, sessionId: sid }, name, { work: review.key, ...args })
  const own = as(topic.id)

  assert.equal(await own('review_pr', { url: 'https://github.com/acme/api/pull/418' }), 'Review it.')
  assert.equal(await own('review_pr', { url: 'https://github.com/acme/api/pull/418', format: 'v1' }), 'Review it.')
  await assert.rejects(own('review_pr', { url: 'https://github.com/acme/api/pull/418', format: 'v3' }), /format must be one of v1, v2/)
  assert.deepEqual(calls.splice(0), [`review_pr https://github.com/acme/api/pull/418 by ${topic.id}`, `review_pr https://github.com/acme/api/pull/418 by ${topic.id} v1`])

  // export_review (review-v2-part-2-v1-2.3): a review by its key, to Downloads or a path; not a work of another type.
  assert.match(await own('export_review', { key: review.key }), /Exported .* to \/Downloads\/api-418-review\.zip/)
  assert.match(await own('export_review', { key: review.key, path: '/tmp' }), /to \/tmp\/api-418-review\.zip/)
  await assert.rejects(own('export_review', { key: task.key }), /not a review of a PR/)
  assert.deepEqual(calls.splice(0), [`export ${review.key}`, `export ${review.key} to /tmp`])

  // No intent any more (reviews-prybraty-spysok-pr-i.1): the review draws only its fact, which mag starts.
  const diagram: Diagram = { type: 'component', summary: 'Retries are idempotent.', modules: [{ id: 'charge', name: 'charge', description: '', diff: 'mod', uses: [] }] }
  await assert.rejects(own('show_diagram', { title: 'Intent', diagram, role: 'intent' }), /role must be one of option, plan, none/)
  await assert.rejects(own('place_diagram', { id: 'x', role: 'intent' }), /role must be one of option, plan, none/)
  const fact = store.saveCanvas({ projectId: project.id, taskId: review.id, sessionId: null, title: 'Fact', kind: 'diagram', diagram, placement: { role: 'fact', option: null, stepId: null, repo: null, planOf: null } })

  assert.equal(await own('get_pr_changes'), 'Fact')
  await own('set_pr_review', {
    problem: 'Timeouts double-charge',
    approach: 'Idempotency key: right',
    verdict: 'request_changes',
    findings: [{ text: 'Key from the body', where: 'api/charge.go:88', level: 'blocker', node: `canvas:${fact.id}#charge` }, { text: 'Name', level: 'nit' }],
  })
  assert.deepEqual(calls, [`fact of ${review.key}`, `pr review ${review.key}: request_changes blocker|api/charge.go:88|canvas:${fact.id}#charge|Key from the body;nit|||Name`])

  await assert.rejects(own('set_pr_review', { problem: '', approach: '', verdict: 'approve', findings: [{ text: 'x', level: 'blocker' }] }), /blocker and approve/)
  await assert.rejects(own('set_pr_review', { problem: '', approach: '', verdict: 'comment', findings: [{ text: 'x' }] }), /needs its level/)
  await assert.rejects(own('set_pr_review', { problem: '', approach: '', verdict: 'merge', findings: [] }), /verdict must be one of approve/)
  // A v1 topic records no report.
  await assert.rejects(own('set_pr_review', { problem: '', approach: '', report: {} }), /this is the v1 review of the PR/)
  // Only a topic that runs it reviews it; set_pr_review is for reviews only.
  await assert.rejects(as(other.id)('set_pr_review', { problem: '', approach: '', verdict: 'comment', findings: [] }), /not planned in this topic/)
  // The v2 run's own topic may too (review-v2-part-2-v1-2.1).
  const v2 = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  store.updateTask(review.id, { prReview: { ...store.task(review.id).prReview!, results: { ...store.task(review.id).prReview!.results, v2: emptyResult('v2', v2.id) } } })
  await assert.rejects(as(v2.id)('set_pr_review', { problem: '', approach: '', verdict: 'comment', findings: [] }), /this is the v2 review of the PR: record it with report/)
  await assert.rejects(tools({ taskId: task.id }, 'set_pr_review', { problem: '', approach: '', verdict: 'comment', findings: [] }), /not a review/)
})

test('set_review takes findings with levels, and refuses an unknown one', async () => {
  const { store, project, task, tools, calls } = setup()
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'a', type: 'dev', description: '', status: 'in_progress' })
  const reviewer = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'reviewer', agent: 'claude-code', status: 'running' })
  await tools({ taskId: task.id, sessionId: reviewer.id }, 'set_review', { verdict: 'look', findings: [{ text: 'x', where: 'a.ts:1', level: 'question' }] })
  assert.deepEqual(calls, ['review big.1: look a.ts:1|x'])
  await assert.rejects(tools({ taskId: task.id, sessionId: reviewer.id }, 'set_review', { verdict: 'look', findings: [{ text: 'x', level: 'urgent' }] }), /level must be one of/)
})

test("a project chat gets the buttons' tools, each only on the user's word (chat-keruie-robotamy-i-ahentamy.1)", () => {
  const names = ['approve_plan', 'start_work', 'start_step', 'restart_review', 'message_agent', 'stop_agent']
  const chat = toolsFor('project', 'chat').filter((t) => names.includes(t.name))
  assert.deepEqual(chat.map((t) => t.name), names)
  for (const t of chat) assert.match(t.description, /Only when the user has asked for exactly this in this conversation/)
  assert.ok(!toolsFor('task', 'developer').some((t) => names.includes(t.name)))
})

test('a project chat gets list_chats, close_chats, delete_chats and restore_chat; delete only on the user\'s yes; task runs do not (chat-archives-and-deletes-topics.1)', () => {
  const names = ['list_chats', 'close_chats', 'delete_chats', 'restore_chat']
  const chat = toolsFor('project', 'chat').filter((t) => names.includes(t.name))
  assert.deepEqual(chat.map((t) => t.name), names)
  const by = (n: string) => chat.find((t) => t.name === n)!.description
  for (const n of ['close_chats', 'restore_chat']) assert.match(by(n), /Only when the user has asked for exactly this in this conversation/)
  assert.match(by('delete_chats'), /Only for targets the user said yes to deleting in this conversation/)
  for (const role of ['developer', 'groomer', 'reviewer']) assert.ok(!toolsFor('task', role).some((t) => names.includes(t.name)), role)
})

test('request_integration: one card per integration while it is off; an integration that is on or unknown says so (redesign-start-screen-big-composer.4)', async () => {
  const { store, project, call, groomer } = setup()
  store.saveIntegrations([{ id: 'claude_ai_Slack', name: 'claude.ai Slack' }, { id: 'claude_ai_Gmail', name: 'claude.ai Gmail' }])
  store.updateProject(project.id, { integrations: { groomer: { claude_ai_Gmail: 'ask' } } })
  assert.match(await call('request_integration', { id: 'claude_ai_Slack', why: 'read the  thread' }), /End your turn now, saying claude\.ai Slack is turned off in mag for the groomer role/)
  await call('request_integration', { id: 'claude_ai_Slack', why: 'again' })
  const cards = store.session(groomer.id).items.filter((i) => i.kind === 'integration')
  assert.deepEqual(cards.map((c) => c.kind === 'integration' && [c.integrationId, c.server, c.role, c.why, c.status]), [['claude_ai_Slack', 'claude.ai Slack', 'groomer', 'read the thread', 'off']])
  assert.match(await call('request_integration', { id: 'claude_ai_Gmail', why: 'x' }), /already on \(ask\)/)
  await assert.rejects(call('request_integration', { id: 'mag', why: 'x' }), /No integration mag/)
  assert.ok(toolsFor('task', 'reviewer').some((t) => t.name === 'request_integration'))
  assert.ok(toolsFor('project', 'chat').some((t) => t.name === 'request_integration'))
})

test('read_chat: a topic by id, a work by key with its doc and owner topic, paged; every role has it', async () => {
  const { store, project, task, tools, call } = setup()
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Login' })
  topic.items.push({ kind: 'user', text: 'Why does login fail?', at: 10 }, { kind: 'tool', id: 'x', name: 'Bash', summary: 'ls', at: 11 }, { kind: 'assistant', text: 'x'.repeat(50_000), at: 12 })
  topic.closedAt = 20
  store.updateTask(task.id, { ownerSessionId: topic.id })
  store.data.docs[task.id] = '# Plan\nRotate tokens'
  const first = await tools({ projectId: project.id, sessionId: topic.id }, 'read_chat', { id: topic.id })
  assert.match(first, /^Topic: .* \(archived\)\n\n\[.*\] User: Why does login fail\?\n\n\[.*\] tool Bash ls\n\n\[.*\] Assistant: x+/)
  const next = /call read_chat with offset (\d+)/.exec(first)?.[1]
  assert.equal(next, '40000')
  const second = await tools({ projectId: project.id, sessionId: topic.id }, 'read_chat', { id: topic.id, offset: Number(next) })
  assert.match(second, /x+\n\n\(end of the chat\)$/)
  const work = await call('read_chat', { id: task.key.toUpperCase() })
  assert.match(work, /^Work .*: Big \(planning\)\n\nDocument:\n# Plan\nRotate tokens\n\nConversation:\n\[.*\] User: Why does login fail\?/)
  await assert.rejects(call('read_chat', { id: 'nope' }), /No chat nope/)
  for (const role of ['chat', 'groomer', 'developer', 'reviewer', 'architect']) assert.ok(toolsFor(role === 'chat' || role === 'architect' ? 'project' : 'task', role).some((t) => t.name === 'read_chat'), role)
})
