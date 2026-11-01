import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@mag/core'
import { adapters, type AgentAdapter, type LiveHandle, type RunSpec } from '@mag/agents'
import { Store } from './store.ts'
import { Orchestrator } from './orchestrator.ts'

/** A Claude Code live process driven by the test: it records what mag does and emits what the CLI would. */
class FakeLive implements LiveHandle {
  sent: string[] = []
  closed = false
  stoppedTasks: string[] = []
  emit: (e: AgentEvent) => void = () => {}
  private exit!: () => void
  done = new Promise<void>((r) => (this.exit = r))
  onClose = () => {}
  send(text: string) {
    this.sent.push(text)
  }
  async interrupt() {
    this.emit({ type: 'stopped' })
    this.emit({ type: 'turn.done', ok: true })
  }
  async stopTask(id: string) {
    this.stoppedTasks.push(id)
    this.emit({ type: 'background', tasks: [] })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.onClose()
    this.exited()
  }
  /** The process exits on its own (or after our close). */
  exited() {
    this.exit()
  }
}

const opened: FakeLive[] = []
const specs: Omit<RunSpec, 'prompt'>[] = []
/** One-off runs (reviewers, chat titles): the test emits their events and ends them. */
const runs: { spec: RunSpec; emit: (e: AgentEvent) => void; end: () => void }[] = []
const real = adapters['claude-code']
const recordRun: AgentAdapter['start'] = (spec, onEvent) => {
  let end!: () => void
  const done = new Promise<void>((r) => (end = r))
  runs.push({ spec, emit: onEvent, end })
  return { kill: end, done }
}
const fake: AgentAdapter = {
  ...real,
  start: recordRun,
  open: (spec, onEvent) => {
    specs.push(spec)
    const live = new FakeLive()
    live.emit = onEvent
    opened.push(live)
    return live
  },
}
adapters['claude-code'] = fake

const tick = () => new Promise((r) => setTimeout(r, 0))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-orch-'))
  const store = new Store(join(dir, 'db.json'))
  const orch = new Orchestrator(store, { url: 'http://127.0.0.1:1', token: 't' }, {
    mcpScript: join(dir, 'task-mcp.js'),
    runsDir: join(dir, 'runs'),
    worktreesDir: join(dir, 'worktrees'),
    attachmentsDir: join(dir, 'attachments'),
    logsDir: join(dir, 'logs'),
  })
  const project = store.createProject('p')
  store.updateProject(project.id, { repos: [dir], enforceArchitecture: false })
  const task = store.createTask({ projectId: project.id, title: 't', type: 'dev', description: '' })
  return { dir, store, orch, project, task }
}

/** A task in progress on one step whose developer session is live and between turns. */
async function developing() {
  const s = setup()
  s.store.updateTask(s.task.id, { status: 'in_progress' })
  const step = s.store.createTask({ projectId: s.project.id, title: 's', type: 'dev', description: '', parentId: s.task.id, status: 'in_progress' })
  const workDir = join(s.dir, 'worktrees', step.key)
  mkdirSync(workDir, { recursive: true })
  s.store.updateTask(step.id, { work: { dir: workDir, repos: [], feedbackSeenAt: 0 } })
  const session = s.store.createSession({ projectId: s.project.id, taskId: s.task.id, stepId: step.id, role: 'developer', agent: 'claude-code', status: 'idle' })
  await s.orch.send(session.id, 'go on')
  const live = opened.at(-1)!
  return { ...s, step, workDir, session, live }
}

test('groomer: the turn ends at its result; background tasks hold the "stopped without finishing" check back', async () => {
  const { store, orch, task } = setup()
  orch.groom(task.id)
  await tick()
  const live = opened.at(-1)!
  const session = store.data.sessions.find((s) => s.taskId === task.id)!
  assert.deepEqual(live.sent, [`Groom task ${task.key}. Start with get_task.`])
  assert.equal(session.live, true)
  assert.equal(orch.isRunning(session.id), true)

  live.emit({ type: 'background', tasks: [{ id: 'b1', name: 'Monitor' }] })
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(session.status, 'idle')
  assert.equal(orch.isRunning(session.id), false)
  assert.equal(store.task(task.id).needsInput, null)

  // The task fires: the agent wakes in the same process, and this time nothing is left to wait for.
  live.emit({ type: 'background', tasks: [] })
  live.emit({ type: 'turn.started' })
  assert.equal(session.status, 'running')
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, 'Groomer stopped without finishing; check the chat')
  assert.equal(opened.at(-1), live)
})

test('stopping the last background task of an idle groomer runs the end-of-run checks', async () => {
  const { store, orch, task } = setup()
  orch.groom(task.id)
  await tick()
  const live = opened.at(-1)!
  const session = store.data.sessions.find((s) => s.taskId === task.id)!
  live.emit({ type: 'background', tasks: [{ id: 'b1', name: 'Monitor' }] })
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, null)
  await orch.stopBackground(session.id, 'b1')
  await tick()
  assert.deepEqual(live.stoppedTasks, ['b1'])
  assert.equal(store.task(task.id).needsInput, 'Groomer stopped without finishing; check the chat')
})

test('a process that exits with background tasks while idle ends the run', async () => {
  const { store, orch, task } = setup()
  orch.groom(task.id)
  await tick()
  const live = opened.at(-1)!
  const session = store.data.sessions.find((s) => s.taskId === task.id)!
  live.emit({ type: 'background', tasks: [{ id: 'b1', name: 'Monitor' }] })
  live.emit({ type: 'turn.done', ok: true })
  live.exited()
  await tick()
  assert.equal(session.live, false)
  assert.equal(session.background, undefined)
  assert.ok(session.items.some((i) => i.kind === 'notice' && i.text === 'Background tasks ended with the process'))
  assert.equal(store.task(task.id).needsInput, 'Groomer stopped without finishing; check the chat')
})

test('developer: PR feedback goes into the live process between turns, not during one', async () => {
  const { store, orch, step, session, live } = await developing()
  const comment = [{ author: 'u', body: 'rename it', at: 1, repo: 'mag' }]
  assert.equal(orch.feedback(step.id, comment), false) // the turn of "go on" is still on
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(orch.feedback(step.id, comment), true)
  await tick()
  assert.equal(opened.at(-1), live)
  assert.match(live.sent.at(-1)!, /New feedback on your PR:\n- @u: rename it/)
  assert.equal(session.status, 'running')
  assert.equal(store.task(step.parentId!).status, 'in_progress')
})

test('developer: a message during a turn joins it', async () => {
  const { orch, session, live } = await developing()
  await orch.send(session.id, 'also this')
  assert.deepEqual(live.sent, ['go on', 'also this'])
  assert.equal(opened.at(-1), live)
})

test('completeStep closes the idle developer process before its worktrees go', async () => {
  const { orch, step, workDir, live } = await developing()
  live.emit({ type: 'background', tasks: [{ id: 'b1', name: 'Monitor' }] })
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  let dirAtClose: boolean | null = null
  live.onClose = () => (dirAtClose = existsSync(workDir))
  await orch.completeStep(step.id)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(live.closed, true)
  assert.equal(dirAtClose, true)
  assert.equal(existsSync(workDir), false)
})

test('complete_step during a turn: the process closes and the worktrees go at the turn end', async () => {
  const { orch, step, workDir, live } = await developing()
  await orch.completeStep(step.id)
  assert.equal(live.closed, false)
  assert.equal(existsSync(workDir), true)
  live.emit({ type: 'turn.done', ok: true })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(live.closed, true)
  assert.equal(existsSync(workDir), false)
})

test('cancel closes the live process before removing worktrees, without end-of-run checks', async () => {
  const { store, orch, task, workDir, live } = await developing()
  let dirAtClose: boolean | null = null
  live.onClose = () => (dirAtClose = existsSync(workDir))
  await orch.cancel(task.id, null)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(live.closed, true)
  assert.equal(dirAtClose, true)
  assert.equal(existsSync(workDir), false)
  assert.equal(store.task(task.id).status, 'canceled')
  assert.equal(store.task(task.id).needsInput, null)
})

test('tracker: Bash and every detected integration whatever the modes, no file edits (T-37)', async () => {
  const { store, orch, project, task } = setup()
  store.saveIntegrations([{ id: 'claude_ai_Atlassian', name: 'Atlassian' }, { id: 'linear', name: 'Linear' }])
  store.updateProject(project.id, { integrations: { tracker: { linear: 'off' } } })
  store.updateTask(task.id, { tracker: { kind: 'jira', key: 'ABC-1', url: 'https://acme.atlassian.net/browse/ABC-1', importedAt: null } })
  let spec: RunSpec | undefined
  fake.start = (s) => {
    spec = s
    return { kill() {}, done: new Promise<void>(() => {}) }
  }
  try {
    orch.importTicket(task.id)
    await tick()
  } finally {
    fake.start = recordRun
  }
  assert.deepEqual(spec?.allowedTools, ['mcp__mag', 'Bash', 'mcp__claude_ai_Atlassian', 'mcp__linear'])
  assert.deepEqual(spec?.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
  assert.equal(spec?.permissionPromptTool, undefined)
  assert.match(spec?.appendSystemPrompt ?? '', /any way you have/)
  assert.match(spec?.prompt ?? '', /Import ABC-1/)
})

test('project chat: Bash allowed, integrations by the chat modes (T-37)', async () => {
  const { store, orch, project } = setup()
  store.saveIntegrations([{ id: 'claude_ai_Atlassian', name: 'Atlassian' }])
  store.updateProject(project.id, { integrations: { chat: { claude_ai_Atlassian: 'auto' } } })
  const chat = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  await orch.send(chat.id, 'create a task from https://acme.atlassian.net/browse/ABC-1')
  const spec = specs.at(-1)!
  assert.ok(spec.allowedTools?.includes('Bash'))
  assert.ok(spec.allowedTools?.includes('mcp__claude_ai_Atlassian'))
  assert.ok(!spec.disallowedTools?.includes('Bash'))
  assert.ok(spec.disallowedTools?.includes('Edit'))
  assert.match(spec.appendSystemPrompt ?? '', /ticket_url/)
})

test('groomer prompt: diagrams sketched per option before the checkpoint, plan per step and repo (T-54)', async () => {
  const { orch, task } = setup()
  orch.groom(task.id)
  await tick()
  const prompt = specs.at(-1)!.appendSystemPrompt!
  assert.match(prompt, /Sketch every option that changes code with show_diagram/)
  assert.match(prompt, /do not create steps before the user confirms/)
  assert.doesNotMatch(prompt, /do not draw diagrams/)
  assert.match(prompt, /revise its sketches by their ids \(never redraw copies\)/)
  assert.match(prompt, /for every repository in\n   a step's repos, what changes there and links to the diagrams/)
})

test('renameChat: project topics only, a non-empty title, kept over the first message and the generated title', async () => {
  const { store, orch, project, task } = setup()
  const groomer = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  assert.throws(() => orch.renameChat(groomer.id, 'x'), /not a project topic/)
  const id = orch.newChat(project.id)
  assert.equal(store.session(id).title, 'New topic')
  assert.throws(() => orch.renameChat(id, '  \n '), /needs a title/)
  orch.renameChat(id, '  Pricing   ideas ')
  assert.equal(store.session(id).title, 'Pricing ideas')

  let titleRuns = 0
  fake.start = () => {
    titleRuns++
    return { kill() {}, done: new Promise<void>(() => {}) }
  }
  try {
    await orch.send(id, 'what should we charge?')
    const live = opened.at(-1)!
    live.emit({ type: 'message', text: 'Let us see.' })
    live.emit({ type: 'turn.done', ok: true })
    await tick()
  } finally {
    fake.start = recordRun
  }
  assert.equal(titleRuns, 0)
  assert.equal(store.session(id).title, 'Pricing ideas')
})

test('deleteChat: project topics only; closes the live process, then removes the topic', async () => {
  const { store, orch, project, task } = setup()
  const groomer = store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  await assert.rejects(orch.deleteChat(groomer.id), /not a project topic/)
  const id = orch.newChat(project.id)
  await orch.send(id, 'hi')
  const live = opened.at(-1)!
  live.emit({ type: 'background', tasks: [{ id: 'b1', name: 'Monitor' }] })
  let existedAtClose: boolean | null = null
  live.onClose = () => (existedAtClose = store.data.sessions.some((s) => s.id === id))
  await orch.deleteChat(id)
  assert.equal(live.closed, true)
  assert.equal(existedAtClose, true)
  assert.equal(store.data.sessions.some((s) => s.id === id), false)
  assert.equal(store.data.sessions.some((s) => s.id === groomer.id), true)
})

/** A git repository with one commit on main, no remote. */
function gitRepo(path: string) {
  mkdirSync(path, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return path
}

test('develop: worktrees only for the step\'s repos; add_repo adds one mid-step (T-50)', async () => {
  const { dir, store, orch, project, task } = setup()
  const app = gitRepo(join(dir, 'repos', 'app'))
  const api = gitRepo(join(dir, 'repos', 'api'))
  store.updateProject(project.id, { repos: [app, api] })
  store.updateTask(task.id, { status: 'todo' })
  const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [api] })
  await orch.develop(task.id)
  const work = store.task(step.id).work!
  assert.deepEqual(work.repos.map((r) => [r.repo, r.branch]), [[api, 'mag/t-1-1']])
  assert.ok(existsSync(work.repos[0].worktree))
  const spec = specs.at(-1)!
  assert.ok(spec.addDirs?.includes(app), 'the other repo stays readable in its main checkout')
  assert.match(spec.appendSystemPrompt!, new RegExp(`never change them there: ${app}\\. To change one, call add_repo`))

  await assert.rejects(orch.addRepo(step.id, 'web'), /web is not a repository of the project; one of app, api/)
  const added = await orch.addRepo(step.id, 'app')
  assert.equal(added.worktree, join(work.dir, 'app'))
  assert.ok(existsSync(added.worktree))
  const now = store.task(step.id)
  assert.deepEqual(now.work!.repos.map((r) => r.repo), [api, app])
  assert.deepEqual(now.repos, [api, app], 'the step records the repo it changes now')
  assert.deepEqual(await orch.addRepo(step.id, app), added, 'a repo the step has already')
  assert.equal(store.task(step.id).work!.repos.length, 2)
})

test('develop: a step without repos gets its dir and no worktree', async () => {
  const { store, orch, project, task, dir } = setup()
  store.updateTask(task.id, { status: 'todo' })
  const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  await orch.develop(task.id)
  const work = store.task(step.id).work!
  assert.deepEqual(work.repos, [])
  assert.ok(existsSync(work.dir))
  assert.match(specs.at(-1)!.appendSystemPrompt!, /The plan gives this step no repository to change\.\nRead the other project repositories/)
  await assert.rejects(orch.addRepo(step.id, dir), /is not a git repository/)
  assert.deepEqual(store.task(step.id).work!.repos, [], 'a failed worktree records nothing')
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

/** A task with one step in `repos`, working on `local` in the main checkout; started through the Start popup. */
function localSetup() {
  const s = setup()
  const app = gitRepo(join(s.dir, 'repos', 'app'))
  const api = gitRepo(join(s.dir, 'repos', 'api'))
  s.store.updateProject(s.project.id, { repos: [app, api] })
  s.store.updateTask(s.task.id, { status: 'todo' })
  const step = s.store.createTask({ projectId: s.project.id, title: 's', type: 'dev', description: '', parentId: s.task.id, status: 'todo', repos: [app, api] })
  const sessions = () => s.store.data.sessions.filter((x) => x.stepId === step.id)
  return { ...s, app, api, step, sessions }
}

test('develop: a local repository works in the main checkout on the step branch (T-50)', async () => {
  const { store, orch, task, step, app, api, sessions } = localSetup()
  await orch.develop(task.id, undefined, [app])
  assert.deepEqual(store.task(task.id).localRepos, [app])
  const work = store.task(step.id).work!
  assert.deepEqual(work.repos.map((r) => [r.repo, r.worktree, !!r.local]), [[app, app, true], [api, join(work.dir, 'api'), false]])
  assert.equal(git(app, 'branch', '--show-current'), 'mag/t-1-1')
  assert.equal(sessions().length, 1)
  const spec = specs.at(-1)!
  assert.ok(spec.addDirs?.includes(app), 'the agent may change the main checkout')
  assert.match(spec.appendSystemPrompt!, /- app: .*app \(local: the user's main checkout, not a worktree; branch mag\/t-1-1\)/)

  // The step is done: the checkout stays on its branch, the worktree goes.
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  await orch.completeStep(step.id)
  assert.equal(git(app, 'branch', '--show-current'), 'mag/t-1-1')
  assert.equal(existsSync(work.repos[1].worktree), false)
})

test('develop: uncommitted changes ask the user; Ignore keeps them off-limits (T-50)', async () => {
  const { store, orch, task, step, app, sessions } = localSetup()
  mkdirSync(join(app, 'src'))
  execFileSync('touch', [join(app, 'src', 'mine.ts')])
  await orch.develop(task.id, undefined, [app])
  assert.equal(sessions().length, 0, 'no session before the user decides')
  assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: null, dirty: ['src/mine.ts'], branch: null }])
  assert.equal(store.task(task.id).needsInput, 'app: needs your choice')
  assert.equal(git(app, 'branch', '--show-current'), 'main', 'nothing touched')
  await assert.rejects(orch.resolveLocal(step.id, app, 'switch'), /switch is not an answer to app has uncommitted changes/)

  await orch.resolveLocal(step.id, app, 'ignore')
  assert.equal(git(app, 'branch', '--show-current'), 'mag/t-1-1')
  assert.ok(existsSync(join(app, 'src', 'mine.ts')))
  assert.deepEqual(store.task(step.id).localChecks, [])
  assert.equal(store.task(task.id).needsInput, null)
  assert.deepEqual(store.task(step.id).work!.repos[0].foreignFiles, ['src/mine.ts'])
  assert.equal(sessions().length, 1)
  assert.match(specs.at(-1)!.appendSystemPrompt!, /In app these files had the user's uncommitted changes before the step: never stage, commit or revert them: src\/mine\.ts\./)
})

test('resolveLocal: Stash, Switch, Use worktree and Discuss (T-50)', async () => {
  {
    const { store, orch, task, step, app } = localSetup()
    execFileSync('touch', [join(app, 'mine')])
    await orch.develop(task.id, undefined, [app])
    await orch.resolveLocal(step.id, app, 'stash')
    assert.equal(git(app, 'status', '--porcelain'), '')
    assert.match(git(app, 'stash', 'list'), /mag: before T-1\.1/)
    assert.equal(git(app, 'branch', '--show-current'), 'mag/t-1-1')
  }
  {
    const { store, orch, task, step, app, sessions } = localSetup()
    git(app, 'checkout', '-q', '-b', 'feature')
    await orch.develop(task.id, undefined, [app])
    assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: null, dirty: [], branch: 'feature' }])
    await orch.resolveLocal(step.id, app, 'switch')
    assert.equal(git(app, 'branch', '--show-current'), 'mag/t-1-1')
    assert.ok(git(app, 'branch', '--list', 'feature'), 'the user\'s branch stays')
    assert.equal(sessions().length, 1)
  }
  {
    const { store, orch, task, step, app } = localSetup()
    git(app, 'checkout', '-q', '-b', 'feature')
    await orch.develop(task.id, undefined, [app])
    await orch.resolveLocal(step.id, app, 'worktree')
    assert.deepEqual(store.task(task.id).localRepos, [])
    const r = store.task(step.id).work!.repos.find((w) => w.repo === app)!
    assert.equal(r.local, undefined)
    assert.ok(existsSync(r.worktree) && r.worktree !== app)
    assert.equal(git(app, 'branch', '--show-current'), 'feature', 'the main checkout is not touched')
  }
  {
    const { store, orch, task, step, app, sessions } = localSetup()
    git(app, 'checkout', '-q', '-b', 'feature')
    await orch.develop(task.id, undefined, [app])
    await orch.resolveLocal(step.id, app, 'discuss')
    assert.equal(git(app, 'branch', '--show-current'), 'feature')
    assert.equal(store.task(task.id).needsInput, null)
    const first = sessions()[0].items.find((i) => i.kind === 'user')
    assert.match(first?.kind === 'user' ? first.text : '', /In .*app: app is on branch feature, not main\.\nBefore anything else, talk with the user/)
    assert.deepEqual(store.task(step.id).localChecks, [])
  }
})

test('develop: a repository another step works in locally; Wait starts the step when that one is done (T-50)', async () => {
  const { store, orch, project, task, step, app, sessions } = localSetup()
  // T-2.1 holds app in its main checkout.
  const other = store.createTask({ projectId: project.id, title: 'o', type: 'dev', description: '', status: 'todo' })
  const holder = store.createTask({ projectId: project.id, title: 'h', type: 'dev', description: '', parentId: other.id, status: 'todo', repos: [app] })
  await orch.develop(other.id, undefined, [app])
  assert.equal(localHolderKey(store, app), holder.key)

  await orch.develop(task.id, undefined, [app])
  assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: holder.key, dirty: [], branch: null }])
  assert.equal(git(app, 'branch', '--show-current'), 'mag/t-2-1')
  await orch.resolveLocal(step.id, app, 'wait')
  assert.deepEqual(store.task(step.id).waitingFor, { key: holder.key, repo: app })
  assert.equal(store.task(task.id).needsInput, null)
  await orch.develop(task.id)
  assert.equal(sessions().length, 0, 'a restart keeps waiting')

  await orch.completeStep(holder.id)
  // The waiting step starts in the background (git calls).
  for (let i = 0; i < 50 && store.task(step.id).waitingFor; i++) await tick()
  for (let i = 0; i < 50 && !store.task(step.id).localChecks?.length; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(store.task(step.id).waitingFor, null)
  // The holder left the checkout on its branch: the step asks about that now.
  assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: null, dirty: [], branch: 'mag/t-2-1' }])
})

test('addRepo: a local repository goes on the step branch in its main checkout, or says what is in the way (T-50)', async () => {
  const { store, orch, project, task, app, api } = localSetup()
  const step = store.createTask({ projectId: project.id, title: 's2', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  store.updateTask(store.data.tasks.find((t) => t.parentId === task.id && t.id !== step.id)!.id, { status: 'done' })
  await orch.develop(task.id, undefined, [app, api])
  execFileSync('touch', [join(api, 'mine')])
  await assert.rejects(orch.addRepo(step.id, 'api'), /api has uncommitted changes: mine\. The task works on it in the main checkout: ask the user/)
  assert.equal(git(api, 'branch', '--show-current'), 'main')
  const r = await orch.addRepo(step.id, 'app')
  assert.deepEqual([r.worktree, r.local], [app, true])
  assert.equal(git(app, 'branch', '--show-current'), 'mag/t-1-2')
  const w = await orch.addRepo(step.id, 'api', true)
  assert.equal(w.local, undefined)
  assert.ok(existsSync(w.worktree))
})

function localHolderKey(store: Store, repo: string) {
  return store.data.tasks.find((t) => t.parentId && t.work?.repos.some((r) => r.local && r.repo === repo))?.key
}

/** A step whose developer is between turns, with an open PR in one repository; the owner topic forks if `owner`. */
async function inReview(owner: boolean) {
  const s = await developing()
  s.live.emit({ type: 'turn.done', ok: true })
  await tick()
  // Its run ended without a PR; the PR comes next.
  s.store.updateTask(s.task.id, { needsInput: null })
  if (owner) {
    const topic = s.store.createSession({ projectId: s.project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
    topic.nativeSessionId = 'owner-native'
    s.store.updateTask(s.task.id, { ownerSessionId: topic.id })
  }
  const repo = { repo: s.dir, branch: 'mag/t-1-1', worktree: join(s.workDir, 'app'), prUrl: 'https://github.com/o/app/pull/7', prState: 'open' as const }
  s.store.updateTask(s.step.id, { work: { dir: s.workDir, repos: [repo], feedbackSeenAt: 0 } })
  return s
}

test('review: the first round forks the owner session; changes go to the developer, the next round resumes the fork (T-55.1)', async () => {
  const { store, orch, step, dir, live } = await inReview(true)
  await orch.review(step.id, { [dir]: 'a1a1a1' })
  const first = runs.at(-1)!
  assert.equal(first.spec.resumeId, 'owner-native')
  assert.equal(first.spec.forkSession, true)
  assert.match(first.spec.prompt, /round 1\)[\s\S]*pull\/7 at a1a1a1[\s\S]*You discussed and planned this work/)
  assert.ok(first.spec.disallowedTools?.includes('Edit'))
  const reviewer = store.data.sessions.find((s) => s.role === 'reviewer')!
  assert.equal(reviewer.stepId, step.id)
  first.emit({ type: 'session.started', nativeSessionId: 'fork-1' })

  // A second ask while it runs starts nothing.
  await orch.review(step.id, { [dir]: 'a1a1a1' })
  assert.equal(runs.at(-1), first)

  assert.match(orch.setReview(step.id, 'changes', [{ text: 'no test', where: 'a.ts:3' }]), /go to the developer/)
  assert.deepEqual(store.task(step.id).review, { ...store.task(step.id).review, verdict: 'changes', round: 1, heads: { [dir]: 'a1a1a1' }, withContext: true })
  first.end()
  await tick()
  assert.match(live.sent.at(-1)!, /asks for changes:\n- a\.ts:3: no test/)

  // The developer pushed: the end of its run asks for the next round, on the heads GitHub has now.
  ;(orch as unknown as { prHeads: () => Promise<Record<string, string>> }).prHeads = async () => ({ [dir]: 'b2b2b2' })
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  await tick()
  const second = runs.at(-1)!
  assert.notEqual(second, first)
  assert.equal(second.spec.resumeId, 'fork-1')
  assert.equal(second.spec.forkSession, false)
  assert.match(second.spec.prompt, /round 2\)[\s\S]*addressed:\n- a\.ts:3: no test/)
  orch.setReview(step.id, 'merge', [])
  const sent = live.sent.length
  second.end()
  await tick()
  assert.equal(live.sent.length, sent, 'a merge goes to the user')
  assert.equal(store.task(step.id).review?.round, 2)
  assert.equal(store.data.sessions.filter((s) => s.role === 'reviewer').length, 1)

  // The same heads are not reviewed again.
  await orch.review(step.id, { [dir]: 'b2b2b2' })
  assert.equal(runs.at(-1), second)
})

test('review: without an owner a fresh reviewer reads the doc; no verdict fails, retried only by the user (T-55.1)', async () => {
  const { store, orch, step, task, dir } = await inReview(false)
  await orch.review(step.id, { [dir]: 'a1' })
  const run = runs.at(-1)!
  assert.equal(run.spec.resumeId, undefined)
  assert.equal(run.spec.forkSession, false)
  assert.match(run.spec.prompt, /did not take part in planning/)
  assert.match(run.spec.appendSystemPrompt!, /first reviewer/)
  assert.throws(() => orch.setReview('nope', 'merge', []))
  run.end()
  await tick()
  const reviewer = store.data.sessions.find((s) => s.role === 'reviewer')!
  assert.equal(reviewer.status, 'error')
  assert.equal(store.task(step.id).review, undefined)
  assert.throws(() => orch.setReview(step.id, 'merge', []), /No agent review/)

  await orch.review(step.id, { [dir]: 'a1' })
  assert.equal(runs.at(-1), run, 'the scheduler does not retry it')
  store.updateTask(step.id, { work: { ...store.task(step.id).work!, repos: store.task(step.id).work!.repos.map((r) => ({ ...r, prHead: 'a1' })) } })
  await orch.review(step.id, { [dir]: 'a1' }, true)
  assert.notEqual(runs.at(-1), run, 'Restart')
  assert.equal(store.task(task.id).needsInput, null)
})

test('review: changes past the rounds go to the user (T-55.1)', async () => {
  const { store, orch, step, dir, live } = await inReview(true)
  store.updateTask(step.id, { review: { verdict: 'changes', findings: [{ text: 'x' }], round: 2, heads: { [dir]: 'old' }, withContext: true, at: 1 } })
  await orch.review(step.id, { [dir]: 'new' })
  orch.setReview(step.id, 'changes', [{ text: 'still no test' }])
  const sent = live.sent.length
  runs.at(-1)!.end()
  await tick()
  assert.equal(store.task(step.id).review?.round, 3)
  assert.equal(live.sent.length, sent)
})

test('groom makes the groomer the owner of the work (T-55.1)', async () => {
  const { store, orch, task } = setup()
  orch.groom(task.id)
  await tick()
  assert.equal(store.task(task.id).ownerSessionId, store.data.sessions.find((s) => s.role === 'groomer')!.id)
})
