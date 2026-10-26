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
