import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readsOnly } from '@mag/core'
import { Approvals } from './approvals.ts'
import { Store } from './store.ts'
import { mirrorItems } from './item-mirror.test-util.ts'

const TOOL = 'mcp__claude_ai_Cloudflare__execute'

function setup(mode: 'off' | 'ask' | 'reads' | 'auto' = 'ask') {
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

test('request denies at once an integration not in ask mode; another tool of a chat runs at once, of a developer stays denied', async () => {
  for (const mode of ['off', 'auto'] as const) {
    const { session, approvals } = setup(mode)
    const answer = JSON.parse(await approvals.request({ sessionId: session.id }, args))
    assert.equal(answer.behavior, 'deny')
    assert.equal(session.items.length, 0)
  }
  const { session, approvals } = setup()
  assert.deepEqual(JSON.parse(await approvals.request({ sessionId: session.id }, { ...args, tool_name: 'WebFetch' })), { behavior: 'allow', updatedInput: args.input })
  assert.equal(session.items.length, 0, 'no card')
  session.role = 'developer'
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
  const shown = mirrorItems(store, session.id)
  const pending = approvals.request({ sessionId: session.id }, args)
  await sleep(5)
  approvals.decide(session.id, 'tu1', true)
  assert.deepEqual(JSON.parse(await pending), { behavior: 'allow', updatedInput: args.input })
  assert.equal(approval()?.kind === 'approval' && approval()?.status, 'allowed')
  assert.deepEqual(shown(), session.items, 'an open chat shows the card and its answer')
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
  const { store, session, approvals, approval } = setup()
  const shown = mirrorItems(store, session.id)
  const hangup = new AbortController()
  const pending = approvals.request({ sessionId: session.id, signal: hangup.signal }, args)
  await sleep(5)
  hangup.abort()
  assert.deepEqual(JSON.parse(await pending), { pending: true })
  await sleep(50)
  assert.equal(approval()?.kind === 'approval' && approval()?.status, 'expired')
  assert.deepEqual(shown(), session.items, 'an open chat shows it expired')
  assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, args)).behavior, 'deny')
})

test('a Bash call (a GitHub write that matched an ask rule) asks in chat and groomer sessions, with its command and no server; other roles stay denied (chat-publishes-to-github-prs.2)', async () => {
  const bash = { tool_name: 'Bash', input: { command: 'gh pr comment 4 -b "[mag] ok"', description: 'Comment' }, tool_use_id: 'tb1' }
  // null: a general session under a topic asks as a topic does (topics-a-tree-of-agent.2).
  for (const role of ['chat', 'groomer', null] as const) {
    const { store, session, approvals, approval } = setup()
    session.role = role
    const pending = approvals.request({ sessionId: session.id }, bash)
    await sleep(5)
    assert.deepEqual({ ...approval(), at: 0 }, { kind: 'approval', id: 'tb1', tool: 'Bash', input: bash.input, status: 'pending', at: 0 }, String(role))
    approvals.decide(session.id, 'tb1', true)
    assert.deepEqual(JSON.parse(await pending), { behavior: 'allow', updatedInput: bash.input })
    assert.equal(store.data.events.at(-1)?.text, 'Bash: gh pr comment 4 -b "[mag] ok" allowed')
  }
  // A developer or reviewer under a topic is denied as theirs are (its run has no ask rules).
  for (const role of ['developer', 'reviewer', 'architect'] as const) {
    const { session, approvals } = setup()
    session.role = role
    session.parentId = 'topic'
    assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, bash)).behavior, 'deny', role)
    assert.equal(session.items.length, 0, role)
  }
  // What does not publish runs at once, as Claude Code would for the user: an edit or a command outside the repo.
  const { session, approvals } = setup()
  const edit = { tool_name: 'Edit', input: { file_path: '/elsewhere/x.md' }, tool_use_id: 'te' }
  assert.deepEqual(JSON.parse(await approvals.request({ sessionId: session.id }, edit)), { behavior: 'allow', updatedInput: edit.input })
  for (const command of ['rm /home/u/.claude/memory/x.md', 'gh pr create --title t', 'gh pr view 4 --json state', 'gh api repos/o/r/pulls/4'])
    assert.equal(JSON.parse(await approvals.request({ sessionId: session.id }, { ...bash, input: { command } })).behavior, 'allow', command)
  for (const command of ['gh api -X POST repos/o/r/issues/4/comments -f body=x', 'gh -R o/r pr review 4 --approve', 'gh pr edit 4 --title t'])
    assert.deepEqual(JSON.parse(await approvals.request({ sessionId: session.id }, { ...bash, input: { command }, tool_use_id: command })), { pending: true }, command)
  assert.equal(session.items.length, 3, 'a card for each post only')
})

test("a push whose target is not named, or is a work's base, is denied without a card; a named branch runs at once (topics-a-tree-of-agent.1)", async () => {
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
  assert.deepEqual(JSON.parse(await push('git push -u origin fix-typo', 'ok')), { behavior: 'allow', updatedInput: { command: 'git push -u origin fix-typo' } })
  assert.equal(session.items.length, 0, 'no card for a push of its branch')
})

test('reads: a read of the integration runs at once, a write waits on its card; readsOnly tells them by name', async () => {
  const { store, session, approvals, approval } = setup('reads')
  const call = (tool: string, id: string) => approvals.request({ sessionId: session.id }, { tool_name: `mcp__claude_ai_Cloudflare__${tool}`, input: { q: 1 }, tool_use_id: id })
  assert.deepEqual(JSON.parse(await call('search_docs', 'r1')), { behavior: 'allow', updatedInput: { q: 1 } })
  assert.equal(session.items.length, 0, 'no card for a read')
  assert.deepEqual(JSON.parse(await call('execute', 'w1')), { pending: true })
  assert.deepEqual({ ...approval(), at: 0 }, { kind: 'approval', id: 'w1', tool: 'execute', server: 'Cloudflare', input: { q: 1 }, status: 'pending', at: 0 })
  void store
})

test('readsOnly: a read word and no write word', () => {
  for (const t of ['slack_search_public', 'slack_read_thread', 'find', 'list-collections', 'aggregate', 'get_design_context', 'getJiraIssue', 'searchConfluenceUsingCql'])
    assert.equal(readsOnly(t), true, t)
  for (const t of ['slack_send_message', 'slack_schedule_message', 'insert-many', 'update-many', 'drop-collection', 'use_figma', 'createConfluencePage', 'add_comment_to_issue', 'mystery'])
    assert.equal(readsOnly(t), false, t)
})
