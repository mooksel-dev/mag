import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isArchived, needsSummary, parseSummary, summaryCovers, summaryPrompt, summarySource, trimMiddle, type AgentSession, type ChatSummary, type Task } from './index.ts'

const task = (patch: Partial<Task> = {}): Task => ({
  id: 't', projectId: 'p', key: 'W-1', parentId: null, title: 'Fix login', type: 'dev', status: 'done', description: '', rank: 0,
  needsInput: null, work: null, nextSubNo: 1, createdAt: 5, updatedAt: 5, ...patch,
})
const topic = (patch: Partial<AgentSession> = {}): AgentSession => ({
  id: 's', projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', title: 'Login bug', createdAt: 1,
  items: [
    { kind: 'user', text: 'Why does login fail?', at: 10 },
    { kind: 'tool', id: 'x', name: 'Bash', summary: 'ls', at: 11 },
    { kind: 'assistant', text: 'The token expires early.', at: 12 },
    { kind: 'result', ok: true, at: 13 },
  ],
  ...patch,
})
const summary: ChatSummary = { title: 'Login token', gist: ['Token expired early'], decisions: [], open: [], keywords: [] }

test('isArchived: a closed topic; a closed or canceled top-level task; never a step', () => {
  assert.equal(isArchived(topic()), false)
  assert.equal(isArchived(topic({ closedAt: 1 })), true)
  assert.equal(isArchived(task()), false)
  assert.equal(isArchived(task({ closedAt: 1 })), true)
  assert.equal(isArchived(task({ status: 'canceled' })), true)
  assert.equal(isArchived(task({ parentId: 'w', status: 'canceled' })), false)
})

test('summaryCovers: the last message of a topic, of a work its owner topic, else the work creation', () => {
  assert.equal(summaryCovers(topic(), []), 12)
  assert.equal(summaryCovers(task({ ownerSessionId: 's' }), [topic()]), 12)
  assert.equal(summaryCovers(task({ ownerSessionId: 'gone' }), [topic()]), 5)
  assert.equal(summaryCovers(topic({ items: [] }), []), 0)
})

test('needsSummary: archived and not covered; an empty topic never', () => {
  assert.equal(needsSummary(topic(), []), false, 'open')
  assert.equal(needsSummary(topic({ closedAt: 20 }), []), true)
  assert.equal(needsSummary(topic({ closedAt: 20, summary, summaryAt: 12 }), []), false, 'covers the last message')
  assert.equal(needsSummary(topic({ closedAt: 20, summary, summaryAt: 10 }), []), true, 'newer messages')
  assert.equal(needsSummary(topic({ closedAt: 20, summary: null, summaryAt: 12 }), []), true)
  assert.equal(needsSummary(topic({ closedAt: 20, items: [{ kind: 'notice', text: 'x', at: 3 }] }), []), false, 'nothing said')
  assert.equal(needsSummary(task({ status: 'canceled' }), []), true, 'a work without an owner topic has its doc')
  assert.equal(needsSummary(task({ closedAt: 9, ownerSessionId: 's', summary, summaryAt: 12 }), [topic()]), false)
})

test('summarySource: topic messages without tools; a work is its doc, then its owner topic', () => {
  const t = summarySource(topic(), [])
  assert.match(t, /^Topic: Login bug/)
  assert.match(t, /User: Why does login fail\?\n\nAssistant: The token expires early\./)
  assert.doesNotMatch(t, /Bash/)
  const w = summarySource(task({ ownerSessionId: 's' }), [topic()], '# Plan\nRotate tokens')
  assert.ok(w.indexOf('Work W-1: Fix login') < w.indexOf('Rotate tokens') && w.indexOf('Rotate tokens') < w.indexOf('User: Why'))
  assert.match(summarySource(task({ type: 'review' }), []), /^Review W-1/)
})

test('trimMiddle: keeps the start and the end within the limit', () => {
  const text = 'a'.repeat(100) + 'b'.repeat(100)
  const out = trimMiddle(text, 50)
  assert.ok(out.length <= 50)
  assert.ok(out.startsWith('aaa') && out.endsWith('bbb') && out.includes('[…]'))
  assert.equal(trimMiddle('short', 50), 'short')
})

test('summaryPrompt: asks for JSON around the source', () => {
  const p = summaryPrompt('SOURCE')
  assert.match(p, /JSON only/)
  assert.match(p, /<conversation>\nSOURCE\n<\/conversation>/)
})

test('parseSummary: JSON, fenced or with text around it; strings trimmed; a gist string split into lines', () => {
  const ok = { title: ' Login token ', gist: ['Token expired', ' '], decisions: ['Rotate'], open: [], keywords: ['auth.ts', 'PR #12'] }
  assert.deepEqual(parseSummary(JSON.stringify(ok)), { title: 'Login token', gist: ['Token expired'], decisions: ['Rotate'], open: [], keywords: ['auth.ts', 'PR #12'] })
  assert.equal(parseSummary('```json\n' + JSON.stringify(ok) + '\n```')?.title, 'Login token')
  assert.deepEqual(parseSummary(JSON.stringify({ title: 'T', gist: 'one\ntwo' }))?.gist, ['one', 'two'])
  assert.deepEqual(parseSummary(JSON.stringify({ title: 'T', gist: ['g'] }))?.keywords, [])
})

test('parseSummary: null for what is not a summary', () => {
  assert.equal(parseSummary('no json here'), null)
  assert.equal(parseSummary('{broken'), null)
  assert.equal(parseSummary('{"gist": ["g"]}'), null, 'no title')
  assert.equal(parseSummary('{"title": "T", "gist": []}'), null, 'no gist')
  assert.equal(parseSummary('{"title": "T", "gist": ["g"], "decisions": [1]}'), null)
})
