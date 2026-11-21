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
  assert.deepEqual({ ...approval(), at: 0 }, { kind: 'approval', id: 'tu1', tool: 'execute', server: 'Cloudflare', input: args.input, status: 'pending', at: 0, destination: { kind: 'other', target: 'Cloudflare', label: 'Cloudflare · execute' } })
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
    assert.deepEqual({ ...approval(), at: 0 }, { kind: 'approval', id: 'tb1', tool: 'Bash', input: bash.input, status: 'pending', at: 0, destination: { kind: 'github', target: '#4', label: 'GitHub #4' } }, String(role))
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
  assert.deepEqual({ ...approval(), at: 0 }, { kind: 'approval', id: 'w1', tool: 'execute', server: 'Cloudflare', input: { q: 1 }, status: 'pending', at: 0, destination: { kind: 'other', target: 'Cloudflare', label: 'Cloudflare · execute' } })
  void store
})

test('readsOnly: a read word and no write word', () => {
  for (const t of ['slack_search_public', 'slack_read_thread', 'find', 'list-collections', 'aggregate', 'get_design_context', 'getJiraIssue', 'searchConfluenceUsingCql'])
    assert.equal(readsOnly(t), true, t)
  for (const t of ['slack_send_message', 'slack_schedule_message', 'insert-many', 'update-many', 'drop-collection', 'use_figma', 'createConfluencePage', 'add_comment_to_issue', 'mystery'])
    assert.equal(readsOnly(t), false, t)
})

/** The request's answer, or 'waits' when it does not come within `ms` (a park would wait pollMs). */
const answerWithin = (p: Promise<string>, ms = 200) => Promise.race([p.then((t) => JSON.parse(t)), sleep(ms).then(() => 'waits' as const)])

function slackSetup(integrations?: Record<string, 'off' | 'ask' | 'reads' | 'auto'>) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-approvals-')), 'db.json'))
  const project = store.createProject('p')
  if (integrations) store.updateProject(project.id, { integrations: { chat: integrations } })
  store.saveIntegrations([{ id: 'claude_ai_Slack', name: 'Slack' }])
  const session = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'running' })
  const approvals = new Approvals(store, { pollMs: 1000, graceMs: 30 })
  const call = (tool_name: string, input: unknown, tool_use_id = tool_name) => approvals.request({ sessionId: session.id }, { tool_name, input, tool_use_id })
  return { store, project, session, approvals, call }
}

test('no silent hang: what needs no card is answered at once, without a card (publish-gate-for-every-outbound.1)', async () => {
  const { session, call } = slackSetup()
  const runs = [
    ['Bash', { command: 'rm /Users/u/.claude/projects/-x/memory/note.md' }],
    ['Edit', { file_path: '/Users/u/.claude/projects/-x/memory/MEMORY.md' }],
    ['Write', { file_path: '/elsewhere/a.md' }],
    ['Bash', { command: 'git push -u origin my-branch' }],
    ['Bash', { command: 'acli jira workitem view ABC-1' }],
    ['Bash', { command: 'gh api -X GET repos/o/r/pulls' }],
    ['mcp__claude_ai_Slack__slack_search_public', { query: 'q' }],
  ] as const
  for (const [tool, input] of runs) assert.deepEqual(await answerWithin(call(tool, input)), { behavior: 'allow', updatedInput: input }, `${tool} ${JSON.stringify(input)}`)
  // A developer's call it was not given is denied at once: an answer, not a wait.
  session.role = 'developer'
  session.parentId = 'topic'
  assert.equal((await answerWithin(call('Edit', { file_path: '/elsewhere/b.md' }, 'd1'))).behavior, 'deny')
  assert.equal(session.items.length, 0, 'no card for any of them')
})

test('every write of a chat asks with its destination by default: an integration with no mode is on reads, acli and gh writes park (publish-gate-for-every-outbound.1)', async () => {
  const { session, call } = slackSetup()
  const post = { channel_id: 'C0DATAREM', message: 'hi' }
  assert.equal(await answerWithin(call('mcp__claude_ai_Slack__slack_send_message', post, 's1')), 'waits')
  assert.equal(await answerWithin(call('Bash', { command: 'acli jira workitem comment create --key ABC-12 --body x' }, 'j1')), 'waits')
  assert.equal(await answerWithin(call('Bash', { command: 'gh issue comment 3 -R o/r -b x' }, 'g1')), 'waits')
  const cards = session.items.flatMap((i) => (i.kind === 'approval' ? [{ id: i.id, status: i.status, destination: i.destination }] : []))
  assert.deepEqual(cards, [
    { id: 's1', status: 'pending', destination: { kind: 'slack', target: 'C0DATAREM', label: 'Slack C0DATAREM' } },
    { id: 'j1', status: 'pending', destination: { kind: 'jira', target: 'ABC-12', label: 'Jira ABC-12' } },
    { id: 'g1', status: 'pending', destination: { kind: 'github', target: 'o/r#3', label: 'GitHub o/r#3' } },
  ])
})

test("a write to a destination on the project's auto list runs without a card; others still park; ask mode still asks for reads", async () => {
  const { store, project, session, call } = slackSetup({ claude_ai_Slack: 'reads' })
  store.updateProject(project.id, { publish: { auto: [{ kind: 'slack', target: '#data-removal' }, { kind: 'jira' }] } })
  const send = (channel: string, id: string) => call('mcp__claude_ai_Slack__slack_send_message', { channel, message: 'm' }, id)
  assert.deepEqual(await answerWithin(send('data-removal', 'a1')), { behavior: 'allow', updatedInput: { channel: 'data-removal', message: 'm' } })
  assert.equal((await answerWithin(call('Bash', { command: 'acli jira workitem create --project ABC --summary s' }, 'a2'))).behavior, 'allow')
  assert.equal(session.items.length, 0, 'no card for an auto destination')
  assert.equal(await answerWithin(send('general', 'p1')), 'waits')
  assert.equal(await answerWithin(call('Bash', { command: 'gh pr comment 4 -b x' }, 'p2')), 'waits', 'github is not on the list')
  assert.deepEqual(session.items.map((i) => i.kind === 'approval' && i.id), ['p1', 'p2'])
  store.updateProject(project.id, { integrations: { chat: { claude_ai_Slack: 'ask' } } })
  assert.equal(await answerWithin(call('mcp__claude_ai_Slack__slack_search_public', { query: 'q' }, 'r1')), 'waits', 'ask: each call waits')
  const read = session.items.find((i) => i.kind === 'approval' && i.id === 'r1')
  assert.equal(read?.kind === 'approval' && read.destination, undefined, 'a read has no destination')
})

test("deny with the user's note: the agent gets it, the item keeps it", async () => {
  const { session, approvals, call } = slackSetup()
  const pending = call('mcp__claude_ai_Slack__slack_send_message', { channel: 'x' }, 'n1')
  await sleep(5)
  approvals.decide(session.id, 'n1', false, '  revise: a blank line before the header ')
  assert.deepEqual(JSON.parse(await pending), { behavior: 'deny', message: 'User denied: revise: a blank line before the header' })
  const item = session.items[0]
  assert.equal(item.kind === 'approval' && item.note, 'revise: a blank line before the header')
})
