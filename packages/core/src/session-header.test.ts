import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyItemEvent, digestOf, DIGEST_TEXT_MAX, sessionDigest, sessionHeader, type AgentSession, type ChatItem } from './index.ts'

const items: ChatItem[] = [
  { kind: 'user', text: `Review the PR https://x/pull/1 ${'y'.repeat(400)}`, at: 1 },
  { kind: 'tool', id: 't', name: 'Bash', summary: 'ls', at: 2 },
  { kind: 'approval', id: 'a1', tool: 'Bash', input: {}, status: 'pending', at: 3 },
  { kind: 'approval', id: 'a2', tool: 'Bash', input: {}, status: 'allowed', at: 4 },
  { kind: 'integration', id: 'i1', integrationId: 'slack', server: 'Slack', role: 'chat', why: '', status: 'off', at: 5 },
  { kind: 'assistant', text: 'done', at: 6 },
  { kind: 'user', text: 'z'.repeat(1000), at: 6.5 },
  { kind: 'result', ok: true, costUsd: 0.25, at: 7 },
  { kind: 'notice', text: 'n', at: 8 },
  { kind: 'result', ok: true, costUsd: 0.5, at: 9 },
]

test('digestOf: what windows read across sessions without their items (p0-fast-safe-store-no.1)', () => {
  const d = digestOf(items)
  assert.equal(d.itemCount, 10)
  assert.equal(d.lastItemAt, 9)
  assert.deepEqual(d.pendingApprovals.map((a) => a.id), ['a1'])
  assert.deepEqual(d.offIntegrations.map((i) => i.id), ['i1'])
  assert.equal(d.costUsd, 0.75)
  assert.deepEqual([d.lastTool?.id, d.lastNotice?.text, d.lastMessage?.at, d.lastReply?.text], ['t', 'n', 6.5, 'done'])
  assert.equal(d.lastMessage?.kind === 'user' && d.lastMessage.text.length, DIGEST_TEXT_MAX, 'a long text is cut')
  assert.equal(items[6].kind === 'user' && items[6].text.length, 1000, 'the item itself stays')
  assert.equal(d.opening?.length, DIGEST_TEXT_MAX)
  assert.ok(d.opening?.startsWith('Review the PR https://x/pull/1 '))
  assert.deepEqual(digestOf([]), { itemCount: 0, lastItemAt: null, pendingApprovals: [], offIntegrations: [], costUsd: 0, lastTool: null, lastNotice: null, lastMessage: null, lastReply: null, opening: null })
})

test('sessionHeader drops the items and the undo’s copy of them; sessionDigest reads either shape the same (p0-fast-safe-store-no.1)', () => {
  const s = { id: 's', items, rewound: { items, nativeSessionId: null, forkOf: null, forkAt: null } } as unknown as AgentSession
  const h = sessionHeader(s)
  assert.equal('items' in h, false)
  assert.equal(h.rewound, true)
  const fromItems = sessionDigest(s)
  for (const [k, v] of Object.entries(fromItems)) assert.deepEqual(sessionDigest(h)[k as keyof typeof fromItems], v, k)
})

test('applyItemEvent: appends, replaces, cuts; an item past the end is dropped (p0-fast-safe-store-no.1)', () => {
  const a: ChatItem = { kind: 'notice', text: 'a', at: 1 }
  const b: ChatItem = { kind: 'notice', text: 'b', at: 2 }
  let list = applyItemEvent([], { sid: 's', n: 0, item: a })
  list = applyItemEvent(list, { sid: 's', n: 1, item: b })
  assert.deepEqual(list, [a, b])
  assert.deepEqual(applyItemEvent(list, { sid: 's', n: 0, item: b }), [b, b])
  assert.deepEqual(applyItemEvent(list, { sid: 's', truncate: 1 }), [a])
  assert.equal(applyItemEvent(list, { sid: 's', truncate: 5 }), list)
  assert.equal(applyItemEvent(list, { sid: 's', n: 3, item: a }), list)
})
