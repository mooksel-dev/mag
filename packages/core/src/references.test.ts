import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatTranscript, referencesBlock, resolveRef, summaryStale, uniqueRefs, type AgentSession, type ChatSummary, type Task } from './index.ts'

const task = (patch: Partial<Task> = {}): Task => ({
  id: 't', projectId: 'p', key: 'W-1', parentId: null, title: 'Fix login', type: 'dev', status: 'done', description: '', rank: 0,
  needsInput: null, work: null, nextSubNo: 1, createdAt: 5, updatedAt: 5, ...patch,
})
const topic = (patch: Partial<AgentSession> = {}): AgentSession => ({
  id: 's', projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', title: 'Login bug', titleGenerated: true, createdAt: 1,
  items: [
    { kind: 'user', text: 'Why does login fail?', at: 10 },
    { kind: 'tool', id: 'x', name: 'Bash', summary: 'ls\n-la', at: 11 },
    { kind: 'assistant', text: 'The token expires early.', at: 12 },
    { kind: 'result', ok: true, at: 13 },
  ],
  ...patch,
})
const summary: ChatSummary = { title: 'Login token', gist: ['Token expired early', 'Fixed the clock skew'], decisions: ['Refresh 1 min before'], open: ['Mobile?'], keywords: ['auth.ts'] }

test('resolveRef: title, key and archived of a topic and a task; null when gone', () => {
  const t = resolveRef({ kind: 'task', id: 't' }, [task({ closedAt: 9 })], [])
  assert.deepEqual({ title: t?.title, key: t?.key, archived: t?.archived }, { title: 'Fix login', key: 'W-1', archived: true })
  const s = resolveRef({ kind: 'topic', id: 's' }, [], [topic()])
  assert.deepEqual({ title: s?.title, key: s?.key, archived: s?.archived }, { title: 'Login bug', key: null, archived: false })
  assert.equal(resolveRef({ kind: 'topic', id: 'gone' }, [], [topic()]), null)
})

test('uniqueRefs keeps the first of each and drops malformed ones', () => {
  assert.deepEqual(uniqueRefs([{ kind: 'topic', id: 'a' }, { kind: 'task', id: 'a' }, { kind: 'topic', id: 'a' }, { kind: 'x', id: 'b' }, { kind: 'task' }, null]), [{ kind: 'topic', id: 'a' }, { kind: 'task', id: 'a' }])
  assert.deepEqual(uniqueRefs('nope'), [])
})

test('referencesBlock: summary, archived mark and the read_chat id; title only without a summary; gone refs skipped', () => {
  const block = referencesBlock(
    [{ kind: 'topic', id: 's' }, { kind: 'task', id: 't' }, { kind: 'task', id: 'gone' }],
    [task({ status: 'canceled' })],
    [topic({ summary, summaryAt: 12, closedAt: 20 })],
  )
  assert.match(block, /## Topic: Login bug \(archived\)\nread_chat id: s\nToken expired early\nFixed the clock skew\nDecisions:\n- Refresh 1 min before\nOpen questions:\n- Mobile\?\nKeywords: auth\.ts/)
  assert.match(block, /## Work W-1: Fix login \(archived\)\nread_chat id: W-1\n\(no summary yet\)/)
  assert.doesNotMatch(block, /gone/)
  assert.equal(referencesBlock([{ kind: 'task', id: 'gone' }], [], []), '')
})

test('summaryStale: no summary or an older one, archived or not; nothing said, nothing to do', () => {
  assert.equal(summaryStale(topic(), []), true)
  assert.equal(summaryStale(topic({ summary, summaryAt: 12 }), []), false)
  assert.equal(summaryStale(topic({ summary, summaryAt: 10 }), []), true)
  assert.equal(summaryStale(topic({ items: [] }), []), false)
})

test('chatTranscript: a topic, tool calls on one line, with time', () => {
  const { text, next } = chatTranscript(topic(), [])
  assert.equal(next, null)
  assert.match(text, /^Topic: Login bug\n\n\[1970-01-01 00:00\] User: Why does login fail\?\n\n\[1970-01-01 00:00\] tool Bash ls -la\n\n\[1970-01-01 00:00\] Assistant: The token expires early\.$/)
})

test('chatTranscript: a work is its doc, then its owner topic', () => {
  const { text } = chatTranscript(task({ ownerSessionId: 's' }), [topic()], '# Plan\nDo it')
  assert.match(text, /^Work W-1: Fix login \(done\)\n\nDocument:\n# Plan\nDo it\n\nConversation:\n\[.*\] User: Why does login fail\?/)
})

test('chatTranscript pages: next until the end, the pages make up the whole', () => {
  const t = topic()
  const whole = chatTranscript(t, []).text
  let offset: number | null = 0
  let joined = ''
  let pages = 0
  while (offset !== null) {
    const page = chatTranscript(t, [], '', offset, 30)
    joined += page.text
    offset = page.next
    pages++
  }
  assert.equal(joined, whole)
  assert.equal(pages, Math.ceil(whole.length / 30))
})
