import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canRewindSession, lastReplyId, rewindBase, rewindCut, rewindPoint, type AgentSession, type ChatItem } from './index.ts'

const at = 0
/** Two turns: 0 user, 1 reply r1, 2 tool, 3 reply r2, 4 result | 5 user, 6 reply r3, 7 result. */
const items: ChatItem[] = [
  { kind: 'user', text: 'First', at },
  { kind: 'assistant', text: 'Looking', nativeId: 'r1', at },
  { kind: 'tool', id: 't1', name: 'Read', summary: '', ok: true, at },
  { kind: 'assistant', text: 'Done one', nativeId: 'r2', at },
  { kind: 'result', ok: true, at },
  { kind: 'user', text: 'Second', at },
  { kind: 'assistant', text: 'Done two', nativeId: 'r3', at },
  { kind: 'result', ok: true, at },
]

test('rewindCut: rewind keeps up to the turn’s last reply and forks there, from any reply of the turn', () => {
  assert.deepEqual(rewindCut(items, 1, 'rewind'), { keep: 4, at: 'r2' })
  assert.deepEqual(rewindCut(items, 3, 'rewind'), { keep: 4, at: 'r2' })
  assert.deepEqual(rewindCut(items, 6, 'rewind'), { keep: 7, at: 'r3' })
  assert.equal(rewindCut(items, 0, 'rewind'), null, 'not on a user message')
  assert.equal(rewindCut(items, 99, 'rewind'), null)
})

test('rewindCut: edit drops the message and what follows, forking at the reply before it; the first one starts over', () => {
  assert.deepEqual(rewindCut(items, 5, 'edit'), { keep: 4, at: 'r2', from: 5 })
  assert.deepEqual(rewindCut(items, 0, 'edit'), { keep: 0, at: null, from: 0 })
  assert.equal(rewindCut(items, 6, 'edit'), null, 'not on a reply')
})

test('rewindCut: retry is an edit of the message that started the reply’s turn, a job too', () => {
  assert.deepEqual(rewindCut(items, 6, 'retry'), { keep: 4, at: 'r2', from: 5 })
  assert.deepEqual(rewindCut(items, 1, 'retry'), { keep: 0, at: null, from: 0 })
  const job: ChatItem[] = [{ kind: 'job', title: 'Review', text: 'Do it', at }, { kind: 'assistant', text: 'ok', nativeId: 'r1', at }]
  assert.deepEqual(rewindCut(job, 1, 'retry'), { keep: 0, at: null, from: 0 })
  assert.equal(rewindCut([{ kind: 'assistant', text: 'hi', at }], 0, 'retry'), null, 'no message before it')
})

test('rewindCut: a reply it needs without a uuid (an older item) makes it unavailable', () => {
  const old = items.map((i) => (i.kind === 'assistant' && i.nativeId === 'r2' ? { kind: 'assistant' as const, text: i.text, at } : i))
  assert.equal(rewindCut(old, 1, 'rewind'), null)
  assert.equal(rewindCut(old, 5, 'edit'), null)
  assert.deepEqual(rewindCut(old, 6, 'rewind'), { keep: 7, at: 'r3' })
})

const topic = (over: Partial<AgentSession> = {}) =>
  ({ agent: 'claude-code', taskId: null, role: 'chat', parentId: null, items, nativeSessionId: 'n1', forkOf: null, ...over }) as AgentSession

test('rewindPoint: forks the transcript the items are in; the first message starts a session of its own', () => {
  assert.deepEqual(rewindPoint(topic(), 6, 'rewind'), { keep: 7, forkOf: 'n1', forkAt: 'r3' })
  assert.deepEqual(rewindPoint(topic(), 0, 'edit'), { keep: 0, forkOf: null, forkAt: null, from: 0 })
  // A rewind not sent yet: the old transcript, which the pending fork copies.
  assert.deepEqual(rewindPoint(topic({ nativeSessionId: null, forkOf: 'n0', forkAt: 'r9' }), 5, 'edit'), { keep: 4, forkOf: 'n0', forkAt: 'r2', from: 5 })
})

test('rewindPoint: a branch’s first message forks at the parent reply it was branched after; an older fork has no known start', () => {
  assert.deepEqual(rewindPoint(topic({ parentId: 'p', role: null, forkOf: 'pn', base: { at: 'p7' } }), 0, 'edit'), { keep: 0, forkOf: 'n1', forkAt: 'p7', from: 0 })
  assert.equal(rewindPoint(topic({ parentId: 'p', role: null, forkOf: 'pn' }), 0, 'edit'), null)
  assert.deepEqual(rewindBase({ forkOf: 'pn' }), {})
  assert.equal(rewindBase({ forkOf: null }), null)
  assert.equal(rewindBase({ forkOf: 'x', base: null }), null, 'a rewound session of its own stays its own')
})

test('canRewindSession: Claude Code topics and sessions under them; not Codex, a work’s sessions or a subagent', () => {
  assert.ok(canRewindSession(topic()))
  assert.ok(canRewindSession(topic({ role: null, parentId: 'p' })))
  assert.ok(!canRewindSession(topic({ agent: 'codex' })))
  assert.equal(rewindPoint(topic({ agent: 'codex' }), 6, 'rewind'), null)
  assert.ok(!canRewindSession(topic({ taskId: 't', role: 'developer' })))
  assert.ok(!canRewindSession(topic({ role: null, parentId: 'p', origin: 'subagent' })))
})

test('lastReplyId: the last reply’s uuid, none when it has none', () => {
  assert.equal(lastReplyId(items), 'r3')
  assert.equal(lastReplyId([...items, { kind: 'assistant', text: 'old', at }]), undefined)
  assert.equal(lastReplyId([]), undefined)
})
