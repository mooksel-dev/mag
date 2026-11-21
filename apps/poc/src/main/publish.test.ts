import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem } from '@mag/core'
import { Approvals } from './approvals.ts'
import { Store } from './store.ts'
import { createPublish, type RunShell } from './tools.ts'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

/** A store with a chat session, a real Approvals and a fake shell that records what it ran. */
function setup(role: 'chat' | 'developer' | 'reviewer' = 'chat', exit: number | null = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'mag-publish-'))
  const store = new Store(join(dir, 'db.json'))
  const project = store.createProject('p')
  store.updateProject(project.id, { repos: [dir], integrations: { chat: { claude_ai_Slack: 'reads' }, developer: { claude_ai_Slack: 'reads' } } })
  store.saveIntegrations([{ id: 'claude_ai_Slack', name: 'Slack' }])
  const session = store.createSession({ projectId: project.id, taskId: null, role, agent: 'codex', status: 'running' })
  const approvals = new Approvals(store, { pollMs: 20, graceMs: 20 })
  const ran: { command: string; cwd: string }[] = []
  const shell: RunShell = (command, cwd, onOutput) => {
    ran.push({ command, cwd })
    onOutput(`ran: ${command}\n`)
    return { done: Promise.resolve({ code: exit }), stop: () => {} }
  }
  const publish = createPublish(store, approvals, shell)
  const ctx = { sessionId: session.id, projectId: project.id }
  const call = (args: Record<string, unknown>) => publish(ctx, 'publish', { why: 'the weekly summary', call_id: 'c1', ...args })
  const cards = () => session.items.filter((i): i is ApprovalItem => i.kind === 'approval')
  return { dir, store, project, session, approvals, ran, call, cards, ctx }
}

const COMMENT = 'gh pr comment 4 -R acme/api -b "[mag] Looks good"'

test('publish: a command parks the Publish card, runs in main after Allow and answers its output, once', async () => {
  const { dir, approvals, session, ran, call, cards } = setup()
  assert.deepEqual(JSON.parse(await call({ destination: 'GitHub', command: COMMENT })), { pending: true })
  assert.equal(ran.length, 0, 'nothing runs before the Allow')
  assert.deepEqual(cards().map((c) => ({ id: c.id, tool: c.tool, input: c.input, destination: c.destination, status: c.status })), [
    { id: 'c1', tool: 'Bash', input: { command: COMMENT, description: 'the weekly summary' }, destination: { kind: 'github', target: 'acme/api#4', label: 'GitHub acme/api#4' }, status: 'pending' },
  ])
  const answer = call({ destination: 'GitHub', command: COMMENT })
  approvals.decide(session.id, 'c1', true)
  assert.equal(await answer, `ran: ${COMMENT}`)
  assert.deepEqual(ran, [{ command: COMMENT, cwd: dir }], 'in the project repository by default')
  assert.equal(await call({ destination: 'GitHub', command: COMMENT }), `ran: ${COMMENT}`)
  assert.equal(ran.length, 1, 'a repeated poll answers the same run')
  assert.equal(cards().length, 1)
})

test("publish: a deny answers the user's note; nothing runs", async () => {
  const { approvals, session, ran, call } = setup()
  const answer = call({ destination: 'GitHub', command: COMMENT })
  await new Promise((r) => setTimeout(r, 5))
  approvals.decide(session.id, 'c1', false, 'drop the second paragraph')
  await assert.rejects(answer, /User sent it back to revise: drop the second paragraph\nRewrite it and ask again\./)
  assert.equal(ran.length, 0)
})

test('publish: a scripted write takes the destination the agent names; a known CLI write its own', async () => {
  const { call, cards } = setup()
  await call({ destination: 'Slack #general', command: "curl -X POST -d 'text=hi' https://hooks.slack.com/x", call_id: 'a' })
  await call({ destination: 'Slack #general', command: 'acli jira workitem comment create --key ABC-12 --body hi', call_id: 'b' })
  assert.deepEqual(
    cards().map((c) => c.destination),
    [
      { kind: 'slack', target: '#general', label: 'Slack #general' },
      { kind: 'jira', target: 'ABC-12', label: 'Jira ABC-12' },
    ],
  )
})

test('publish: a known write the project publishes unasked runs at once; a named-only one still asks', async () => {
  const { store, project, ran, call, cards } = setup()
  store.updateProject(project.id, { publish: { auto: [{ kind: 'github' }, { kind: 'slack' }] } })
  assert.equal(await call({ destination: 'GitHub', command: COMMENT }), `ran: ${COMMENT}`)
  assert.equal(cards().length, 0, 'no card')
  assert.deepEqual(JSON.parse(await call({ destination: 'Slack #general', command: 'curl -X POST https://hooks.slack.com/x', call_id: 'c2' })), { pending: true })
  assert.equal(ran.length, 1)
})

test('publish: a push to a base branch, a reviewer, and a call without why or with both command and payload are refused', async () => {
  const { call, cards } = setup()
  await assert.rejects(call({ destination: 'GitHub', command: 'git push origin main' }), /main/)
  await assert.rejects(call({ destination: 'GitHub', command: COMMENT, why: ' ' }), /why is required/)
  await assert.rejects(call({ destination: '', command: COMMENT }), /destination is required/)
  await assert.rejects(call({ destination: 'GitHub', command: COMMENT, payload: { tool: 'x', input: {} } }), /exactly one of command or payload/)
  await assert.rejects(call({ destination: 'GitHub' }), /exactly one of command or payload/)
  await assert.rejects(call({ destination: 'GitHub', command: COMMENT, cwd: 'relative/dir' }), /cwd must be an existing absolute directory/)
  assert.equal(cards().length, 0)
  await assert.rejects(setup('reviewer').call({ destination: 'GitHub', command: COMMENT }), /not available to the reviewer/)
})

test('publish: a command that fails answers its exit and output as an error', async () => {
  const { approvals, session, call } = setup('chat', 1)
  const answer = call({ destination: 'GitHub', command: COMMENT })
  await new Promise((r) => setTimeout(r, 5))
  approvals.decide(session.id, 'c1', true)
  await assert.rejects(answer, /Published command failed \(exit 1\):\nran: gh pr comment/)
})

test('publish: a card nobody answers expires, and the call says so', async () => {
  const { call, cards } = setup()
  assert.deepEqual(JSON.parse(await call({ destination: 'GitHub', command: COMMENT })), { pending: true })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(cards()[0].status, 'expired')
  await assert.rejects(call({ destination: 'GitHub', command: COMMENT }), /expired before the user answered/)
})

test("publish: a payload's Allow lets exactly that call of the agent's own tool run once without a second card; a Claude Code developer gets the same card", async () => {
  const { approvals, session, ran, call, cards, ctx } = setup('developer')
  session.agent = 'claude-code'
  const payload = { tool: 'mcp__claude_ai_Slack__slack_send_message', input: { channel_id: 'C0123456', text: 'hi' } }
  assert.deepEqual(JSON.parse(await call({ destination: 'Slack', payload })), { pending: true })
  assert.deepEqual(cards()[0].destination, { kind: 'slack', target: 'C0123456', label: 'Slack C0123456' })
  assert.equal(cards()[0].server, 'Slack')
  const answer = call({ destination: 'Slack', payload })
  approvals.decide(session.id, 'c1', true)
  assert.match(await answer, /Allowed by the user\. Call mcp__claude_ai_Slack__slack_send_message now with exactly this input, once/)
  assert.equal(ran.length, 0, 'mag runs no shell for a payload')
  const own = { tool_name: payload.tool, input: payload.input, tool_use_id: 't1' }
  assert.deepEqual(JSON.parse(await approvals.request(ctx, own)), { behavior: 'allow', updatedInput: payload.input })
  assert.equal(cards().length, 1, 'no second card')
  assert.deepEqual(JSON.parse(await approvals.request(ctx, { ...own, tool_use_id: 't2' })), { pending: true }, 'the grant is good for one run')
  assert.equal(cards().length, 2)
})
