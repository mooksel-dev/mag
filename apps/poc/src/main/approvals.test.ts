import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from './approvals.ts'
import { Store } from './store.ts'

const TOOL = 'mcp__claude_ai_Cloudflare__execute'

function setup(mode: 'off' | 'ask' | 'auto' = 'ask') {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-approvals-')), 'db.json'))
  const project = store.createProject('p')
  store.updateProject(project.id, { integrations: { chat: { claude_ai_Cloudflare: mode } } })
  store.saveIntegrations([{ id: 'claude_ai_Cloudflare', name: 'Cloudflare' }])
  const session = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  const approvals = new Approvals(store, { pollMs: 30, graceMs: 30 })
  const approval = () => session.items.find((i) => i.kind === 'approval')
  return { store, session, approvals, approval }
}

const args = { tool_name: TOOL, input: { code: 'zones.list()' }, tool_use_id: 'tu1' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('request denies at once what is not an ask-mode integration', async () => {
  for (const mode of ['off', 'auto'] as const) {
    const { session, approvals } = setup(mode)
    const answer = JSON.parse(await approvals.request({ sessionId: session.id }, args))
    assert.equal(answer.behavior, 'deny')
    assert.equal(session.items.length, 0)
  }
  const { session, approvals } = setup()
  assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, { ...args, tool_name: 'WebFetch' })).behavior, 'deny')
  assert.equal(JSON.parse(await approvals.request({}, args)).behavior, 'deny', 'no session')
})

test('request answers pending on timeout and finds its item again on re-poll', async () => {
  const { session, approvals, approval } = setup()
  assert.deepEqual(JSON.parse(await approvals.request({ sessionId: session.id }, args)), { pending: true })
  assert.deepEqual(JSON.parse(await approvals.request({ sessionId: session.id }, args)), { pending: true })
  assert.equal(session.items.length, 1)
  assert.deepEqual({ ...approval(), at: 0 }, { kind: 'approval', id: 'tu1', tool: 'execute', server: 'Cloudflare', input: args.input, status: 'pending', at: 0 })
})

test('decide wakes the waiting poll: allow with the input, deny with a message, and logs it', async () => {
  const { store, session, approvals, approval } = setup()
  const pending = approvals.request({ sessionId: session.id }, args)
  await sleep(5)
  approvals.decide(session.id, 'tu1', true)
  assert.deepEqual(JSON.parse(await pending), { behavior: 'allow', updatedInput: args.input })
  assert.equal(approval()?.kind === 'approval' && approval()?.status, 'allowed')
  assert.equal(store.data.events.at(-1)?.text, 'Cloudflare · execute allowed')

  const second = approvals.request({ sessionId: session.id }, { ...args, tool_use_id: 'tu2' })
  await sleep(5)
  approvals.decide(session.id, 'tu2', false)
  assert.deepEqual(JSON.parse(await second), { behavior: 'deny', message: 'User denied' })
  assert.throws(() => approvals.decide(session.id, 'tu2', true), /already denied/)
})

test('a decision between polls is returned by the next poll', async () => {
  const { session, approvals } = setup()
  await approvals.request({ sessionId: session.id }, args)
  approvals.decide(session.id, 'tu1', true)
  assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, args)).behavior, 'allow')
})

test('a pending approval nobody polls expires; a hang-up stops the wait', async () => {
  const { session, approvals, approval } = setup()
  const hangup = new AbortController()
  const pending = approvals.request({ sessionId: session.id, signal: hangup.signal }, args)
  await sleep(5)
  hangup.abort()
  assert.deepEqual(JSON.parse(await pending), { pending: true })
  await sleep(50)
  assert.equal(approval()?.kind === 'approval' && approval()?.status, 'expired')
  assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, args)).behavior, 'deny')
})

test('a Bash call (a GitHub write that matched an ask rule) asks in chat and groomer sessions, with its command and no server; other roles stay denied (chat-publishes-to-github-prs.2)', async () => {
  const bash = { tool_name: 'Bash', input: { command: 'gh pr comment 4 -b "[mag] ok"', description: 'Comment' }, tool_use_id: 'tb1' }
  for (const role of ['chat', 'groomer'] as const) {
    const { store, session, approvals, approval } = setup()
    session.role = role
    const pending = approvals.request({ sessionId: session.id }, bash)
    await sleep(5)
    assert.deepEqual({ ...approval(), at: 0 }, { kind: 'approval', id: 'tb1', tool: 'Bash', input: bash.input, status: 'pending', at: 0 }, role)
    approvals.decide(session.id, 'tb1', true)
    assert.deepEqual(JSON.parse(await pending), { behavior: 'allow', updatedInput: bash.input })
    assert.equal(store.data.events.at(-1)?.text, 'Bash: gh pr comment 4 -b "[mag] ok" allowed')
  }
  for (const role of ['developer', 'reviewer', 'architect'] as const) {
    const { session, approvals } = setup()
    session.role = role
    assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, bash)).behavior, 'deny', role)
    assert.equal(session.items.length, 0, role)
  }
  // Only Bash: another built-in tool from a chat is not asked about.
  const { session, approvals } = setup()
  assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, { ...bash, tool_name: 'Edit' })).behavior, 'deny')
})

test("a push whose target is not named, or is a work's base, is denied without a card; a named branch asks (topics-a-tree-of-agent.1)", async () => {
  const { store, session, approvals } = setup()
  // Another work's repository has a base of its own.
  const work = store.createTask({ projectId: session.projectId, title: 'w', type: 'dev', description: '', status: 'in_progress' })
  store.updateTask(work.id, { work: { dir: '/w', feedbackSeenAt: 0, repos: [{ repo: '/r', worktree: '/w/r', branch: 'b', prUrl: null, prState: null, base: 'develop' }] } })
  const push = (command: string, id: string) => approvals.request({ sessionId: session.id }, { tool_name: 'Bash', input: { command }, tool_use_id: id })
  for (const [i, c] of ['git push', 'git push origin', 'git push origin HEAD', 'git -C /r push', 'git push origin develop'].entries()) {
    const answer = JSON.parse(await push(c, `p${i}`))
    assert.equal(answer.behavior, 'deny', c)
    assert.match(answer.message, /does not name the branch|pushes to the base branch develop/, c)
  }
  assert.equal(session.items.length, 0, 'no card for a blocked push')
  assert.deepEqual(JSON.parse(await push('git push -u origin fix-typo', 'ok')), { pending: true })
  assert.equal(session.items.length, 1)
})
