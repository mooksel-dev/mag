import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODE_CHECKS, DEFAULT_PLAYBOOK, DEVELOPER_BAR, PRECEDENCE, directionReferences, emptyResult, findingsFolded, inbox, orientation, repoWorkName, shownResult, type AgentEvent, type PrReview } from '@mag/core'
import { adapters, type AgentAdapter, type LiveHandle, type RunSpec } from '@mag/agents'
import { Store } from './store.ts'
import { Orchestrator } from './orchestrator.ts'
import { createTools, type ToolActions } from './tools.ts'
import type { MessagedRole } from './tool-defs.ts'

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
/** Waits until `f` holds (or fails after `ms`). */
async function until(f: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !f(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error('timed out')
}

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
  const task = store.createTask({ projectId: project.id, title: 'Login', type: 'dev', description: '' })
  return { dir, store, orch, project, task }
}

/** A task in progress on one step whose developer session is live and between turns. */
async function developing() {
  const s = setup()
  s.store.updateTask(s.task.id, { status: 'in_progress' })
  const step = s.store.createTask({ projectId: s.project.id, title: 's', type: 'dev', description: '', parentId: s.task.id, status: 'in_progress' })
  const workDir = join(s.dir, 'worktrees', step.key)
  mkdirSync(workDir, { recursive: true })
  // Its one continue is used: a turn that ends without a PR stops as before (the continue has tests of its own).
  s.store.updateTask(step.id, { work: { dir: workDir, repos: [], feedbackSeenAt: 0 }, autoFix: { ci: 0, conflict: 0, continue: 1 } })
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

test("askOwner: a developer's question goes to the work's owner; the step waits, the owner answers or the user is asked (ahent-vede-robotu-vlasna-pozytsiia.2)", async () => {
  const s = await developing()
  const { store, orch, task, step, session, live } = s
  assert.equal(orch.askOwner(step.id, 'Which schema?'), false, 'no owner: the user is asked')
  const groomer = store.createSession({ projectId: s.project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  store.updateTask(task.id, { ownerSessionId: groomer.id })
  store.data.docs[task.id] = '# Decisions\n- Schema v2 everywhere.\n'

  assert.equal(orch.askOwner(step.id, 'Which schema?'), true)
  await tick()
  const owner = opened.at(-1)!
  assert.notEqual(owner, live)
  assert.match(owner.sent[0], /^The developer of login\.1 \("s"\) asks: Which schema\?\nYou own login: .*answer_developer\(step: "login\.1", text\).*set_needs_input\(reason\)/s)
  assert.match(owner.sent[0], /Schema v2 everywhere/, 'with the decisions of the work')

  // The developer stops to wait: no "stopped without a PR" for the user.
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, null)
  assert.equal(store.task(step.id).ownerQuestion, 'Which schema?')

  // The owner ends its turn without answering: the user gets the question.
  owner.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, 'login.1 asks: Which schema? (its owner did not answer)')

  await orch.answerDeveloper(step.id, 'v2, by the decisions')
  assert.match(live.sent.at(-1)!, /^The owner of the work answers your question: v2, by the decisions$/)
  assert.equal(session.status, 'running')
  assert.equal(store.task(step.id).ownerQuestion, null)
  assert.equal(store.task(task.id).needsInput, null)
  await assert.rejects(orch.answerDeveloper(step.id, 'more'), /No question of login\.1's developer is waiting/)
})

test('askOwner: a topic that owns the work is told to pass work (ahent-vede-robotu-vlasna-pozytsiia.2)', async () => {
  const { store, orch, task, step, project } = await developing()
  const topic = orch.newChat(project.id)
  store.updateTask(task.id, { ownerSessionId: topic })
  assert.equal(orch.askOwner(step.id, 'Which schema?'), true)
  await tick()
  const said = store.session(topic).items.find((i) => i.kind === 'job')
  assert.ok(said?.kind === 'job' && said.title === 'login.1 asks' && said.text.includes('answer_developer(step: "login.1", work: "login", text)') && said.text.includes('set_needs_input(work: "login", reason)'))
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

test('groomer: Bash, WebSearch and WebFetch to read tickets and docs; no edits, merge or push; the tickets in its prompt (T-55.5)', async () => {
  const { store, orch, task } = setup()
  store.updateTask(task.id, { tickets: [{ url: 'https://acme.atlassian.net/browse/ABC-1', key: 'ABC-1' }, { url: 'https://github.com/o/r/issues/2' }] })
  orch.groom(task.id)
  await tick()
  const spec = specs.at(-1)!
  for (const t of ['Bash', 'WebSearch', 'WebFetch']) assert.ok(spec.allowedTools?.includes(t), t)
  for (const t of ['Edit', 'Write', 'Bash(gh pr merge:*)', 'Bash(git push:*)']) assert.ok(spec.disallowedTools?.includes(t), t)
  assert.ok(!spec.disallowedTools?.includes('Bash'))
  // Its PR writes ask on the card (chat-publishes-to-github-prs.2).
  assert.ok(spec.askTools?.includes('Bash(gh pr comment:*)'))
  assert.match(spec.appendSystemPrompt ?? '', /these tickets: ABC-1 \(https:\/\/acme\.atlassian\.net\/browse\/ABC-1\), https:\/\/github\.com\/o\/r\/issues\/2\./)
  assert.match(spec.appendSystemPrompt ?? '', /You own this work/)
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
  assert.match(spec.appendSystemPrompt ?? '', /create_work/)
})

test('integration off: the prompt says so; Enable from the card sets the mode, closes the live process and repeats the turn (redesign-start-screen-big-composer.4)', async () => {
  const { store, orch, project } = setup()
  store.saveIntegrations([{ id: 'claude_ai_Slack', name: 'claude.ai Slack' }])
  const chat = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  await orch.send(chat.id, 'post it to Slack')
  const spec = specs.at(-1)!
  assert.match(spec.appendSystemPrompt ?? '', /claude\.ai Slack \(id claude_ai_Slack\) is turned off in mag for the chat role/)
  assert.ok(spec.disallowedTools?.includes('mcp__claude_ai_Slack'))
  const live = opened.at(-1)!
  store.pushItem(chat.id, { kind: 'integration', id: 'i1', integrationId: 'claude_ai_Slack', server: 'claude.ai Slack', role: 'chat', why: 'post', status: 'off', at: 1 })
  live.emit({ type: 'turn.done', ok: true })
  await tick()

  await orch.enableIntegration(chat.id, 'i1', 'auto')
  assert.equal(store.project(project.id).integrations.chat?.claude_ai_Slack, 'auto')
  assert.equal(store.session(chat.id).items.find((i) => i.kind === 'integration')?.status, 'auto')
  assert.equal(live.closed, true, 'the old process had the old rules')
  const next = opened.at(-1)!
  assert.notEqual(next, live)
  assert.deepEqual(next.sent, ['claude.ai Slack is now on (auto) for you in mag; repeat your last step.'])
  assert.ok(specs.at(-1)!.allowedTools?.includes('mcp__claude_ai_Slack'))
  assert.doesNotMatch(specs.at(-1)!.appendSystemPrompt ?? '', /turned off in mag/)

  store.pushItem(chat.id, { kind: 'integration', id: 'i2', integrationId: 'claude_ai_Slack', server: 'claude.ai Slack', role: 'architect', why: '', status: 'off', at: 2 })
  await assert.rejects(orch.enableIntegration(chat.id, 'i2', 'ask'), /Only Auto/)
  await assert.rejects(orch.enableIntegration(chat.id, 'nope', 'auto'), /No such integration card/)
})

const DOC = `# Problem
p

# Decisions
- all PRs are draft
## login.1
- touch only core
## login.2
- keep the old API

# Plan
1. x
`

test('groomer prompt: frame + the playbook\'s plan, then decisions and notes as blocks; no diagram grammar (T-55.2)', async () => {
  const { store, orch, project, task } = setup()
  store.updateProject(project.id, { notes: 'use pnpm' })
  store.data.docs[task.id] = DOC
  orch.groom(task.id)
  await tick()
  const prompt = specs.at(-1)!.appendSystemPrompt!
  assert.ok(prompt.startsWith('You own this work in "mag"'))
  assert.ok(prompt.includes(DEFAULT_PLAYBOOK.plan))
  const decisions = prompt.indexOf('## Decisions\n- all PRs are draft\n## login.1\n- touch only core\n## login.2\n- keep the old API')
  const notes = prompt.indexOf('## Project notes\nuse pnpm')
  assert.ok(decisions > prompt.indexOf(DEFAULT_PLAYBOOK.plan) && notes > decisions, 'blocks come after the playbook, notes last')
  assert.ok(prompt.includes(PRECEDENCE))
  assert.doesNotMatch(prompt, /One method or call per line|\(add, mod, del\)/, 'the grammar is in show_diagram')
})

test('stance: the playbook\'s stance goes into the groomer, step developer and project chat prompts (ahent-vede-robotu-vlasna-pozytsiia.1)', async () => {
  const { store, orch, project, task } = setup()
  orch.groom(task.id)
  await tick()
  const groomer = specs.at(-1)!.appendSystemPrompt!
  assert.ok(groomer.includes(DEFAULT_PLAYBOOK.stance))
  assert.ok(groomer.indexOf(DEFAULT_PLAYBOOK.stance) < groomer.indexOf(DEFAULT_PLAYBOOK.plan), 'stance before the plan')
  assert.doesNotMatch(groomer, /chat replies to one or two sentences/)
  store.updateProject(project.id, { playbook: { stance: 'OUR STANCE' } })
  store.updateTask(task.id, { status: 'ready' })
  store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  await orch.develop(task.id)
  const dev = specs.at(-1)!.appendSystemPrompt!
  assert.ok(dev.includes('OUR STANCE'))
  assert.ok(!dev.includes(DEFAULT_PLAYBOOK.stance))
  await orch.send(orch.newChat(project.id), 'hi')
  assert.ok(specs.at(-1)!.appendSystemPrompt!.includes('OUR STANCE'))
})

test('step developer prompt: how it is judged, the code checks and the deviation rule after the playbook\'s step, also with a project\'s own step (prompts-use-the-models-to.3)', async () => {
  const { store, orch, project, task } = setup()
  store.updateProject(project.id, { playbook: { step: 'OUR STEP', review: 'OUR REVIEW' } })
  store.updateTask(task.id, { status: 'ready' })
  store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  await orch.develop(task.id)
  const dev = specs.at(-1)!.appendSystemPrompt!
  assert.ok(dev.includes(DEVELOPER_BAR))
  assert.ok(dev.includes(CODE_CHECKS), 'mag\'s checks even when the project rewrote its review')
  assert.match(dev, /State\s+each deviation and why in §Progress and in the PR body/)
  assert.ok(dev.indexOf('OUR STEP') < dev.indexOf(DEVELOPER_BAR), 'the bar follows the playbook\'s step')
})

test('playbook: a project\'s own section replaces the default in the prompt; the rest stays default (T-55.2)', async () => {
  const { store, orch, project, task } = setup()
  store.updateProject(project.id, { playbook: { plan: 'OUR PLANNING' } })
  orch.groom(task.id)
  await tick()
  const prompt = specs.at(-1)!.appendSystemPrompt!
  assert.ok(prompt.includes('OUR PLANNING'))
  assert.ok(!prompt.includes(DEFAULT_PLAYBOOK.plan))
})

test('step developer: the playbook\'s step, the decisions of the work and its own step only; merge and push to base blocked (T-55.2)', async () => {
  const { store, orch, project, task } = setup()
  store.updateProject(project.id, { playbook: { step: 'OUR STEP' }, baseBranch: 'dev' })
  store.data.docs[task.id] = DOC
  store.updateTask(task.id, { status: 'ready' })
  store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  await orch.develop(task.id)
  const spec = specs.at(-1)!
  const prompt = spec.appendSystemPrompt!
  assert.ok(prompt.includes('OUR STEP'))
  assert.ok(!prompt.includes(DEFAULT_PLAYBOOK.step))
  assert.ok(prompt.includes('## Decisions\n- all PRs are draft\n## login.1\n- touch only core'))
  assert.ok(!prompt.includes('keep the old API'), 'another step\'s decisions stay out')
  for (const rule of ['Bash(gh pr merge:*)', 'Bash(git push * dev)', 'Bash(git push *:dev)']) assert.ok(spec.disallowedTools?.includes(rule), rule)
})

test('project chat: the playbook\'s plan (it owns the works it creates) and tracker sections, the notes block; no merge or push (T-55.2, T-55.5)', async () => {
  const { store, orch, project } = setup()
  store.updateProject(project.id, { notes: 'use pnpm', playbook: { tracker: 'COMMENT WITH A LINK', plan: 'OUR PLANNING' } })
  await orch.send(orch.newChat(project.id), 'hi')
  const spec = specs.at(-1)!
  assert.ok(spec.appendSystemPrompt!.includes('COMMENT WITH A LINK'))
  assert.ok(spec.appendSystemPrompt!.includes('OUR PLANNING'))
  assert.ok(spec.appendSystemPrompt!.endsWith('## Project notes\nuse pnpm'))
  assert.ok(!spec.appendSystemPrompt!.includes('## Decisions'), 'a topic has no work')
  assert.ok(spec.disallowedTools?.includes('Bash(gh pr merge:*)'))
  assert.ok(spec.disallowedTools?.includes('Bash(git push:*)'))
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

test('nameChat: the title lands after the turn; a failed naming runs again after the next one; a rename meanwhile wins', async () => {
  const { store, orch, project } = setup()
  const id = orch.newChat(project.id)
  await orch.send(id, 'what should we charge for the pro plan?')
  const live = opened.at(-1)!
  const turn = async (reply: string) => {
    live.emit({ type: 'message', text: reply })
    live.emit({ type: 'turn.done', ok: true })
    await tick()
  }
  const before = runs.length
  await turn('Let us see.')
  assert.equal(runs.length, before + 1, 'one naming run')
  assert.equal(store.session(id).titleGenerated, undefined, 'not named until the title lands')
  runs.at(-1)!.emit({ type: 'error', message: 'rate limited' })
  runs.at(-1)!.end()
  await tick()
  assert.equal(store.session(id).titleGenerated, undefined)

  await orch.send(id, 'and for teams?')
  await turn('Per seat.')
  assert.equal(runs.length, before + 2, 'named again after the next turn')
  runs.at(-1)!.emit({ type: 'message', text: 'Pro plan pricing' })
  runs.at(-1)!.emit({ type: 'turn.done', ok: true })
  runs.at(-1)!.end()
  await tick()
  assert.deepEqual([store.session(id).title, store.session(id).titleGenerated], ['Pro plan pricing', true])

  const other = orch.newChat(project.id)
  await orch.send(other, 'hi')
  const live2 = opened.at(-1)!
  live2.emit({ type: 'message', text: 'Hello' })
  live2.emit({ type: 'turn.done', ok: true })
  await tick()
  orch.renameChat(other, 'Mine')
  runs.at(-1)!.emit({ type: 'message', text: 'Greeting' })
  runs.at(-1)!.end()
  await tick()
  assert.equal(store.session(other).title, 'Mine')
})

test('nameUntitled: topics with replies and no generated title are named once at start, one after another; titled, empty and task sessions not', async () => {
  const { store, orch, project, task } = setup()
  const items = (text: string) => [{ kind: 'user' as const, text, at: 1 }, { kind: 'assistant' as const, text: 'reply', at: 2 }]
  const chat = (title: string, titleGenerated?: boolean) => store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title, titleGenerated })
  const one = chat('first topic')
  one.items.push(...items('first topic'))
  chat('Named', true).items.push(...items('named'))
  chat('New topic')
  store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' }).items.push(...items('groomer'))
  const two = chat('second topic')
  two.items.push(...items('second topic'))
  const before = runs.length
  const done = orch.nameUntitled()
  void orch.nameUntitled()
  assert.equal(runs.length, before + 1, 'one run at a time, not repeated for a topic being named')
  assert.ok(runs.at(-1)!.spec.prompt.includes('first topic'))
  runs.at(-1)!.emit({ type: 'message', text: 'First topic' })
  runs.at(-1)!.end()
  await until(() => runs.length === before + 2)
  assert.ok(runs.at(-1)!.spec.prompt.includes('second topic'))
  runs.at(-1)!.emit({ type: 'message', text: 'Second topic' })
  runs.at(-1)!.end()
  await done
  assert.equal(runs.length, before + 2)
  assert.deepEqual([store.session(one.id).title, store.session(two.id).title, store.session(two.id).titleGenerated], ['First topic', 'Second topic', true])
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

test('closeChat: the live process closes, the history stays; writing to it reopens it; a topic owning an open work is not closed on its own', async () => {
  const { store, orch, project, task } = setup()
  const id = orch.newChat(project.id)
  await orch.send(id, 'hi')
  const live = opened.at(-1)!
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  await orch.closeChat(id)
  assert.equal(live.closed, true)
  assert.ok(store.session(id).closedAt)
  assert.deepEqual(store.session(id).items.map((i) => i.kind).slice(0, 1), ['user'])
  await orch.send(id, 'again')
  assert.equal(store.session(id).closedAt, null)

  store.updateTask(task.id, { ownerSessionId: id })
  await assert.rejects(orch.closeChat(id), /owns .*close the work instead/)
  assert.equal(store.session(id).closedAt, null)
})

test('closeWork / closeReview / restore: a done work and a review close with all they have and come back; an open one is canceled instead, and a canceled one is not restored', async () => {
  const { store, orch, project, task } = setup()
  assert.throws(() => orch.closeWork(task.id), /only a done work/)
  store.updateTask(task.id, { status: 'done' })
  orch.closeWork(task.id)
  assert.ok(store.task(task.id).closedAt)
  assert.equal(store.task(task.id).status, 'done')
  orch.restore('work', task.id)
  assert.equal(store.task(task.id).closedAt, null)

  const review = store.createTask({ projectId: project.id, title: 'app#7: x', type: 'review', description: '', status: 'in_progress' })
  orch.closeWork(review.id)
  assert.deepEqual([store.task(review.id).status, !!store.task(review.id).closedAt], ['done', true])
  orch.restore('work', review.id)
  assert.equal(store.task(review.id).closedAt, null)

  const gone = store.createTask({ projectId: project.id, title: 'g', type: 'dev', description: '' })
  await orch.cancel(gone.id, 'nope')
  assert.throws(() => orch.restore('work', gone.id), /cannot be restored/)

  const topic = orch.newChat(project.id)
  store.closeSession(topic)
  orch.restore('topic', topic)
  assert.equal(store.session(topic).closedAt, null)
})

const SUMMARY = { title: 'Login token', gist: ['The token expired early'], decisions: ['Rotate tokens'], open: [], keywords: ['auth.ts'] }
/** The last one-off run answers `text` and ends. */
async function answer(text: string, ok = true) {
  const run = runs.at(-1)!
  run.emit({ type: 'message', text })
  run.emit({ type: 'turn.done', ok })
  run.end()
  await tick()
}

test('summarize on Close: a closed topic gets a summary with the cheap model and no tools; a second Close without new items does not rerun', async () => {
  const { store, orch, project } = setup()
  const id = orch.newChat(project.id)
  store.session(id).items.push({ kind: 'user', text: 'Why does login fail?', at: 10 }, { kind: 'assistant', text: 'The token expires early.', at: 12 })
  const before = runs.length
  await orch.closeChat(id)
  assert.equal(runs.length, before + 1)
  const spec = runs.at(-1)!.spec
  assert.deepEqual([spec.model, spec.noTools], [adapters['claude-code'].cheapModel, true])
  assert.match(spec.prompt, /User: Why does login fail\?/)
  await answer(JSON.stringify(SUMMARY))
  assert.deepEqual([store.session(id).summary, store.session(id).summaryAt], [SUMMARY, 12])
  assert.equal(store.session(id).title !== SUMMARY.title, true, 'the summary title does not rename the topic')

  orch.restore('topic', id)
  await orch.closeChat(id)
  assert.equal(runs.length, before + 1, 'nothing new since the summary')

  orch.restore('topic', id)
  store.session(id).items.push({ kind: 'user', text: 'And refresh?', at: 20 })
  await orch.closeChat(id)
  assert.equal(runs.length, before + 2)
  await answer('not json')
  assert.deepEqual([store.session(id).summary, store.session(id).summaryAt], [SUMMARY, 12], 'a bad reply keeps the old summary')
})

test('summarize on Close: a done work, a review and a canceled work get one from their doc and owner topic; a failed run keeps none', async () => {
  const { store, orch, project, task } = setup()
  const topic = orch.newChat(project.id)
  store.session(topic).items.push({ kind: 'user', text: 'Plan the login fix', at: 30 })
  store.updateTask(task.id, { status: 'done', ownerSessionId: topic })
  store.data.docs[task.id] = '# Plan\nRotate tokens'
  const before = runs.length
  orch.closeWork(task.id)
  assert.equal(runs.length, before + 1)
  assert.ok(runs.at(-1)!.spec.prompt.includes('Rotate tokens') && runs.at(-1)!.spec.prompt.includes('Plan the login fix'))
  await answer(JSON.stringify(SUMMARY))
  assert.deepEqual([store.task(task.id).summary, store.task(task.id).summaryAt], [SUMMARY, 30])

  const review = store.createTask({ projectId: project.id, title: 'app#7: x', type: 'review', description: '', status: 'in_progress' })
  orch.closeReview(review.id)
  assert.equal(runs.length, before + 2)
  await answer('', false)
  assert.equal(store.task(review.id).summary ?? null, null)

  const gone = store.createTask({ projectId: project.id, title: 'g', type: 'dev', description: '' })
  await orch.cancel(gone.id, 'nope')
  assert.equal(runs.length, before + 3)
  assert.match(runs.at(-1)!.spec.prompt, /Work .*: g/)
  await answer(JSON.stringify(SUMMARY))
  assert.deepEqual(store.task(gone.id).summary, SUMMARY)
})

test('summarizeArchived: closed topics and works without a fresh summary get one at start, one after another; open and fresh ones not', async () => {
  const { store, orch, project, task } = setup()
  const chat = (text: string) => {
    const s = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: text })
    s.items.push({ kind: 'user', text, at: 10 }, { kind: 'assistant', text: 'ok', at: 11 })
    return s
  }
  const old = chat('old closed topic')
  old.closedAt = 50
  const fresh = chat('fresh closed topic')
  Object.assign(fresh, { closedAt: 50, summary: SUMMARY, summaryAt: 11 })
  chat('open topic')
  store.updateTask(task.id, { status: 'done', closedAt: 60 })
  const before = runs.length
  const done = orch.summarizeArchived()
  await tick()
  assert.equal(runs.length, before + 1, 'one run at a time')
  assert.match(runs.at(-1)!.spec.prompt, /old closed topic/)
  await answer(JSON.stringify(SUMMARY))
  await until(() => runs.length === before + 2)
  assert.match(runs.at(-1)!.spec.prompt, /Work .*: Login/)
  await answer(JSON.stringify(SUMMARY))
  await done
  assert.equal(runs.length, before + 2)
  assert.deepEqual([store.session(old.id).summaryAt, store.task(task.id).summary], [11, SUMMARY])
})

test('send with refs: the refs ride on the user item, their summaries go before the text; a stale one is made first', async () => {
  const { store, orch, project, task } = setup()
  const old = orch.newChat(project.id)
  store.session(old).items.push({ kind: 'user', text: 'Why does login fail?', at: 10 }, { kind: 'assistant', text: 'The token expires early.', at: 12 })
  Object.assign(store.session(old), { closedAt: 20, summary: SUMMARY, summaryAt: 12 })
  store.updateTask(task.id, { ownerSessionId: old })
  const chat = orch.newChat(project.id)
  const refs = [{ kind: 'topic' as const, id: old }, { kind: 'task' as const, id: task.id }, { kind: 'topic' as const, id: old }]
  const before = runs.length
  const sent = orch.send(chat, 'Go on from these', [], undefined, refs)
  await tick()
  assert.deepEqual(store.session(chat).items.at(-1), { kind: 'user', text: 'Go on from these', attachments: undefined, refs: refs.slice(0, 2), at: (store.session(chat).items.at(-1) as { at: number }).at })
  await assert.rejects(orch.send(chat, 'again'), /still working/, 'one message at a time while summaries are made')
  assert.equal(runs.length, before + 1, 'the open work without a summary gets one; the fresh topic summary is reused')
  assert.match(runs.at(-1)!.spec.prompt, /Work .*: Login/)
  await answer(JSON.stringify({ ...SUMMARY, gist: ['Work gist'] }))
  await sent
  const prompt = opened.at(-1)!.sent.at(-1)!
  assert.match(prompt, /^<referenced-chats>[\s\S]*## Topic: .* \(archived\)\nread_chat id: [\s\S]*The token expired early[\s\S]*## Work .*: Login\nread_chat id: .*\nWork gist[\s\S]*<\/referenced-chats>\n\nGo on from these$/)
  assert.deepEqual(store.task(task.id).summary?.gist, ['Work gist'])
})

test('send with refs: a failed summary leaves the title only; a job takes no refs', async () => {
  const { store, orch, project } = setup()
  const old = orch.newChat(project.id)
  store.session(old).items.push({ kind: 'user', text: 'Old question', at: 10 })
  const chat = orch.newChat(project.id)
  const sent = orch.send(chat, 'see that', [], undefined, [{ kind: 'topic', id: old }])
  await tick()
  await answer('', false)
  await sent
  assert.match(opened.at(-1)!.sent.at(-1)!, /read_chat id: .*\n\(no summary yet\)[\s\S]*\n\nsee that$/)
  assert.equal(store.session(old).summary ?? null, null)

  const other = orch.newChat(project.id)
  const before = runs.length
  await orch.send(other, 'do it', [], 'A job', [{ kind: 'topic', id: old }])
  assert.deepEqual([opened.at(-1)!.sent.at(-1), runs.length, store.session(other).items.at(-1)?.kind], ['do it', before, 'job'])
})

test('reopen of a closed done work clears its closed mark', () => {
  const { store, orch, project, task } = setup()
  store.updateTask(task.id, { status: 'done' })
  store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'done' })
  store.closeTask(task.id)
  orch.reopen(task.id, 'more', orch.newChat(project.id))
  assert.equal(store.task(task.id).closedAt, null)
})

test('turnIntoWork: the topic\'s agent gets the fixed request; not while it works', async () => {
  const { store, orch, project } = setup()
  const id = orch.newChat(project.id)
  await orch.turnIntoWork(id)
  const job = store.session(id).items.at(-1)
  assert.equal(job?.kind === 'job' && job.title, 'Turn into a work')
  assert.match(opened.at(-1)!.sent.at(-1)!, /create_work from this discussion/)
  assert.throws(() => orch.turnIntoWork(id), /still working/)
})

test('deleteWork: steps, sessions, docs and the owner topic go; refused while an agent runs; an owner of another work stays; a review as deleteReview', async () => {
  const { store, orch, project } = setup()
  const newWork = (owner: string) => {
    const work = store.createTask({ projectId: project.id, title: 'w', type: 'dev', description: '', status: 'in_progress', ownerSessionId: owner })
    const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: work.id, status: 'in_progress' })
    // A turn that ends without a PR just stops (as in developing()).
    store.updateTask(step.id, { autoFix: { ci: 0, conflict: 0, continue: 1 } })
    store.data.docs[work.id] = '# Problem'
    return { work, step }
  }

  const owner = orch.newChat(project.id)
  const { work, step } = newWork(owner)
  const dev = store.createSession({ projectId: project.id, taskId: work.id, stepId: step.id, role: 'developer', agent: 'claude-code', status: 'idle' })
  await orch.send(dev.id, 'go')
  await assert.rejects(orch.deleteWork(work.id), /still working/)
  assert.ok(store.data.tasks.some((t) => t.id === work.id))
  await assert.rejects(orch.deleteWork(step.id), /is a step/)
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  await orch.deleteWork(work.id)
  assert.equal(opened.at(-1)!.closed, true)
  assert.equal(store.data.tasks.some((t) => t.id === work.id || t.id === step.id), false)
  assert.equal(store.data.sessions.some((s) => s.id === dev.id || s.id === owner), false)
  assert.equal(store.data.docs[work.id], undefined)

  // The owner topic stays while it owns another work.
  const shared = orch.newChat(project.id)
  const one = newWork(shared).work
  newWork(shared)
  await orch.deleteWork(one.id)
  assert.ok(store.data.sessions.some((s) => s.id === shared))

  const review = store.createTask({ projectId: project.id, title: 'app#7: Charge', type: 'review', description: '', status: 'in_progress' })
  await orch.deleteWork(review.id)
  assert.equal(store.data.tasks.some((t) => t.id === review.id), false)
})

test('discussIdea: the idea\'s own topic, created once and titled after it; its agent sees the idea', async () => {
  const { store, orch, project } = setup()
  const idea = store.addIdea(project.id, 'Dark mode\nthe whole app, not just the editor', 'T-3.1')
  const topic = orch.discussIdea(idea.id)
  assert.equal(orch.discussIdea(idea.id), topic)
  assert.deepEqual([store.idea(idea.id).topicId, store.session(topic).title, store.session(topic).role], [topic, 'Dark mode', 'chat'])
  await orch.send(topic, 'is it worth it?')
  assert.equal(store.session(topic).title, 'Dark mode', 'the first message does not rename it')
  assert.match(specs.at(-1)!.appendSystemPrompt!, /## The idea this topic discusses\n.*found in T-3\.1.*the whole app, not just the editor/s)
  await orch.deleteChat(topic)
  assert.notEqual(orch.discussIdea(idea.id), topic, 'a deleted topic gives way to a new one')
})

test('startIdea: a discussed idea starts in its own topic and stays until the work is created; one without a discussion in a new topic, at once', async () => {
  const { store, orch, project } = setup()
  const discussed = store.addIdea(project.id, 'dark mode')
  const topic = orch.discussIdea(discussed.id)
  assert.equal(orch.startIdea(discussed.id), topic)
  await tick()
  const sent = store.session(topic).items.find((i) => i.kind === 'job')
  assert.equal(sent?.kind === 'job' && sent.title, 'Start a work from an idea')
  assert.match(sent?.kind === 'job' ? sent.text : '', /^Let's start a work from the idea we discussed here:\n\ndark mode/)
  assert.ok(store.data.ideas.some((i) => i.id === discussed.id), 'it leaves with create_work in the topic')
  assert.throws(() => orch.startIdea(discussed.id), /still working/)

  const plain = store.addIdea(project.id, 'cache rates')
  const fresh = orch.startIdea(plain.id)
  assert.notEqual(fresh, topic)
  assert.ok(!store.data.ideas.some((i) => i.id === plain.id))
  await tick()
  const first = store.session(fresh).items.find((i) => i.kind === 'job')
  assert.match(first?.kind === 'job' ? first.text : '', /^Let's start a work from this idea:\n\ncache rates/)
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
  store.updateTask(task.id, { status: 'ready' })
  const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [api] })
  await orch.develop(task.id)
  const work = store.task(step.id).work!
  assert.deepEqual(work.repos.map((r) => [r.repo, r.branch]), [[api, 'mag/login-1']])
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

test('develop: a repository on master gets its worktree from master; the base is recorded, named and protected', async () => {
  const { dir, store, orch, project, task } = setup()
  const origin = join(dir, 'origin', 'lisa')
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: origin })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: origin })
  const lisa = join(dir, 'repos', 'lisa')
  execFileSync('git', ['clone', '-q', origin, lisa])
  const app = gitRepo(join(dir, 'repos', 'app'))
  store.updateProject(project.id, { repos: [lisa, app] })
  store.updateTask(task.id, { status: 'ready' })
  const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [lisa] })
  await orch.develop(task.id)
  const work = store.task(step.id).work!
  assert.deepEqual(work.repos.map((r) => [r.repo, r.base]), [[lisa, 'master']])
  assert.equal(git(work.repos[0].worktree, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'master'))
  const spec = specs.at(-1)!
  assert.match(spec.appendSystemPrompt!, /- lisa: .* \(branch mag\/login-1, base master\)/)
  assert.match(spec.appendSystemPrompt!, /pushes to main, master\./)
  for (const rule of ['Bash(git push * master)', 'Bash(git push *:master)', 'Bash(git push * main)']) assert.ok(spec.disallowedTools?.includes(rule), rule)

  // A repository added mid-step without a remote: the project's base.
  await orch.addRepo(step.id, 'app')
  assert.deepEqual(store.task(step.id).work!.repos.map((r) => r.base), ['master', 'main'])
})

test('develop: a work from before RepoWork.base gets the base of a repo without a PR on restart; one with a PR keeps the project\'s', async () => {
  const { dir, store, orch, project, task } = setup()
  const origin = join(dir, 'origin', 'lisa')
  mkdirSync(origin, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: origin })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: origin })
  const lisa = join(dir, 'repos', 'lisa')
  execFileSync('git', ['clone', '-q', origin, lisa])
  const app = join(dir, 'repos', 'app')
  execFileSync('git', ['clone', '-q', origin, app])
  store.updateProject(project.id, { repos: [lisa, app] })
  store.updateTask(task.id, { status: 'ready' })
  const stepDir = join(dir, 'w', 'login.1')
  // A start that failed on lisa (no worktree made) and a repo with a PR, both recorded without a base.
  const repos = [
    { repo: lisa, branch: 'mag/login-1', worktree: join(stepDir, 'lisa'), prUrl: null, prState: null },
    { repo: app, branch: 'mag/login-1', worktree: join(stepDir, 'app'), prUrl: 'https://github.com/o/app/pull/1', prState: 'open' as const },
  ]
  const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [lisa, app] })
  store.updateTask(step.id, { work: { dir: stepDir, feedbackSeenAt: 0, repos } })
  await orch.develop(task.id)
  const work = store.task(step.id).work!
  assert.deepEqual(work.repos.map((r) => [r.repo, r.base]), [[lisa, 'master'], [app, undefined]])
  assert.equal(git(work.repos[0].worktree, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'master'), 'the worktree starts from master')
})

test('develop: a step without repos gets its dir and no worktree', async () => {
  const { store, orch, project, task, dir } = setup()
  store.updateTask(task.id, { status: 'ready' })
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
  s.store.updateTask(s.task.id, { status: 'ready' })
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
  assert.equal(git(app, 'branch', '--show-current'), 'mag/login-1')
  assert.equal(sessions().length, 1)
  const spec = specs.at(-1)!
  assert.ok(spec.addDirs?.includes(app), 'the agent may change the main checkout')
  assert.match(spec.appendSystemPrompt!, /- app: .*app \(local: the user's main checkout, not a worktree; branch mag\/login-1, base main\)/)

  // The step is done: the checkout stays on its branch, the worktree goes. (The first stop is continued once.)
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  await orch.completeStep(step.id)
  assert.equal(git(app, 'branch', '--show-current'), 'mag/login-1')
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
  assert.equal(git(app, 'branch', '--show-current'), 'mag/login-1')
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
    assert.match(git(app, 'stash', 'list'), /mag: before login\.1/)
    assert.equal(git(app, 'branch', '--show-current'), 'mag/login-1')
  }
  {
    const { store, orch, task, step, app, sessions } = localSetup()
    git(app, 'checkout', '-q', '-b', 'feature')
    await orch.develop(task.id, undefined, [app])
    assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: null, dirty: [], branch: 'feature' }])
    await orch.resolveLocal(step.id, app, 'switch')
    assert.equal(git(app, 'branch', '--show-current'), 'mag/login-1')
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
    const first = sessions()[0].items.find((i) => i.kind === 'job')
    assert.equal(first?.kind === 'job' && first.title, `Implement ${store.task(sessions()[0].stepId!).key}`)
    assert.match(first?.kind === 'job' ? first.text : '', /In .*app: app is on branch feature, not main\.\nBefore anything else, talk with the user/)
    assert.deepEqual(store.task(step.id).localChecks, [])
  }
})

test('develop: a repository another step works in locally; Wait starts the step when that one is done (T-50)', async () => {
  const { store, orch, project, task, step, app, sessions } = localSetup()
  // o.1 holds app in its main checkout.
  const other = store.createTask({ projectId: project.id, title: 'o', type: 'dev', description: '', status: 'ready' })
  const holder = store.createTask({ projectId: project.id, title: 'h', type: 'dev', description: '', parentId: other.id, status: 'todo', repos: [app] })
  await orch.develop(other.id, undefined, [app])
  assert.equal(localHolderKey(store, app), holder.key)

  await orch.develop(task.id, undefined, [app])
  assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: holder.key, dirty: [], branch: null }])
  assert.equal(git(app, 'branch', '--show-current'), 'mag/o-1')
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
  assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: null, dirty: [], branch: 'mag/o-1' }])
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
  assert.equal(git(app, 'branch', '--show-current'), 'mag/login-2')
  const w = await orch.addRepo(step.id, 'api', true)
  assert.equal(w.local, undefined)
  assert.ok(existsSync(w.worktree))
})

test('develop: a restart with local_repos moves an untouched worktree to the main checkout and sets it up', async () => {
  const { store, orch, task, step, app, api, sessions } = localSetup()
  await orch.develop(task.id)
  const first = store.task(step.id).work!
  assert.ok(existsSync(first.repos[0].worktree))
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()

  await orch.develop(task.id, undefined, [app])
  const work = store.task(step.id).work!
  assert.deepEqual(work.repos.map((r) => [r.repo, r.worktree, !!r.local, r.base]), [[app, app, true, 'main'], [api, join(work.dir, 'api'), false, 'main']])
  assert.equal(existsSync(first.repos[0].worktree), false, 'the worktree is gone')
  assert.equal(git(app, 'branch', '--show-current'), 'mag/login-1', 'the local check ran on a restart')
  assert.equal(sessions().length, 1, 'the same session resumes')
  assert.match(specs.at(-1)!.appendSystemPrompt!, /- app: .*app \(local: the user's main checkout/)
})

test('develop: local_repos on a step whose worktree start failed (no worktree made) works locally; a dirty checkout asks', async () => {
  const { store, orch, project, task, step, app, api, sessions, dir: root } = localSetup()
  const dir = join(root, 'w', 'login.1')
  const session = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'developer', agent: 'claude-code', status: 'error' })
  store.updateTask(step.id, { status: 'in_progress', work: { dir, feedbackSeenAt: 0, repos: [{ repo: app, branch: 'mag/login-1', worktree: join(dir, 'app'), prUrl: null, prState: null, base: 'main' }] } })
  store.updateTask(task.id, { status: 'in_progress' })
  execFileSync('touch', [join(app, 'mine')])
  await orch.develop(task.id, undefined, [app])
  assert.deepEqual(store.task(step.id).work!.repos.map((r) => [r.repo, r.worktree, !!r.local]), [[app, app, true], [api, join(dir, 'api'), false]])
  assert.deepEqual(store.task(step.id).localChecks, [{ repo: app, busyBy: null, dirty: ['mine'], branch: null }])
  assert.equal(git(app, 'branch', '--show-current'), 'main', 'nothing touched before the user decides')

  // The answer sets the checkout up and resumes the session the failed start made.
  await orch.resolveLocal(step.id, app, 'ignore')
  assert.equal(git(app, 'branch', '--show-current'), 'mag/login-1')
  assert.deepEqual(sessions().map((x) => x.id), [session.id])
  assert.equal(store.task(task.id).needsInput, null)
})

test('develop: local_repos on a step with work in its worktree throws and changes nothing', async () => {
  const { store, orch, task, step, app } = localSetup()
  await orch.develop(task.id)
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  const before = store.task(step.id).work!
  const tree = before.repos[0].worktree

  execFileSync('touch', [join(tree, 'draft.ts')])
  await assert.rejects(orch.develop(task.id, undefined, [app]), /app already has work in its worktree \(uncommitted changes: draft\.ts\): restart without it in local_repos, or let login\.1 finish there/)
  git(tree, 'add', '.')
  git(tree, 'commit', '-q', '-m', 'wip')
  await assert.rejects(orch.develop(task.id, undefined, [app]), /app already has work in its worktree \(commits on mag\/login-1\)/)
  store.updateTask(step.id, { work: { ...before, repos: before.repos.map((r, i) => (i ? r : { ...r, prUrl: 'https://github.com/o/app/pull/3', prState: 'open' as const })) } })
  git(tree, 'reset', '-q', '--hard', 'HEAD~1')
  await assert.rejects(orch.develop(task.id, undefined, [app]), /app already has work in its worktree \(its PR https:\/\/github\.com\/o\/app\/pull\/3\)/)
  assert.equal(store.task(step.id).work!.repos[0].local, undefined)
  assert.ok(existsSync(tree))
  assert.equal(store.task(task.id).localRepos, undefined)
  assert.equal(git(app, 'branch', '--show-current'), 'main')

  // The worktree dir is gone, its branch has a commit: that counts too.
  store.updateTask(step.id, { work: before })
  git(tree, 'commit', '-q', '--allow-empty', '-m', 'wip')
  git(app, 'worktree', 'remove', '--force', tree)
  await assert.rejects(orch.develop(task.id, undefined, [app]), /app already has work in its worktree \(commits on mag\/login-1\)/)
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
  const repo = { repo: s.dir, branch: 'mag/login-1', worktree: join(s.workDir, 'app'), prUrl: 'https://github.com/o/app/pull/7', prState: 'open' as const }
  s.store.updateTask(s.step.id, { work: { dir: s.workDir, repos: [repo], feedbackSeenAt: 0 } })
  // These heads are not in git: plan ↔ fact over real git is in fact.test.ts.
  ;(s.orch as unknown as { factOf: () => Promise<string> }).factOf = async () => '## Plan ↔ fact (stub)'
  return s
}

test('review: the first round forks the owner session; changes go to the developer, the next round resumes the fork (T-55.1)', async () => {
  const { store, orch, step, dir, live } = await inReview(true)
  await orch.review(step.id, { [dir]: 'a1a1a1' })
  const first = runs.at(-1)!
  assert.equal(first.spec.resumeId, 'owner-native')
  assert.equal(first.spec.forkSession, true)
  assert.match(first.spec.prompt, /round 1\)[\s\S]*pull\/7 at a1a1a1[\s\S]*You discussed and planned this work/)
  // The owner reviewing its own plan looks hardest where it may be wrong, and knows where its changes go (prompts-use-the-models-to.5).
  assert.match(first.spec.prompt, /Look hardest where your own plan may be wrong/)
  assert.match(first.spec.prompt, /they go back to the developer: this is round 1 of the 2 that may/)
  assert.match(first.spec.prompt, /say so in direction\.view: it never counts toward the verdict/)
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
  // The round makes its scratch worktree (git) before it starts.
  await until(() => runs.at(-1) !== first)
  const second = runs.at(-1)!
  assert.equal(second.spec.resumeId, 'fork-1')
  assert.equal(second.spec.forkSession, false)
  assert.match(second.spec.prompt, /round 2\)[\s\S]*addressed:\n- a\.ts:3: no test/)
  assert.match(second.spec.prompt, /this is round 2 of the 2 that may/)
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

test('review: the reviewer writes the inventory and reads plan ↔ fact; merge is refused over the threshold (T-57.4, T-58)', async () => {
  const { store, orch, step, dir } = await inReview(false)
  await orch.review(step.id, { [dir]: 'a1' })
  const run = runs.at(-1)!
  assert.match(run.spec.prompt, /You write the fact, from the draft units and the hunks below[\s\S]*set_inventory's\s+schema says what a unit is[\s\S]*## Plan ↔ fact \(stub\)\nCall set_review once with the report; the verdict is your own call, and its schema says what each means and what mag adds\. If you would lean another way than the plan on direction, say so in direction\.view/)
  // Each contract once (prompts-use-the-models-to.4): the code checks in mag's frame, the verdict mapping in set_review.
  assert.ok(run.spec.prompt.includes(CODE_CHECKS))
  assert.equal(run.spec.prompt.split(CODE_CHECKS).length, 2, 'the code checks once')
  assert.doesNotMatch(run.spec.prompt, /request_changes = changes|need not restate them as risks/)
  assert.match(run.spec.prompt, /Direction is the approved plan/)
  const counts = { match: 0, differs: 0, missing: 0, unplanned: 1, unaccounted: 0, ungrounded: 0 }
  store.updateTask(step.id, { fact: { heads: { [dir]: 'a1' }, counts, blockers: ['high: app fn x is not on the plan'], canvasId: null, at: 1 } })
  assert.throws(() => orch.setReview(step.id, 'merge', []), /over the threshold[\s\S]*- high: app fn x is not on the plan/)
  assert.equal(store.task(step.id).review, undefined)
  assert.match(orch.setReview(step.id, 'look', [{ text: 'x is unplanned' }]), /user gets your verdict/)
  // A fact of other heads does not hold this review.
  store.updateTask(step.id, { fact: { ...store.task(step.id).fact!, heads: { [dir]: 'zz' } } })
  orch.setReview(step.id, 'merge', [])
  assert.equal(store.task(step.id).review?.verdict, 'merge')
  // A report is stored with the review; its findings are what the developer gets.
  const report = { direction: { decisions: [], options: [], facts: [], references: [] }, problem: [], conventions: [], risks: [], questions: [], changes: [], checks: 'look' as const }
  orch.setReview(step.id, 'look', [{ text: 'q', level: 'question' }], report)
  assert.deepEqual([store.task(step.id).review?.verdict, store.task(step.id).review?.report?.checks], ['look', 'look'])
  run.end()
  await tick()
})

test('review: a failed plan ↔ fact keeps merge from the reviewer (T-57.4)', async () => {
  const { store, orch, step, dir } = await inReview(false)
  delete (orch as unknown as { factOf?: unknown }).factOf
  await orch.review(step.id, { [dir]: 'deadbeef' })
  const run = runs.at(-1)!
  assert.match(run.spec.prompt, /mag could not compare/)
  assert.match(store.task(step.id).fact!.blockers[0], /^mag could not compare the PRs with the plan/)
  assert.throws(() => orch.setReview(step.id, 'merge', []), /over the threshold/)
  run.end()
  await tick()
})

test('review: without an owner a fresh reviewer reads the doc; no verdict fails, retried only by the user (T-55.1)', async () => {
  const { store, orch, step, task, dir } = await inReview(false)
  await orch.review(step.id, { [dir]: 'a1' })
  const run = runs.at(-1)!
  assert.equal(run.spec.resumeId, undefined)
  assert.equal(run.spec.forkSession, false)
  assert.match(run.spec.prompt, /did not take part in planning/)
  assert.match(run.spec.appendSystemPrompt!, /first reviewer/)
  // A fresh reviewer has no owner's system prompt to fork: it gets mag's orientation itself (prompts-use-the-models-to.5).
  assert.ok(run.spec.appendSystemPrompt!.includes(orientation(DEFAULT_PLAYBOOK.reviewRounds)))
  assert.doesNotMatch(run.spec.prompt, /Look hardest where your own plan/)
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

test('review: the reviewer runs in a scratch worktree at the PR head, with the web; the deny list holds; the worktree goes with the run (prompts-use-the-models-to.2)', async () => {
  const { store, orch, step, project, workDir, dir } = await inReview(true)
  const app = gitRepo(join(dir, 'repos', 'app'))
  const head = git(app, 'rev-parse', 'HEAD')
  store.updateProject(project.id, { repos: [app] })
  const repo = { repo: app, branch: 'mag/login-1', worktree: join(workDir, 'app'), prUrl: 'https://github.com/o/app/pull/7', prState: 'open' as const }
  store.updateTask(step.id, { work: { dir: workDir, repos: [repo], feedbackSeenAt: 0 } })
  await orch.review(step.id, { [app]: head })
  const run = runs.at(-1)!
  const scratch = join(run.spec.cwd, 'app')
  assert.ok(![...store.project(project.id).repos, workDir, repo.worktree].includes(run.spec.cwd), 'never the user\'s checkout or the developer\'s worktree')
  assert.ok(run.spec.addDirs?.includes(workDir), 'the developer\'s worktrees stay readable')
  assert.equal(git(scratch, 'rev-parse', 'HEAD'), head)
  assert.ok(run.spec.prompt.includes(`your scratch worktree ${scratch}`))
  assert.match(run.spec.prompt, /run a focused test or a script in your scratch worktree/)
  assert.doesNotMatch(run.spec.prompt, /Run no tests/)
  for (const t of ['Bash', 'WebSearch', 'WebFetch']) assert.ok(run.spec.allowedTools?.includes(t), t)
  for (const t of ['Edit', 'Write', 'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Bash(gh api * -X *)', 'Bash(git push:*)', 'Bash(gh pr merge:*)']) assert.ok(run.spec.disallowedTools?.includes(t), t)
  assert.equal(run.spec.readOnly, true)
  run.end()
  await until(() => !existsSync(scratch))
  assert.ok(!git(app, 'worktree', 'list').includes(scratch))
})

test('Codex never reviews: a Codex developer\'s PRs are reviewed on Claude Code, said in the review; a PR review on a Codex chat is refused (prompts-use-the-models-to.2)', async () => {
  const { store, orch, step, project, dir } = await inReview(false)
  store.updateProject(project.id, { agents: { developer: { agent: 'codex', model: 'gpt-6-luna' } } })
  await orch.review(step.id, { [dir]: 'a1' })
  const reviewer = store.data.sessions.find((s) => s.role === 'reviewer')!
  assert.equal(reviewer.agent, 'claude-code')
  assert.equal(runs.at(-1)!.spec.model, undefined, 'Claude Code on its default model')
  assert.match(reviewer.items.find((i) => i.kind === 'notice')!.text, /Codex can't review[\s\S]*This review runs on Claude Code/)
  store.updateProject(project.id, { agents: { chat: { agent: 'codex', model: null } } })
  await assert.rejects(orch.reviewPr(project.id, 'https://github.com/acme/api/pull/4'), /Codex can't review[\s\S]*Pick Claude Code for Project chat/)
})

test('architect: Bash and the web to check what it reads; no edits and nothing that writes to a PR; read only under Codex (prompts-use-the-models-to.2)', async () => {
  const { orch, project } = setup()
  orch.architect(project.id)
  const spec = runs.at(-1)!.spec
  for (const t of ['Bash', 'WebSearch', 'WebFetch']) assert.ok(spec.allowedTools?.includes(t), t)
  assert.ok(!spec.disallowedTools?.includes('Bash'))
  for (const t of ['Edit', 'Write', 'Bash(gh pr comment:*)', 'Bash(git push:*)', 'Bash(gh pr merge:*)']) assert.ok(spec.disallowedTools?.includes(t), t)
  assert.equal(spec.readOnly, true)
  assert.match(spec.appendSystemPrompt ?? '', /Bash is for reading\s+only, because this checkout is the user's/)
  // Its purpose first, and the shape of a module left to set_architecture's schema (prompts-use-the-models-to.5).
  assert.match(spec.appendSystemPrompt ?? '', /diagrams on, compares a PR's fact with its plan on \(plan ↔ fact\) and checks the\s+architecture rules/)
  assert.doesNotMatch(spec.appendSystemPrompt ?? '', /usually 5-20|"method\(args\): Result/)
})

test('every role has the web; only the developer may write (prompts-use-the-models-to.2)', async () => {
  await developing()
  const dev = specs.at(-1)!
  for (const t of ['WebSearch', 'WebFetch']) assert.ok(dev.allowedTools?.includes(t), `developer ${t}`)
  assert.equal(dev.readOnly, undefined)
  const { store, orch, project, task } = setup()
  const chat = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  await orch.send(chat.id, 'hi')
  const chatSpec = specs.at(-1)!
  orch.groom(task.id)
  await tick()
  for (const [role, spec] of [['chat', chatSpec], ['groomer', specs.at(-1)!]] as const) {
    for (const t of ['WebSearch', 'WebFetch']) assert.ok(spec.allowedTools?.includes(t), `${role} ${t}`)
    assert.equal(spec.readOnly, true, role)
    assert.equal(spec.cwd, project.repos[0], `${role}: no review, no scratch`)
  }
})

test('review: the playbook\'s review section and the step\'s decisions go in every round; its reviewRounds limits the changes (T-55.2)', async () => {
  const { store, orch, step, task, project, dir, live } = await inReview(true)
  store.updateProject(project.id, { playbook: { review: 'OUR REVIEW', stance: 'OUR STANCE', reviewRounds: 0 } })
  store.data.docs[task.id] = DOC
  await orch.review(step.id, { [dir]: 'a1' })
  const run = runs.at(-1)!
  assert.ok(run.spec.prompt.includes('OUR REVIEW'))
  assert.ok(run.spec.prompt.includes('OUR STANCE'), 'the reviewer gets the stance too')
  assert.ok(run.spec.prompt.includes('## Decisions\n- all PRs are draft\n## login.1\n- touch only core'))
  assert.ok(!run.spec.prompt.includes('keep the old API'))
  assert.ok(run.spec.disallowedTools?.includes('Bash(git push:*)'))
  assert.match(orch.setReview(step.id, 'changes', [{ text: 'x' }]), /the user gets your verdict/)
  const sent = live.sent.length
  run.end()
  await tick()
  assert.equal(live.sent.length, sent, 'no rounds: changes go to the user')
})

test('groom makes the groomer the owner of the work (T-55.1)', async () => {
  const { store, orch, task } = setup()
  orch.groom(task.id)
  await tick()
  assert.equal(store.task(task.id).ownerSessionId, store.data.sessions.find((s) => s.role === 'groomer')!.id)
})

/** A done work with one done step, owned by `owner` (a session id) if given. */
function doneWork(s: ReturnType<typeof setup>, owner?: string) {
  s.store.createTask({ projectId: s.project.id, title: 'one', type: 'dev', description: '', parentId: s.task.id, status: 'done' })
  s.store.updateTask(s.task.id, { status: 'done', ...(owner && { ownerSessionId: owner }) })
}

test('reopen: only a done work with steps; asked by a topic, it is back in planning and the topic owns it (T-55.6)', async () => {
  const s = setup()
  const { store, orch, task, project } = s
  assert.throws(() => orch.reopen(task.id, 'more'), /login is planning; only a done work with steps is continued/)
  const topic = orch.newChat(project.id)
  doneWork(s, 'someone-else')
  assert.throws(() => orch.reopen(task.id, '  '), /Say what else is needed/)
  assert.match(orch.reopen(task.id, 'the web part', topic), /back in planning and this topic owns it/)
  const t = store.task(task.id)
  assert.deepEqual([t.status, t.ownerSessionId, t.needsInput], ['planning', topic, null])
  assert.deepEqual(store.data.tasks.filter((x) => x.parentId === task.id).map((x) => x.status), ['done'], 'done steps stay')
  assert.equal(store.data.events.filter((e) => e.taskId === task.id).at(-1)!.text, 'Reopened')
})

test('reopen from the app: the owner topic is told what is needed; without an owner a groomer plans it (T-55.6)', async () => {
  const s = setup()
  const { store, orch, task, project } = s
  const topic = orch.newChat(project.id)
  doneWork(s, topic)
  assert.match(orch.reopen(task.id, 'the web part'), /its owner plans the rest/)
  await tick()
  const said = store.session(topic).items.find((i) => i.kind === 'job')
  assert.ok(said?.kind === 'job' && said.title === 'More needed: login' && said.text.includes('more is needed: the web part') && said.text.includes('pass work: "login"'))
  assert.equal(store.task(task.id).ownerSessionId, topic)

  const t = setup()
  doneWork(t)
  assert.match(t.orch.reopen(t.task.id, 'docs'), /a groomer plans the rest/)
  const groomer = t.store.data.sessions.find((x) => x.role === 'groomer')!
  assert.equal(t.store.task(t.task.id).ownerSessionId, groomer.id)
  // Not the user's answer: the groomer's checkpoint still waits for one.
  assert.deepEqual(groomer.items.map((i) => i.kind), ['notice'])
})

test('reopen from the app while the owner works: the user is asked to tell it (T-55.6)', async () => {
  const s = setup()
  const { store, orch, task, project } = s
  const topic = orch.newChat(project.id)
  await orch.send(topic, 'hi')
  doneWork(s, topic)
  assert.match(orch.reopen(task.id, 'docs'), /its owner is busy/)
  assert.match(store.task(task.id).needsInput!, /More needed: docs/)
  assert.equal(store.task(task.id).status, 'planning')
})

test('develop: a step with a plan diagram starts without a message or a question (T-58: no check against base)', async () => {
  const { dir, store, orch, project, task } = setup()
  const app = gitRepo(join(dir, 'repos', 'app'))
  store.updateProject(project.id, { repos: [app], architecture: { summary: '', updatedAt: 1, modules: [{ id: 'store', name: 'store', description: '', uses: [], paths: ['src'] }] } })
  store.updateTask(task.id, { status: 'ready' })
  const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo' })
  const diagram = { type: 'component' as const, summary: 's', modules: [{ id: 'store', name: 'store', description: '', uses: [], interface: [{ text: 'load(id)' }] }] }
  store.saveCanvas({ projectId: project.id, taskId: task.id, sessionId: null, title: 'Store', kind: 'diagram', diagram, placement: { role: 'plan', option: null, stepId: step.id, repo: null, planOf: null } })
  await orch.develop(task.id)
  assert.deepEqual(store.data.sessions.find((s) => s.stepId === step.id)!.items, [])
  assert.equal(store.task(task.id).needsInput, null)
})

/**
 * Whether a Claude Code permission rule matches a Bash command, as the CLI does it (chat-publishes-to-github-prs.1 and .2,
 * proven with real runs): `prefix:*` matches the command from its start, `*` anything else.
 */
const ruleMatches = (rule: string, command: string) => {
  const m = /^Bash\((.*)\)$/.exec(rule)
  if (!m) return false
  const body = m[1]
  if (body.endsWith(':*')) return command === body.slice(0, -2) || command.startsWith(`${body.slice(0, -2)} `)
  return new RegExp(`^${body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command)
}
const anyMatches = (rules: string[] | undefined, command: string) => (rules ?? []).some((r) => ruleMatches(r, command))

test('a topic asks before it writes to a PR: review, comment, close, edit and gh api writes are ask rules on approve_tool; merge and every push stay denied (chat-publishes-to-github-prs.2)', async () => {
  const { store, orch, project } = setup()
  const chat = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  await orch.send(chat.id, 'review https://github.com/acme/api/pull/4')
  const spec = specs.at(-1)!
  const writes = ['Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr close:*)', 'Bash(gh pr edit:*)', 'Bash(gh api * -X *)', 'Bash(gh api --method *)', 'Bash(gh api * -f *)']
  for (const rule of writes) {
    assert.ok(spec.askTools?.includes(rule), rule)
    assert.ok(!spec.disallowedTools?.includes(rule), rule)
  }
  for (const rule of ['Bash(gh pr merge:*)', 'Bash(git push:*)']) assert.ok(spec.disallowedTools?.includes(rule), rule)
  assert.ok(!spec.disallowedTools?.includes('Bash'))
  assert.ok(spec.allowedTools?.includes('Bash'))
  assert.equal(spec.permissionPromptTool, 'mcp__mag__approve_tool')
  assert.equal(spec.env?.MCP_TOOL_TIMEOUT, String(7 * 24 * 60 * 60 * 1000))
  assert.equal(spec.permissionMode, undefined, 'no auto mode: it never asks under -p (step 1)')
  assert.match(spec.appendSystemPrompt ?? '', /Writes to a PR on GitHub[\s\S]*only when the user asked for them in this conversation: mag shows the user the exact command on a card[\s\S]*Merges and pushes stay blocked/)
  // With leading options too: `gh pr comment:*` alone matches a prefix only.
  for (const c of ['gh pr comment 4 -b "[mag] ok"', 'gh -R acme/api pr comment 4 -b x', 'gh api -X POST repos/acme/api/pulls/4/comments', 'gh api repos/acme/api/pulls/4/comments -f body=x', 'gh -R acme/api api repos/a/b/issues/1/comments -f body=x'])
    assert.ok(anyMatches(spec.askTools, c), c)
  // The checkout is the user's, often on the base branch: a bare push would land there, so no push is even asked about.
  for (const c of ['git push', 'git push origin HEAD', 'git push origin feature', 'git -C /r push', 'git -C /r push origin feature', 'git -c a=b push', 'git --no-pager push', 'gh -R acme/api pr merge 4'])
    assert.ok(anyMatches(spec.disallowedTools, c) && !anyMatches(spec.askTools, c), c)
  for (const c of ['gh pr view 4 --comments', 'gh api repos/acme/api/pulls/4', 'git -C /r log --oneline', 'git log --grep push x', 'git status'])
    assert.ok(!anyMatches(spec.askTools, c) && !anyMatches(spec.disallowedTools, c), c)
})

test('groomer denies every push like a chat; developer, reviewer and architect ask about nothing, and only the developer pushes, never to a base (chat-publishes-to-github-prs.2)', async () => {
  const { orch, project, task } = setup()
  orch.groom(task.id)
  await tick()
  const groomer = specs.at(-1)!
  assert.equal(groomer.permissionPromptTool, 'mcp__mag__approve_tool')
  for (const c of ['git push', 'git -C /r push origin feature']) assert.ok(anyMatches(groomer.disallowedTools, c), c)
  assert.ok(anyMatches(groomer.askTools, 'gh -R a/b pr comment 4 -b x'))
  orch.architect(project.id)
  const architect = runs.at(-1)!.spec
  assert.equal(architect.askTools, undefined)
  for (const c of ['gh pr comment 4 -b x', 'gh -R a/b pr comment 4 -b x', 'git -C /r push origin feature']) assert.ok(anyMatches(architect.disallowedTools, c), c)
  // The developer pushes its branch and replies on its PR as before, never to a base, even after leading options.
  await developing()
  const dev = specs.at(-1)!
  assert.equal(dev.askTools, undefined)
  for (const c of ['git -C /r push origin main', 'git -C /r push origin HEAD:main', 'git --no-pager push origin main']) assert.ok(anyMatches(dev.disallowedTools, c), c)
  assert.ok(!anyMatches(dev.disallowedTools, 'git -C /r push origin mag/login-1'))
})

test("a teammate's PR: its fact is the topic's inventory, without a plan; the verdict goes to Needs you (reviews-ahent-reviuit-pr-timeitiv.2, reviews-prybraty-spysok-pr-i.1)", async () => {
  const { dir, store, orch, project } = setup()
  const app = gitRepo(join(dir, 'repos', 'app'))
  git(app, 'checkout', '-q', '-b', 'feature')
  mkdirSync(join(app, 'src'))
  writeFileSync(join(app, 'src', 'charge.ts'), 'export const charge = 1\n')
  git(app, 'add', '.')
  git(app, 'commit', '-q', '-m', 'charge')
  const head = git(app, 'rev-parse', 'HEAD')
  store.updateProject(project.id, { repos: [app] })
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const pr = { url: 'https://github.com/acme/app/pull/7', repo: app, number: 7, author: 'olena', base: 'main', head }
  const work = store.createTask({ projectId: project.id, title: 'app#7: Charge', type: 'review', description: '', status: 'in_progress', ownerSessionId: topic.id })
  store.updateTask(work.id, { prReview: { pr, results: { v1: emptyResult('v1', topic.id) }, shown: 'v1', posted: null } })

  // No plan: the topic reads the hunks and writes the inventory; mag compares it with nothing.
  const report = await orch.reviewFactOf(work.id)
  assert.match(report, /^## Fact \(mag\)\nFact: no inventory yet: write it with set_inventory from the hunks below\.[\s\S]*### The fact is not complete yet[\s\S]*### H1 {2}app:src\/charge\.ts {2}\[module: [^\]]+\] {2}@@ -0,0 \+1,1 @@\n\[H1\.1\]\n\+export const charge = 1/)
  assert.doesNotMatch(report, /Intent|Plan ↔ fact/)
  assert.deepEqual([store.task(work.id).fact?.canvasId, store.task(work.id).fact?.heads], [null, { [app]: head }])
  const module = /\[module: ([^\]]+)\]/.exec(report)![1]
  const tools = createTools(store, {} as ToolActions)
  const answer = await tools({ projectId: project.id, sessionId: topic.id }, 'set_inventory', { work: work.key, inventory: { summary: ['charge'], units: [{ kind: 'config', module, name: 'charge', change: 'add', hunks: ['H1.1'] }], noise: [] } })
  assert.match(answer, /^Inventory saved: 1 units;[\s\S]*### The fact is complete/)
  const fact = Object.values(store.data.canvases).find((c) => c.role === 'fact' && c.taskId === work.id)!
  assert.deepEqual([fact.stepId, fact.repo, fact.root, store.task(work.id).fact?.canvasId, store.task(work.id).fact?.blockers], [null, app, true, fact.id, []])

  assert.match(orch.setPrReview(work.id, topic.id, { problem: 'p', approach: 'a', verdict: 'request_changes', findings: [{ text: 'x', level: 'blocker', where: 'src/charge.ts:1' }] }), /^Recorded as the review's v1 result[\s\S]*Nothing goes to GitHub/)
  const r = shownResult(store.task(work.id).prReview)!
  assert.deepEqual([r.format, r.verdict, r.head, r.problem], ['v1', 'request_changes', head, 'p'])
  assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions).map((i) => [i.kind, i.text]), [['review_ready', 'Review ready: Request changes · 1 blocker']])
  assert.match(store.data.events.at(-1)!.text, /PR review v1: Request changes · 1 finding/)
  // The v1 topic records findings and a verdict, never a report.
  const v1Tools = createTools(store, { setPrReview: (id, s, rv) => orch.setPrReview(id, s, rv) } as ToolActions)
  await assert.rejects(v1Tools({ projectId: project.id, sessionId: topic.id }, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: {} }), /this is the v1 review of the PR: record verdict and findings/)

  // The same topic runs the v2 format too (as review_pr would): its report goes to results.v2, the v1 result stays.
  const started = store.task(work.id).prReview!
  store.updateTask(work.id, { prReview: { ...started, shown: 'v2', results: { ...started.results, v2: emptyResult('v2', topic.id) } } })

  // The report (review-v2-questions-first-direction.1): checked against the inventory, its checks are the verdict, findings derived.
  const own = createTools(store, { setPrReview: (id, s, rv) => orch.setPrReview(id, s, rv) } as ToolActions)
  const ctx = { projectId: project.id, sessionId: topic.id }
  const claim = (text: string, cites: string[]) => ({ text, source: 'agent', cites })
  const reportArg = {
    direction: {
      decisions: [claim('The charge is a constant', ['u1'])],
      options: [{ name: 'constant', tradeoffs: 'simple', pr: true }, { name: 'config', tradeoffs: 'per tenant' }],
      facts: [claim('one module learns it', ['u1'])],
      references: [{ text: 'your note: no constants', source: 'yours', cites: ['notes'] }],
    },
    problem: [{ criterion: 'charges', status: 'solved', ...claim('it charges', ['src/charge.ts:1']) }],
    conventions: [{ rule: 'no magic numbers', status: 'fail', ...claim('1 is magic', ['src/charge.ts:1']) }],
    risks: [],
    questions: [{ text: 'why 1?', cites: ['src/charge.ts:1'] }],
    changes: [{ title: 'charge', why: 'the whole PR', units: ['u1'] }],
    checks: { verdict: 'request_changes', why: 'a magic number' },
  }
  await assert.rejects(own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: { ...reportArg, checks: 'approve' } }), /Not recorded\. Fix the report[\s\S]*checks\.verdict must be one of[\s\S]*checks\.why is required/)
  await assert.rejects(own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: { ...reportArg, changes: [] } }), /units in no change: u1/)
  // The verdict is the agent's (prompts-use-the-models-to.1): approve over a failed rule is its judgment, mag has no floor here.
  await own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: { ...reportArg, checks: { verdict: 'approve', why: 'the rule does not fit a constant of 1' } } })
  assert.deepEqual([store.task(work.id).prReview!.results.v2!.verdict, store.task(work.id).prReview!.results.v2!.report?.why], ['approve', 'the rule does not fit a constant of 1'])
  // Failed CI is mag's floor: it raises the agent's approve and attaches the blocker itself.
  const withCi = createTools(store, { setPrReview: (id, s, rv) => orch.setPrReview(id, s, rv), failedChecks: async () => ['build (https://ci/1)'] } as Partial<ToolActions> as ToolActions)
  await withCi(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: { ...reportArg, checks: { verdict: 'approve', why: 'fine' } } })
  const raised = store.task(work.id).prReview!.results.v2!
  assert.deepEqual([raised.verdict, raised.report?.raisedFrom, raised.findings[0]], ['request_changes', 'approve', { text: 'mag: CI failed: build (https://ci/1)', level: 'blocker' }])
  await own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: reportArg })
  const v2 = store.task(work.id).prReview!.results.v2!
  assert.deepEqual([v2.verdict, v2.report?.direction.facts[0].source, v2.report?.problem[0].source, v2.findings.map((f) => f.level)], ['request_changes', 'checked', 'agent', ['blocker', 'question']])
  assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions).map((i) => i.text), ['Review ready: Request changes · Direction: your call'])

  // The user's call on the direction (review-v2-questions-first-direction.2): the topic records it once they decide.
  const decideTools = createTools(store, { setPrReview: (id, s, rv) => orch.setPrReview(id, s, rv), decideDirection: (id, d) => orch.decideDirection(id, d) } as ToolActions)
  await assert.rejects(decideTools(ctx, 'decide_direction', { work: work.key, choice: 'prefer', option: 'constant' }), /prefer needs option: one of the options other than the PR's: config/)
  await assert.rejects(decideTools(ctx, 'decide_direction', { work: work.key, choice: 'maybe' }), /choice must be one of ok, prefer, discuss/)
  const other = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  await assert.rejects(decideTools({ projectId: project.id, sessionId: other.id }, 'decide_direction', { work: work.key, choice: 'ok' }), /not planned in this topic/)
  const notesBefore = store.project(project.id).notes
  assert.match(await decideTools(ctx, 'decide_direction', { work: work.key, choice: 'prefer', option: 'config', principle: 'no constants in billing' }), /^Recorded: Prefer config[\s\S]*draft to the author/)
  const first = store.project(project.id).directionDecisions!
  assert.deepEqual(first.map((d) => [d.reviewId, d.pr, d.decision, d.choice, d.option, d.principle]), [[work.id, pr.url, 'The charge is a constant', 'prefer', 'config', 'no constants in billing']])
  const line = `- Direction ${pr.url}: The charge is a constant → Prefer config (no constants in billing)`
  assert.equal(store.project(project.id).notes, [notesBefore, line].filter(Boolean).join('\n'))
  const decided = store.task(work.id).prReview!.results.v2!.report!
  assert.deepEqual([decided.decided?.id, decided.draft], [first[0].id, "I'd rather go with config than constant: per tenant.\n\nno constants in billing"])
  assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions).map((i) => i.text), ['Review ready: Request changes · Direction: Prefer config'])
  assert.match(store.data.events.at(-1)!.text, /^Direction: Prefer config$/)
  // Decided again (the page's button): it replaces the call in the review, the decisions and the notes; ok drafts nothing.
  orch.decideDirection(work.id, { choice: 'ok' })
  const again = store.project(project.id)
  assert.equal(again.directionDecisions!.length, 1)
  assert.equal(again.directionDecisions![0].choice, 'ok')
  assert.equal(again.notes, [notesBefore, `- Direction ${pr.url}: The charge is a constant → Direction OK`].filter(Boolean).join('\n'))
  assert.equal(store.task(work.id).prReview!.results.v2!.report!.draft, undefined)
  orch.decideDirection(work.id, { choice: 'discuss', draft: 'Why a constant?' })
  const ask = store.project(project.id).directionDecisions![0]
  assert.equal(store.task(work.id).prReview!.results.v2!.report!.draft, 'Why a constant?')

  // Discuss with agent: the review's topic gets the direction card and decide_direction.
  assert.deepEqual(await orch.discussDirection(work.id), { sessionId: topic.id })
  const sent = opened.at(-1)!.sent.at(-1)!
  assert.match(sent, /The user wants to discuss the direction of https:\/\/github\.com\/acme\/app\/pull\/7[\s\S]*Options:\n- constant \(the PR's\): simple\n- config: per tenant[\s\S]*call decide_direction with work: "[^"]+": choice ok[\s\S]*prefer with option \(one of: config\)/)
  assert.equal(store.session(topic.id).items.at(-1)!.kind, 'job')
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await until(() => !orch.isRunning(topic.id))

  // The next review cites the call as decision:<id>: the card shows it as yours; a decision that is not there is refused.
  const cites = (id: string) => ({ ...reportArg, direction: { ...reportArg.direction, references: [{ text: 'you asked the author about constants before', source: 'agent', cites: [`decision:${id}`] }] } })
  await assert.rejects(own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: cites('nope') }), /no direction decision decision:nope/)
  await own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: cites(ask.id) })
  const next = store.task(work.id).prReview!.results.v2!.report!
  assert.deepEqual(directionReferences(next, store.project(project.id).directionDecisions).map((r) => [r.claim.source, r.decisions.map((d) => d.choice)]), [['yours', ['discuss']]])
  // A new report of the same PR keeps the user's call and its draft; deciding again still replaces it.
  assert.deepEqual([next.decided?.id, next.draft], [ask.id, 'Why a constant?'])
  assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions).map((i) => i.text), ['Review ready: Request changes · Direction: Ask the author'])
  orch.decideDirection(work.id, { choice: 'prefer', option: 'config' })
  await own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', report: reportArg })
  const kept = store.task(work.id).prReview!.results.v2!.report!
  assert.deepEqual([kept.decided?.choice, kept.decided?.option, kept.draft], ['prefer', 'config', "I'd rather go with config than constant: per tenant."])
  assert.equal(findingsFolded(kept), true)
  orch.decideDirection(work.id, { choice: 'ok' })
  assert.equal(findingsFolded(store.task(work.id).prReview!.results.v2!.report), false)
  const final = store.project(project.id)
  assert.deepEqual(final.directionDecisions!.map((d) => d.choice), ['ok'])
  assert.equal(final.notes, [notesBefore, `- Direction ${pr.url}: The charge is a constant → Direction OK`].filter(Boolean).join('\n'))
  // The v2 topic records a report only; both results are kept, and the switch shows either.
  await assert.rejects(own(ctx, 'set_pr_review', { work: work.key, problem: 'p', approach: 'a', verdict: 'comment', findings: [] }), /this is the v2 review of the PR: record it with report/)
  const both = store.task(work.id).prReview!
  assert.deepEqual([both.shown, both.results.v1?.verdict, both.results.v1?.report, both.results.v2?.verdict], ['v2', 'request_changes', undefined, 'request_changes'])
  orch.showReviewResult(work.id, 'v1')
  assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions).map((i) => i.text), ['Review ready: Request changes · 1 blocker'])
  // The direction is v2's: deciding it with v1 shown still goes to results.v2.
  orch.decideDirection(work.id, { choice: 'discuss' })
  assert.deepEqual([store.task(work.id).prReview!.results.v2!.report!.decided?.choice, store.task(work.id).prReview!.results.v1!.report], ['discuss', undefined])

  orch.closeReview(work.id)
  assert.equal(store.task(work.id).status, 'done')
  assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions), [])
})

test('send with a job: the chat gets a job item, the agent its text; a new topic takes the job as its title (reviews-normalnyi-ux-stan-reviu.1)', async () => {
  const { store, orch, project } = setup()
  const topic = orch.newChat(project.id)
  await orch.send(topic, 'Review the PR https://github.com/acme/app/pull/7 (app#7 …)\nthe playbook…', [], 'Review app#7')
  const s = store.session(topic)
  assert.deepEqual(s.items.map((i) => i.kind), ['job'])
  assert.deepEqual(s.items[0].kind === 'job' && [s.items[0].title, s.items[0].text.split('\n')[1]], ['Review app#7', 'the playbook…'])
  assert.equal(s.title, 'Review app#7')
  assert.match(opened.at(-1)!.sent.at(-1)!, /^Review the PR https:\/\/github\.com\/acme\/app\/pull\/7/)
})

test('deleteReview: the review, its doc, diagrams and own topic go; a topic that asked for it stays, and while it works nothing is deleted (reviews-normalnyi-ux-stan-reviu.1)', async () => {
  const { store, orch, project } = setup()
  const pr = { url: 'https://github.com/acme/app/pull/7', repo: '/r/app', number: 7, author: 'olena', base: 'main', head: 'abc' }
  const fresh: PrReview = { pr, results: {}, shown: 'v2', posted: null }
  const newReview = (owner: string) => {
    const work = store.createTask({ projectId: project.id, title: 'app#7: Charge', type: 'review', description: '', status: 'in_progress', ownerSessionId: owner })
    store.updateTask(work.id, { prReview: fresh })
    store.data.docs[work.id] = '# Problem'
    store.saveCanvas({ projectId: project.id, taskId: work.id, sessionId: null, title: 'Fact', kind: 'diagram', diagram: { type: 'component', summary: '', modules: [] }, placement: { role: 'fact', option: null, stepId: null, repo: null, planOf: null } })
    return work
  }

  // mag's own topic, in a turn: its run ends and it goes with the review.
  const own = orch.newChat(project.id)
  const work = newReview(own)
  store.session(own).reviewOf = work.id
  await orch.send(own, 'job', [], 'Review app#7')
  await orch.deleteReview(work.id)
  assert.equal(store.data.tasks.some((t) => t.id === work.id), false)
  assert.equal(store.data.sessions.some((s) => s.id === own), false)
  assert.equal(store.data.docs[work.id], undefined)
  assert.equal(Object.values(store.data.canvases).some((c) => c.taskId === work.id), false)

  // A topic of the user's that asked for the review (review_pr) owns it: it stays.
  const asked = orch.newChat(project.id)
  const borrowed = newReview(asked)
  await orch.send(asked, 'review https://github.com/acme/app/pull/7')
  await assert.rejects(orch.deleteReview(borrowed.id), /still working/)
  assert.ok(store.data.tasks.some((t) => t.id === borrowed.id))
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  await orch.deleteReview(borrowed.id)
  assert.equal(store.data.tasks.some((t) => t.id === borrowed.id), false)
  assert.ok(store.data.sessions.some((s) => s.id === asked))

  const step = store.createTask({ projectId: project.id, title: 'w', type: 'dev', description: '', status: 'planning' })
  await assert.rejects(orch.deleteReview(step.id), /not a review/)
})

/**
 * A gh on PATH that answers from a local repository as GitHub would (reviews-ahent-reviuit-pr-timeitiv.3): pr view
 * from `pr`, compare from git in `repo`; a posted review is appended to `posts`, refused with 422 while `reject` is set
 * and it has line comments.
 */
function fakeGh(dir: string) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const config = join(dir, 'gh.json')
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const c = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'))
const a = process.argv.slice(2)
const git = (...args) => execFileSync('git', args, { cwd: c.repo, encoding: 'utf8' })
if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(JSON.stringify(c.pr))
else if (a[0] === 'api' && a.includes('POST')) {
  const body = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (c.reject && body.comments.length) { process.stderr.write('gh: Unprocessable Entity (HTTP 422): line could not be resolved'); process.exit(1) }
  fs.appendFileSync(c.posts, JSON.stringify(body) + '\\n')
  process.stdout.write(JSON.stringify({ html_url: c.pr.url + '#review-1' }))
} else if (a[0] === 'api') {
  const [base, head] = a.find((x) => x.includes('/compare/')).split('/compare/')[1].split('...').map(decodeURIComponent)
  process.stdout.write(a.includes('--jq') ? git('merge-base', base, head) : git('diff', '--no-color', '-M', base + '...' + head))
} else { process.stderr.write('fake gh: ' + a.join(' ')); process.exit(2) }
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  const set = (c: object) => writeFileSync(config, JSON.stringify(c))
  return { set, posts: () => (existsSync(join(dir, 'posts')) ? readFileSync(join(dir, 'posts'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []), restore: () => void (process.env.PATH = path), postsFile: join(dir, 'posts') }
}

test("a PR outside the project: read from GitHub by folders; the user publishes the picked findings; new commits get a look at what they change (reviews-ahent-reviuit-pr-timeitiv.3)", async () => {
  const { dir, store, orch, project } = setup()
  const remote = gitRepo(join(dir, 'remote'))
  git(remote, 'checkout', '-q', '-b', 'feature')
  mkdirSync(join(remote, 'src', 'billing'), { recursive: true })
  writeFileSync(join(remote, 'src', 'billing', 'charge.ts'), 'export const charge = 1\n')
  git(remote, 'add', '.')
  git(remote, 'commit', '-q', '-m', 'charge')
  const head = git(remote, 'rev-parse', 'HEAD')
  const url = 'https://github.com/acme/remote/pull/7'
  const gh = fakeGh(dir)
  const pr = { url, number: 7, title: 'Charge', author: { login: 'olena' }, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: head }
  gh.set({ repo: remote, posts: gh.postsFile, pr })
  try {
    const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
    // The user's earlier direction decisions go to the reviewer's job (review-v2-questions-first-direction.2).
    store.updateProject(project.id, { directionDecisions: [{ id: 'd9', reviewId: 'x', pr: 'https://github.com/acme/remote/pull/3', decision: 'Charges are constants', choice: 'prefer', option: 'config', principle: 'no constants in billing', at: 1 }] })
    const first = await orch.reviewPr(project.id, url, topic.id)
    assert.match(first.job, /The user's earlier direction decisions[\s\S]*citing decision:<id>:\n- decision:d9: https:\/\/github\.com\/acme\/remote\/pull\/3: Charges are constants → Prefer config; principle: no constants in billing$/)
    assert.match(first.job, /When the user decides it, record it with decide_direction/)
    const work = store.task(first.taskId)
    assert.deepEqual([work.prReview!.pr.repo, work.prReview!.pr.outside, work.title], ['acme/remote', true, 'remote#7: Charge'])
    assert.match(first.job, /Its repository acme\/remote is not one of the project's, so mag has no checkout of it: read the PR with gh pr diff/)
    assert.match(first.job, /Changed files \(mag\):\n[\s\S]*src-billing[\s\S]*src\/billing\/charge\.ts/)
    assert.doesNotMatch(first.job, /New commits since/)
    // Options before the author's description; no verdict on the direction (review-v2-questions-first-direction.1).
    assert.match(first.job, /the inventory first, then the direction and its options from the inventory and the code alone, and only then the PR's description and comments \(gh pr view\)/)
    assert.match(first.job, /The user decides the direction; your own leaning, if you have one, goes in direction.view/)
    assert.equal(first.job.split(CODE_CHECKS).length, 2, 'the code checks once, in mag\'s frame')
    assert.match(first.job, /Call set_pr_review with the report/)
    assert.ok(first.job.indexOf('Direction, before you read') < first.job.indexOf('3. Only now read the PR: gh pr view'))
    assert.match(await orch.reviewFactOf(work.id), /Without the project architecture: the repository is outside the project/)

    orch.setPrReview(work.id, topic.id, { problem: 'p', approach: 'a', verdict: 'request_changes', findings: [{ text: 'charges twice', level: 'blocker', where: 'src/billing/charge.ts:1' }, { text: 'name', level: 'nit', where: 'charge' }] })
    assert.match(await orch.publishReview(work.id, 'request_changes', [0]), /#review-1$/)
    assert.deepEqual(gh.posts(), [{ commit_id: head, event: 'REQUEST_CHANGES', body: '1 blocker', comments: [{ path: 'src/billing/charge.ts', line: 1, side: 'RIGHT', body: '**blocker**: charges twice' }] }])
    const r = store.task(work.id).prReview!
    assert.deepEqual(shownResult(r)!.findings.map((f) => f.post), [true, false])
    assert.equal(r.posted?.url, `${url}#review-1`)
    // GitHub refuses a line comment: everything goes in the text.
    gh.set({ repo: remote, posts: gh.postsFile, pr, reject: true })
    await orch.publishReview(work.id, 'comment', [0, 1])
    assert.deepEqual(gh.posts()[1], { commit_id: head, event: 'COMMENT', body: '- `src/billing/charge.ts:1`: **blocker**: charges twice\n- `charge`: **nit**: name', comments: [] })

    // New commits: only what they change.
    writeFileSync(join(remote, 'src', 'billing', 'refund.ts'), 'export const refund = 1\n')
    git(remote, 'add', '.')
    git(remote, 'commit', '-q', '-m', 'refund')
    const next = git(remote, 'rev-parse', 'HEAD')
    gh.set({ repo: remote, posts: gh.postsFile, pr: { ...pr, headRefOid: next } })
    const again = await orch.reviewPr(project.id, url, topic.id)
    assert.equal(again.taskId, work.id)
    assert.match(again.job, new RegExp(`New commits since: review only what changed after ${head.slice(0, 12)} \\(gh api -H "Accept: application/vnd.github.diff" repos/acme/remote/compare/${head}\\.\\.\\.${next}\\)`))
    const since = again.job.split('Changed since your review (mag):\n')[1].split('Pass work')[0]
    assert.match(since, /refund\.ts/)
    assert.doesNotMatch(since, /charge\.ts/)

    // Connect repo: only a checkout of that repository joins the project.
    await assert.rejects(orch.connectReviewRepo(work.id, dir), /is not a checkout of acme\/remote/)
    // Its checkout: read locally from then on (the fetch from GitHub fails here without a network, and is said so).
    git(remote, 'remote', 'add', 'origin', 'git@github.com:acme/remote.git')
    process.env.GIT_SSH_COMMAND = 'false'
    const { sessionId } = await orch.connectReviewRepo(work.id, remote)
    assert.equal(sessionId, topic.id)
    assert.ok(store.project(project.id).repos.includes(remote))
    const local = store.task(work.id).prReview!
    assert.deepEqual([local.pr.repo, local.pr.outside, shownResult(local)!.head], [remote, undefined, head])
    const job = opened.at(-1)!.sent.at(-1)!
    assert.match(job, /Its repository is .*remote, the user's main checkout[\s\S]*New commits since: review only what changed after \w+ \(git diff /)
    // Its own checkout now: a scratch worktree at the PR's head to run focused tests in, never the user's checkout.
    const scratch = job.match(/The code at the PR's head is in (\S+)\.\n/)![1]
    assert.ok(!store.project(project.id).repos.includes(scratch))
    assert.equal(git(scratch, 'rev-parse', 'HEAD'), next)
    assert.match(job, /run a focused test or a script in .*scratch/)
  } finally {
    gh.restore()
    delete process.env.GIT_SSH_COMMAND
  }
})

test('v1 and v2 side by side: each format in its own topic, both results kept, the inventory reused at the same head, the prompt per format (review-v2-part-2-v1-2.1)', async () => {
  const { dir, store, orch, project } = setup()
  const remote = gitRepo(join(dir, 'remote'))
  git(remote, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(remote, 'charge.ts'), 'export const charge = 1\n')
  git(remote, 'add', '.')
  git(remote, 'commit', '-q', '-m', 'charge')
  const head = git(remote, 'rev-parse', 'HEAD')
  const url = 'https://github.com/acme/remote/pull/7'
  const gh = fakeGh(dir)
  gh.set({ repo: remote, posts: gh.postsFile, pr: { url, number: 7, title: 'Charge', author: { login: 'olena' }, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: head } })
  // Each topic's live process, by the order they open.
  const lives = new Map<string, (typeof opened)[number]>()
  const endTurn = async (id: string) => {
    lives.get(id)!.emit({ type: 'turn.done', ok: true })
    await until(() => !orch.isRunning(id))
  }
  try {
    // The project's format preselects it: v1 here, in mag's own topic for v1.
    store.updateProject(project.id, { reviewFormat: 'v1' })
    const first = await orch.reviewPr(project.id, url)
    const work = store.task(first.taskId)
    const t1 = store.session(first.sessionId)
    lives.set(t1.id, opened.at(-1)!)
    assert.deepEqual([t1.reviewFormat, t1.reviewOf, t1.title, work.prReview!.shown], ['v1', work.id, 'Review remote#7 · v1', 'v1'])
    assert.equal(opened.at(-1)!.sent.at(-1), first.job)
    assert.match(first.job, /you own the v1 review of /)
    assert.match(first.job, /7\. Record it with set_pr_review: the findings/)
    assert.ok(first.job.includes(CODE_CHECKS), 'v1 gets the code checks too')
    assert.match(first.job, /Call set_pr_review with the verdict and the findings/)
    assert.doesNotMatch(first.job, /decide_direction|Direction, before you read/)
    assert.match(first.job, /The fact, by the project's playbook:\nThe fact is the change inventory/)
    await assert.rejects(orch.runReviewFormat(work.id, 'v1'), /The v1 review of .* is still working/)
    // The v1 run writes the inventory and its result.
    await orch.reviewFactOf(work.id)
    store.saveCanvas({ projectId: project.id, taskId: work.id, sessionId: t1.id, title: 'fact', kind: 'diagram', diagram: { type: 'component', summary: '', modules: [] }, placement: { role: 'fact', option: null, stepId: null, repo: 'acme/remote', planOf: null }, root: true, inventory: { summary: ['charge'], units: [], noise: [] } })
    await endTurn(t1.id)
    orch.setPrReview(work.id, t1.id, { problem: 'p1', approach: 'a1', verdict: 'approve', findings: [] })

    // Run v2: a fresh topic of its own; at the same head it reads the v1 run's inventory instead of writing one.
    await orch.runReviewFormat(work.id, 'v2')
    const t2 = store.session(store.task(work.id).ownerSessionId!)
    lives.set(t2.id, opened.at(-1)!)
    assert.notEqual(t2.id, t1.id)
    assert.deepEqual([t2.reviewFormat, t2.reviewOf, store.task(work.id).prReview!.shown], ['v2', work.id, 'v2'])
    const job2 = opened.at(-1)!.sent.at(-1)!
    assert.match(job2, /you own the v2 review of /)
    assert.match(job2, /Direction, before you read/)
    assert.match(job2, /The fact: the PR's change inventory at this head is already written \(one per head, for both formats of the review\)[\s\S]*never to write it anew/)
    assert.doesNotMatch(job2, /You reviewed it before/, 'v2 does not see the v1 result')
    await endTurn(t2.id)
    orch.setPrReview(work.id, t2.id, { problem: 'p2', approach: 'a2', verdict: 'request_changes', findings: [{ text: 'x', level: 'blocker' }] })
    const both = store.task(work.id).prReview!
    assert.deepEqual([both.results.v1?.verdict, both.results.v1?.problem, both.results.v1?.sessionId, both.results.v2?.verdict, both.results.v2?.sessionId], ['approve', 'p1', t1.id, 'request_changes', t2.id])
    assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions).map((i) => i.text), ['Review ready: Request changes · 1 blocker'])

    // The switch: v1 is shown, and its topic is the conversation beside it.
    orch.showReviewResult(work.id, 'v1')
    assert.deepEqual([store.task(work.id).prReview!.shown, store.task(work.id).ownerSessionId], ['v1', t1.id])
    assert.deepEqual(inbox(project.id, store.data.tasks, store.data.sessions).map((i) => i.text), ['Review ready: Approve · no findings'])
    // Review again is the shown format's, in its own topic; at the same head it reads the one inventory, never writes it anew.
    const again = await orch.rereview(work.id)
    assert.equal(again.sessionId, t1.id)
    assert.match(again.job, /You reviewed it before[\s\S]*Look again: whether each finding still holds\./)
    assert.match(again.job, /already written \(one per head, for both formats of the review\)[\s\S]*never to write it anew/)
    await endTurn(t1.id)
    assert.equal(store.task(work.id).prReview!.results.v2?.verdict, 'request_changes', 'the other result stays')
    await assert.rejects(Promise.resolve().then(() => orch.runReviewFormat(work.id, 'v3' as 'v1')), /format must be one of v1, v2/)
  } finally {
    gh.restore()
  }
})

/** The tools of a project topic that does what the buttons do, wired to the orchestrator as index.ts wires them. */
function chatControls(s: ReturnType<typeof setup>) {
  const actions = {
    approve: (id: string) => s.orch.approve(id),
    develop: (id: string, local?: string[]) => s.orch.develop(id, undefined, local),
    approveAndStart: (id: string, local?: string[]) => s.orch.approveAndStart(id, local),
    startStep: (id: string) => s.orch.startStep(id),
    restartReview: (id: string) => s.orch.reviewTask(id),
    agentOf: (id: string, role?: MessagedRole) => s.orch.agentOf(id, role),
    send: (id: string, text: string) => s.orch.send(id, text),
    stopAgents: (id: string) => s.orch.stopAgents(id),
    closeChat: (id: string) => s.orch.closeChat(id),
    closeWork: (id: string) => s.orch.closeWork(id),
    deleteChat: (id: string) => s.orch.deleteChat(id),
    deleteWork: (id: string) => s.orch.deleteWork(id),
    restore: (kind: 'work' | 'topic', id: string) => s.orch.restore(kind, id),
  } as ToolActions
  const tools = createTools(s.store, actions)
  const topic = s.store.createSession({ projectId: s.project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const call = (name: string, args: Record<string, unknown>, sessionId = topic.id) => tools({ projectId: s.project.id, sessionId }, name, args)
  const logged = () => s.store.data.events.filter((e) => e.kind === 'chat').map((e) => `${e.taskKey}: ${e.text}`)
  return { call, topic, logged }
}

test("approve_plan: the button's checks and change; a project topic only; logged (chat-keruie-robotamy-i-ahentamy.1)", async () => {
  const s = setup()
  const { store, orch, project, task } = s
  const { call, logged } = chatControls(s)
  const architect = store.createSession({ projectId: project.id, taskId: null, role: 'architect', agent: 'claude-code', status: 'idle' })
  await assert.rejects(call('approve_plan', { key: 'login' }, architect.id), /approve_plan is for a project chat/)
  await assert.rejects(call('approve_plan', { key: 'login' }), /login cannot be approved: Add at least one step/)
  store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  orch.groom(task.id)
  await tick()
  await assert.rejects(call('approve_plan', { key: 'login' }), /An agent is still working on this task/)
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  store.updateTask(task.id, { needsInput: 'Look' })
  assert.equal(await call('approve_plan', { key: 'login' }), 'login is approved: ready to start.')
  assert.deepEqual([store.task(task.id).status, store.task(task.id).needsInput], ['ready', null])
  await assert.rejects(call('approve_plan', { key: 'login' }), /login is ready; only a plan in planning is approved/)
  assert.deepEqual(logged(), ["login: chat: approved login at the user's request"])
})

test('start_work and start_step: as Start; errors as the button gives them (chat-keruie-robotamy-i-ahentamy.1)', async () => {
  const s = setup()
  const { store, project, task } = s
  const { call, logged } = chatControls(s)
  const one = store.createTask({ projectId: project.id, title: 'one', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  const two = store.createTask({ projectId: project.id, title: 'two', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [], startManually: true })
  store.updateTask(task.id, { status: 'ready' })
  await assert.rejects(call('start_work', { key: 'login.1' }), /login\.1 is a step: start its work login/)
  await assert.rejects(call('start_work', { key: 'login', local_repos: ['web'] }), /Not a repository of the project: web/)
  assert.equal(await call('start_work', { key: 'login' }), 'Started login on login.1.')
  assert.equal(store.task(one.id).status, 'in_progress')
  const dev = store.data.sessions.find((x) => x.stepId === one.id && x.role === 'developer')!
  assert.match(opened.at(-1)!.sent[0], /^Implement step login\.1 of login/)
  await assert.rejects(call('start_work', { key: 'login' }), /Developer is still working/)
  await assert.rejects(call('start_step', { key: 'login' }), /login has no step waiting for Start: login\.1 is in progress/)

  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  store.updateTask(one.id, { status: 'done' })
  await assert.rejects(call('start_step', { key: 'login.1' }), /login\.1 is done; the current step of login is login\.2/)
  assert.equal(await call('start_step', { key: 'login.2' }), 'Started login.2.')
  assert.equal(store.task(two.id).status, 'in_progress')
  assert.notEqual(store.data.sessions.find((x) => x.stepId === two.id)?.id, dev.id)
  assert.deepEqual(logged(), ["login: chat: started login at the user's request", "login.2: chat: started step login.2 at the user's request"])
})

test('start_work: local_repos by name work in the main checkout (chat-keruie-robotamy-i-ahentamy.1)', async () => {
  const s = localSetup()
  const { call } = chatControls(s)
  assert.equal(await call('start_work', { key: 'login', local_repos: ['app'] }), 'Started login on login.1, locally in app.')
  assert.deepEqual(s.store.task(s.task.id).localRepos, [s.app])
})

test('start_work: says "locally" only for repos the step works on in the main checkout; a touched worktree fails the call', async () => {
  const s = localSetup()
  const { call } = chatControls(s)
  s.store.updateTask(s.step.id, { repos: [s.api] })
  assert.equal(await call('start_work', { key: 'login', local_repos: ['app'] }), 'Started login on login.1.', 'app is no repo of the step')
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  opened.at(-1)!.emit({ type: 'turn.done', ok: true })
  await tick()
  const tree = s.store.task(s.step.id).work!.repos[0].worktree
  git(tree, 'commit', '-q', '--allow-empty', '-m', 'wip')
  await assert.rejects(call('start_work', { key: 'login', local_repos: ['api'] }), /api already has work in its worktree \(commits on mag\/login-1\)/)
  git(tree, 'reset', '-q', '--hard', 'HEAD~1')
  assert.equal(await call('start_work', { key: 'login', local_repos: ['api'] }), 'Started login on login.1, locally in api.')
})

test('restart_review: the button\'s check (chat-keruie-robotamy-i-ahentamy.1)', async () => {
  const s = await developing()
  const { call, logged } = chatControls(s)
  await assert.rejects(call('restart_review', { key: 'login' }), /No step of this task has an open PR to review/)
  assert.deepEqual(logged(), [])
})

test('message_agent: the agent that worked last, or of the role; its session resumes with the text (chat-keruie-robotamy-i-ahentamy.1)', async () => {
  const s = await developing()
  const { store, task, step, session, live } = s
  const { call, logged } = chatControls(s)
  const groomer = store.createSession({ projectId: s.project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  groomer.items.push({ kind: 'user', text: 'old', at: 1 })
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  store.updateTask(task.id, { needsInput: 'Which schema?' })

  await assert.rejects(call('message_agent', { key: 'login', text: ' ' }), /text is required/)
  await assert.rejects(call('message_agent', { key: 'login', text: 'x', role: 'architect' }), /role must be one of developer, reviewer, groomer/)
  await assert.rejects(call('message_agent', { key: 'login', text: 'x', role: 'reviewer' }), /login has no reviewer to write to/)
  assert.equal(await call('message_agent', { key: 'login', text: 'Schema v2' }), 'Sent to the developer of login; it goes on with it.')
  assert.equal(live.sent.at(-1), 'Schema v2')
  assert.equal(session.status, 'running')
  assert.equal(store.task(task.id).needsInput, null, 'the answer clears the question')
  assert.deepEqual(session.items.at(-1), { kind: 'user', text: 'Schema v2', attachments: undefined, at: session.items.at(-1)!.at })

  assert.equal(s.orch.agentOf(step.id)?.id, session.id, 'a step: its own agents')
  assert.equal(s.orch.agentOf(task.id, 'groomer')?.id, groomer.id)
  assert.deepEqual(logged(), ["login: chat: wrote to the developer of login at the user's request"])
})

test('stop_agent: stops the agents of a work in a turn, as Stop (chat-keruie-robotamy-i-ahentamy.1)', async () => {
  const s = await developing()
  const { call, logged } = chatControls(s)
  assert.equal(s.session.status, 'running')
  assert.equal(await call('stop_agent', { key: 'login.1' }), 'Stopped the developer of login.1.')
  await tick()
  assert.notEqual(s.session.status, 'running')
  await assert.rejects(call('stop_agent', { key: 'login' }), /No agent of login is working/)
  assert.deepEqual(logged(), ["login.1: chat: stopped login.1 at the user's request"])
})

test('list_chats: every topic and top-level work and review, compact, with closed, owns and this (chat-archives-and-deletes-topics.1)', async () => {
  const s = setup()
  const { store, orch, project, task } = s
  const { call, topic } = chatControls(s)
  const owner = orch.newChat(project.id)
  store.updateTask(task.id, { ownerSessionId: owner })
  store.createTask({ projectId: project.id, title: 'one', type: 'dev', description: '', parentId: task.id, status: 'todo' })
  const review = store.createTask({ projectId: project.id, title: 'app#7: x', type: 'review', description: '', status: 'in_progress' })
  const mags = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Review app#7', reviewOf: review.id })
  mags.items.push({ kind: 'user', text: 'Review it', at: new Date(2026, 10, 5, 23, 30).getTime() })
  const gone = store.createTask({ projectId: project.id, title: 'Gone', type: 'dev', description: '' })
  await orch.cancel(gone.id, null)
  store.createSession({ projectId: project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  const other = store.createProject('q')
  store.createSession({ projectId: other.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })

  const rows = JSON.parse(await call('list_chats', {})) as Record<string, unknown>[]
  const row = (id: string) => rows.find((r) => r.id === id || r.key === id)!
  assert.equal(rows.length, 6, 'three topics of this project and three works: no steps, groomers or other projects')
  assert.deepEqual(row(topic.id), { id: topic.id, kind: 'topic', title: 'New topic', state: 'idle', closed: false, owns: [], lastAt: row(topic.id).lastAt, items: 0, this: true })
  assert.deepEqual(row(owner).owns, ['login'])
  assert.deepEqual([row(mags.id).owns, row(mags.id).lastAt, row(mags.id).items], [[review.key], '2026-11-05', 1])
  assert.deepEqual([row(review.key).kind, row(review.key).items, row(review.key).closed], ['review', 1, false])
  assert.deepEqual([row('login').kind, row('login').state, row('login').closed, 'doc' in row('login')], ['work', 'planning', false, false])
  assert.deepEqual([row(store.task(gone.id).key).state, row(store.task(gone.id).key).closed], ['canceled', true])
  assert.match(String(row('login').lastAt), /^\d{4}-\d{2}-\d{2}$/)
})

test('close_chats / delete_chats / restore_chat: each target on its own with its line; the calling topic and steps are refused (chat-archives-and-deletes-topics.1)', async () => {
  const s = setup()
  const { store, orch, project, task } = s
  const { call, topic } = chatControls(s)
  const architect = store.createSession({ projectId: project.id, taskId: null, role: 'architect', agent: 'claude-code', status: 'idle' })
  await assert.rejects(call('close_chats', { targets: ['x'] }, architect.id), /close_chats is for a project chat/)
  await assert.rejects(call('delete_chats', { targets: [] }), /targets is required/)

  const idle = orch.newChat(project.id)
  const owner = orch.newChat(project.id)
  store.updateTask(task.id, { ownerSessionId: owner })
  const step = store.createTask({ projectId: project.id, title: 'one', type: 'dev', description: '', parentId: task.id, status: 'todo' })
  const doneOwner = orch.newChat(project.id)
  const done = store.createTask({ projectId: project.id, title: 'Old fix', type: 'dev', description: '', status: 'done', ownerSessionId: doneOwner })
  const gone = store.createTask({ projectId: project.id, title: 'Gone', type: 'dev', description: '' })
  await orch.cancel(gone.id, null)
  const foreign = store.createSession({ projectId: store.createProject('q').id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })

  const closed = await call('close_chats', { targets: [idle, owner, 'login', done.key, topic.id, step.key, foreign.id, idle, gone.key] })
  assert.deepEqual(closed.split('\n'), [
    `${idle}: closed`,
    `${owner}: refused: it is the topic of login; close login instead`,
    'login: refused: login is planning; only a done work is closed this way (cancel the others)',
    `${done.key}: closed`,
    `${topic.id}: refused: this is the topic you are in; the user does it with the button`,
    `${step.key}: no such topic or work (${step.key} is a step: pass its work)`,
    `${foreign.id}: no such topic or work in this project`,
    `${idle}: already closed`,
    `${gone.key}: already closed`,
  ])
  assert.ok(store.session(idle).closedAt && store.task(done.id).closedAt)
  assert.equal(store.session(owner).closedAt ?? null, null)

  assert.equal(await call('restore_chat', { target: idle }), `${idle}: restored`)
  assert.equal(store.session(idle).closedAt, null)
  assert.equal(await call('restore_chat', { target: idle }), `${idle}: not closed`)
  assert.equal(await call('restore_chat', { target: gone.key }), `${gone.key}: refused: ${gone.key} is canceled; a canceled work cannot be restored`)

  // The calling topic owns a work: deleting that work would delete this topic with it.
  const mine = store.createTask({ projectId: project.id, title: 'Mine', type: 'dev', description: '', status: 'done', ownerSessionId: topic.id })
  const review = store.createTask({ projectId: project.id, title: 'app#7: x', type: 'review', description: '', status: 'in_progress' })
  const mags = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', reviewOf: review.id })
  const deleted = await call('delete_chats', { targets: [owner, mags.id, done.key, doneOwner, review.key, mine.key, topic.id] })
  assert.deepEqual(deleted.split('\n'), [
    `${owner}: refused: it is the topic of login; delete login instead`,
    `${mags.id}: refused: it is the topic of ${review.key}; delete ${review.key} instead`,
    `${done.key}: deleted`,
    `${doneOwner}: no such topic or work in this project`,
    `${review.key}: deleted`,
    `${mine.key}: refused: deleting it deletes this topic too; the user does it with the button`,
    `${topic.id}: refused: this is the topic you are in; the user does it with the button`,
  ])
  assert.ok(!store.data.tasks.some((t) => t.id === done.id || t.id === review.id))
  assert.ok(!store.data.sessions.some((x) => x.id === doneOwner || x.id === mags.id))
  assert.ok(store.data.tasks.some((t) => t.id === mine.id) && store.data.sessions.some((x) => x.id === topic.id || x.id === owner))
  assert.ok(store.data.sessions.some((x) => x.id === owner), 'the owner of an open work stays')
})

test('delete_chats: a work whose agent is in a turn is refused, the next target goes on (chat-archives-and-deletes-topics.1)', async () => {
  const s = await developing()
  const { call } = chatControls(s)
  const idle = s.orch.newChat(s.project.id)
  assert.deepEqual((await call('delete_chats', { targets: ['login', idle] })).split('\n'), ['login: refused: An agent of login is still working; stop it first, then delete the work', `${idle}: deleted`])
  assert.ok(s.store.data.tasks.some((t) => t.id === s.task.id))
})

test("branchChat: the new topic forks the parent's session on its first live turn; the parent stays (branch-this-topic-novyi-topik.1)", async () => {
  const { store, orch, project } = setup()
  const parentId = orch.newChat(project.id)
  // A topic without an agent session has nothing to fork.
  assert.throws(() => orch.branchChat(parentId), /no agent session to branch yet/)
  await orch.send(parentId, 'Design the login')
  const parentLive = opened.at(-1)!
  parentLive.emit({ type: 'session.started', nativeSessionId: 'parent-native' })
  parentLive.emit({ type: 'turn.done', ok: true })
  await tick()
  const parent = store.session(parentId)

  const id = orch.branchChat(parentId, ' And the logout? ')
  const topic = store.session(id)
  assert.deepEqual([topic.forkOf, topic.branchOf, topic.title, topic.role, topic.taskId], ['parent-native', parentId, 'Branch of Design the login', 'chat', null])
  await tick()
  const live = opened.at(-1)!
  assert.notEqual(live, parentLive)
  assert.deepEqual(live.sent, ['And the logout?'])
  assert.deepEqual([specs.at(-1)!.resumeId, specs.at(-1)!.forkSession], ['parent-native', true])
  assert.equal(topic.title, 'Branch of Design the login', 'the title is not replaced by the first message')
  assert.deepEqual(parent.items.filter((i) => i.kind === 'user').length, 1, 'the parent is untouched')

  // Its next process resumes the fork, not the parent.
  live.emit({ type: 'session.started', nativeSessionId: 'fork-native' })
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  live.close()
  await tick()
  await orch.send(id, 'more')
  assert.deepEqual([specs.at(-1)!.resumeId, specs.at(-1)!.forkSession], ['fork-native', false])

  // Without text the topic waits for the user's first message.
  const count = opened.length
  const empty = store.session(orch.branchChat(parentId))
  await tick()
  assert.deepEqual([empty.items.length, opened.length], [0, count])
})

test('branch_topic: a project topic branches itself into a new one; other sessions cannot (branch-this-topic-novyi-topik.1)', async () => {
  const s = setup()
  const tools = createTools(s.store, { branchChat: (id: string, text?: string) => s.orch.branchChat(id, text) } as ToolActions)
  const topic = s.store.createSession({ projectId: s.project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Auth' })
  const call = (args: Record<string, unknown>, sessionId = topic.id) => tools({ projectId: s.project.id, sessionId }, 'branch_topic', args)
  await assert.rejects(call({}), /no agent session to branch yet/)
  topic.nativeSessionId = 'auth-native'
  const architect = s.store.createSession({ projectId: s.project.id, taskId: null, role: 'architect', agent: 'claude-code', status: 'idle' })
  await assert.rejects(call({}, architect.id), /branch_topic is for a project topic/)
  assert.match(String(await call({})), /^Branched into a new topic "Branch of Auth" \(\w+\)\. Tell the user/)
  const branch = s.store.data.sessions.at(-1)!
  assert.deepEqual([branch.branchOf, branch.forkOf, branch.items.length], [topic.id, 'auth-native', 0])
})

/** Notice lines in a session's chat. */
const notices = (store: Store, sessionId: string) => store.session(sessionId).items.flatMap((i) => (i.kind === 'notice' ? [i.text] : []))

test('askOwner: an owner in a turn gets the question once the turn ends; unanswered after that, the user (ux-odna-rozmova-na-robotu.1)', async () => {
  const s = await developing()
  const { store, orch, task, step, live } = s
  const groomer = store.createSession({ projectId: s.project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  store.updateTask(task.id, { ownerSessionId: groomer.id })
  await orch.send(groomer.id, 'plan more')
  const owner = opened.at(-1)!
  assert.equal(orch.isRunning(groomer.id), true)

  assert.equal(orch.askOwner(step.id, 'Which schema?'), true, 'queued, not the user')
  assert.deepEqual([store.task(step.id).ownerQuestion, store.task(step.id).ownerQuestionQueued], ['Which schema?', true])
  assert.deepEqual(notices(store, groomer.id), ['login.1 asks: Which schema? (queued until this turn ends)'])
  assert.deepEqual(owner.sent, ['plan more'])
  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, null, 'the step waits for its owner')

  // The owner's turn ends: the question goes to it, and nobody asks the user yet.
  owner.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.match(owner.sent.at(-1)!, /^The developer of login\.1 \("s"\) asks: Which schema\?/)
  assert.equal(store.task(step.id).ownerQuestionQueued, false)
  assert.equal(store.task(task.id).needsInput, null)
  assert.equal(orch.isRunning(groomer.id), true)

  owner.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, 'login.1 asks: Which schema? (its owner did not answer)')
})

test('afterRun: a developer that stops without a PR or a question is told to continue once, then the user is asked (ux-odna-rozmova-na-robotu.1)', async () => {
  const s = await developing()
  const { store, orch, task, step, session, live } = s
  const groomer = store.createSession({ projectId: s.project.id, taskId: task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  store.updateTask(task.id, { ownerSessionId: groomer.id })
  store.updateTask(step.id, { autoFix: { ci: 0, conflict: 0, continue: 0 } })

  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, null)
  assert.match(live.sent.at(-1)!, /^You stopped without opening a PR or completing the step\. Continue: finish the step and open the PR \(set_pr\)/)
  assert.ok(session.items.some((i) => i.kind === 'job' && i.title === 'Continue'))
  assert.equal(session.status, 'running')
  assert.equal(store.task(step.id).autoFix!.continue, 1)

  live.emit({ type: 'turn.done', ok: true })
  await tick()
  assert.equal(store.task(task.id).needsInput, 'Developer stopped without opening a PR or completing the step')
  assert.deepEqual(notices(store, groomer.id), [
    'login.1: the developer stopped (Developer stopped without opening a PR or completing the step); mag told it to continue',
    'login.1: Developer stopped without opening a PR or completing the step; the user is asked',
  ])

  // The user's Restart: it may continue on its own again.
  store.updateTask(step.id, { repos: [] })
  await orch.develop(task.id)
  assert.equal(store.task(step.id).autoFix!.continue, 0)
  assert.equal(notices(store, groomer.id).at(-1), 'login.1 restarted: "s"')
})

test('afterRun: a failed developer is not continued: the user is asked (ux-odna-rozmova-na-robotu.1)', async () => {
  const s = await developing()
  const { store, task, step, live } = s
  store.updateTask(step.id, { autoFix: { ci: 0, conflict: 0, continue: 0 } })
  live.emit({ type: 'error', message: 'boom' })
  live.emit({ type: 'turn.done', ok: false })
  await tick()
  assert.equal(store.task(task.id).needsInput, 'Developer agent failed; check the chat')
  assert.equal(store.task(step.id).autoFix!.continue, 0)
})

/** A step whose developer is between turns, with an open PR, and a groomer that owns the work. gh fails: no review starts. */
async function withPr() {
  const s = await developing()
  const gh = fakeGh(s.dir)
  s.live.emit({ type: 'turn.done', ok: true })
  await tick()
  s.store.updateTask(s.task.id, { needsInput: null })
  const pr = { repo: s.dir, branch: 'mag/login-1', worktree: s.workDir, prUrl: 'https://github.com/a/b/pull/1', prState: 'open' as const, checkError: null }
  s.store.updateTask(s.step.id, { work: { ...s.store.task(s.step.id).work!, repos: [pr] } })
  const groomer = s.store.createSession({ projectId: s.project.id, taskId: s.task.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  s.store.updateTask(s.task.id, { ownerSessionId: groomer.id })
  /** The developer's turn ends (its auto-fix done); its end looks for PR heads to review, which fails here. */
  const turnEnds = async () => {
    s.live.emit({ type: 'turn.done', ok: true })
    await tick()
  }
  return { ...s, gh, groomer, turnEnds }
}

test('fixPr: conflicts in repos on different bases name the rebase commands of each repo', async () => {
  const s = await withPr()
  const { store, orch, step, live } = s
  try {
    const work = store.task(step.id).work!
    const conflict = { prState: 'open' as const, mergeable: 'conflict' as const }
    const repos = [
      { ...work.repos[0], ...conflict, base: 'master' },
      { ...work.repos[0], ...conflict, repo: '/r/web', worktree: join(work.dir, 'web'), prUrl: 'https://github.com/a/web/pull/2', base: 'main' },
    ]
    store.updateTask(step.id, { work: { ...work, repos } })
    assert.equal(orch.fixPr(step.id, 'conflict', '- b\n- web'), true)
    const sent = live.sent.at(-1)!
    assert.match(sent, /^Your PR has conflicts with their bases \(master, main\):/)
    assert.ok(sent.includes(`in ${repoWorkName(store.task(step.id).work!, repos[0])}: git fetch origin master, git rebase origin/master; in web: git fetch origin main, git rebase origin/main`), sent)
    assert.ok(!sent.includes('<base>'))
  } finally {
    s.gh.restore()
  }
})

test('fixPr: a failed CI goes back to the developer twice, then to the owner; cleared, it starts over (ux-odna-rozmova-na-robotu.1)', async () => {
  const s = await withPr()
  const { store, orch, task, step, live, groomer, turnEnds } = s
  try {
    assert.equal(orch.fixPr(step.id, 'ci', '- b: test (https://ci/1)'), true)
    assert.match(live.sent.at(-1)!, /^CI fails on your PR:\n- b: test \(https:\/\/ci\/1\)\nRead the failing logs/)
    assert.ok(store.session(s.session.id).items.some((i) => i.kind === 'job' && i.title === 'CI failed · try 1/2'))
    assert.equal(orch.fixPr(step.id, 'ci', '- b: test'), false, 'the developer is in a turn')
    await turnEnds()
    await until(() => orch.fixPr(step.id, 'ci', '- b: test'))
    await turnEnds()
    await until(() => !store.data.sessions.some((x) => x.stepId === step.id && orch.isRunning(x.id)))
    assert.deepEqual(store.task(step.id).autoFix, { ci: 2, conflict: 0, continue: 1 })

    // Third time: the owner decides, the developer is not resumed.
    const sent = live.sent.length
    await until(() => orch.fixPr(step.id, 'ci', '- b: test'))
    await tick()
    assert.equal(live.sent.length, sent)
    const owner = opened.at(-1)!
    assert.match(owner.sent.at(-1)!, /^mag could not settle this on its own for login\.1 \("s"\): its PR CI fails after 2 automatic fixes by its developer:\n- b: test\n[\s\S]*answer_developer\(step: "login\.1", text\)/)
    assert.equal(store.task(step.id).ownerQuestionFrom, 'mag')
    assert.equal(orch.fixPr(step.id, 'ci', '- b: test'), false, 'the owner has it')
    assert.deepEqual(notices(store, groomer.id), [
      'login.1: CI fails, the developer fixes it (try 1/2)',
      'login.1: CI fails, the developer fixes it (try 2/2)',
      'login.1: CI fails, not fixed after 2 tries',
    ])

    // The owner's answer: the developer goes on with it, and mag may try again after.
    owner.emit({ type: 'turn.done', ok: true })
    await tick()
    await orch.answerDeveloper(step.id, 'skip the flaky test')
    assert.match(live.sent.at(-1)!, /^The owner of the work decides on what mag could not fix on its own \(its PR CI fails after 2 automatic fixes by its developer:\): skip the flaky test$/)
    assert.equal(store.task(step.id).autoFix!.ci, 0)
    assert.equal(store.task(task.id).needsInput, null)

    store.updateTask(step.id, { autoFix: { ci: 2, conflict: 1, continue: 1 } })
    orch.clearedPr(step.id, ['ci'])
    assert.deepEqual(store.task(step.id).autoFix, { ci: 0, conflict: 1, continue: 1 })
  } finally {
    s.gh.restore()
  }
})

test('fixPr: a conflict asks for a rebase on fresh base; without an owner the user decides after the tries (ux-odna-rozmova-na-robotu.1)', async () => {
  const s = await withPr()
  const { store, orch, task, step, live, turnEnds } = s
  try {
    store.updateTask(task.id, { ownerSessionId: null })
    assert.equal(orch.fixPr(step.id, 'conflict', '- b: https://github.com/a/b/pull/1'), true)
    assert.match(live.sent.at(-1)!, /^Your PR has conflicts with main:\n- b: https:\/\/github\.com\/a\/b\/pull\/1\nThe branch policy: the step's branch is rebased on fresh origin\/main \(git fetch origin main, git rebase origin\/main\).*--force-with-lease, so nobody else's commits are lost/s)
    await turnEnds()
    store.updateTask(step.id, { autoFix: { ...store.task(step.id).autoFix!, conflict: 2 } })
    await until(() => orch.fixPr(step.id, 'conflict', '- b'))
    assert.equal(store.task(task.id).needsInput, 'login.1: PR conflicts with the base, not fixed after 2 tries')
    assert.equal(orch.fixPr(step.id, 'conflict', '- b'), false, 'the user has it')
  } finally {
    s.gh.restore()
  }
})

test('approveAndStart: approves and starts; the Start choice is remembered; start_work approves a work in planning (ux-odna-rozmova-na-robotu.1)', async () => {
  const s = localSetup()
  const { store, orch, project, task, step, app } = s
  store.updateTask(task.id, { status: 'planning' })
  await orch.approveAndStart(task.id, [app])
  assert.deepEqual([store.task(task.id).status, store.task(step.id).status], ['in_progress', 'in_progress'])
  assert.deepEqual(store.project(project.id).lastLocalRepos, [app])
  await assert.rejects(orch.approveAndStart(task.id), /login is in_progress; only a plan in planning is approved/)

  const t = setup()
  const { call, logged } = chatControls(t)
  t.store.createTask({ projectId: t.project.id, title: 'one', type: 'dev', description: '', parentId: t.task.id, status: 'todo', repos: [] })
  assert.equal(await call('start_work', { key: 'login' }), 'Approved and started login on login.1.')
  assert.equal(t.store.task(t.task.id).status, 'in_progress')
  assert.deepEqual(logged(), ["login: chat: approved and started login at the user's request"])
})

test('orientation: every role\'s system prompt says how mag works, who reads it and mag\'s words, as mag\'s frame (prompts-use-the-models-to.5)', async () => {
  const { store, orch, project, task } = setup()
  store.updateProject(project.id, { playbook: { plan: 'OUR PLANNING', step: 'OUR STEP', reviewRounds: 3 } })
  const frame = orientation(3)
  orch.groom(task.id)
  await tick()
  const groomer = specs.at(-1)!.appendSystemPrompt!
  assert.ok(groomer.includes(frame), 'groomer, even with its own plan section')
  assert.match(groomer, /it is all a fresh developer and a fresh\s+reviewer get besides the\s+code/)
  assert.ok(groomer.indexOf(frame) < groomer.indexOf('OUR PLANNING'), 'orientation before the job')
  await orch.send(orch.newChat(project.id), 'hi')
  const chat = specs.at(-1)!.appendSystemPrompt!
  assert.ok(chat.includes(frame), 'chat')
  assert.match(chat, /mag shows each text you write as a\s+message in the user's pane/, 'one answer per turn, with its reason')
  store.updateTask(task.id, { status: 'ready' })
  store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'todo', repos: [] })
  await orch.develop(task.id)
  const dev = specs.at(-1)!.appendSystemPrompt!
  assert.ok(dev.includes(frame), 'step developer')
  assert.match(dev, /You start fresh: what the owner planned is in the doc and the diagrams/)
  assert.match(frame, /up to 3 review rounds in a row; after that the user decides/, 'the project\'s round limit')
  for (const p of [groomer, chat, dev]) assert.doesNotMatch(p, /\b(NEVER|ALWAYS|MUST|IMPORTANT|ONLY|DO NOT)\b/, 'no ALL-CAPS emphasis')
})
