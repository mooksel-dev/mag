import { test } from 'node:test'
import assert from 'node:assert/strict'
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
const real = adapters['claude-code']
const fake: AgentAdapter = {
  ...real,
  start: () => {
    throw new Error('groomers and developers on Claude Code run on a live process')
  },
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
    fake.start = () => {
      throw new Error('groomers and developers on Claude Code run on a live process')
    }
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
    fake.start = () => {
      throw new Error('groomers and developers on Claude Code run on a live process')
    }
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
