import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backgroundLabel, cleanTitle, interimReplies, liveSession, titlePrompt, turnMeta, type ChatItem } from './index.ts'

test('backgroundLabel counts the tasks and names their tools', () => {
  assert.equal(backgroundLabel([{ id: 'a', name: 'Monitor' }]), '1 background task · Monitor')
  assert.equal(
    backgroundLabel([{ id: 'a', name: 'Monitor' }, { id: 'b', name: 'Bash' }, { id: 'c', name: 'Monitor' }]),
    '3 background tasks · Monitor ×2, Bash',
  )
})

test('titlePrompt caps the excerpt at 2000 characters', () => {
  const prompt = titlePrompt('hi', 'x'.repeat(5000))
  const excerpt = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(prompt)?.[1] ?? ''
  assert.equal(excerpt.length, 2000)
  assert.ok(excerpt.startsWith('User: hi'))
})

test('cleanTitle strips quotes, a label and the trailing period', () => {
  assert.equal(cleanTitle('"Redesign of the chat panel."'), 'Redesign of the chat panel')
  assert.equal(cleanTitle('Title: «Редизайн панелі чату»\n'), 'Редизайн панелі чату')
  assert.equal(cleanTitle('**Plan  review**\nextra line'), 'Plan review')
})

test('cleanTitle rejects empty and overlong replies', () => {
  assert.equal(cleanTitle('  \n'), null)
  assert.equal(cleanTitle('word '.repeat(30)), null)
})

const user = (at: number): ChatItem => ({ kind: 'user', text: 'q', at })
const reply = (at: number): ChatItem => ({ kind: 'assistant', text: 'a', at })
const result = (at: number, costUsd?: number): ChatItem => ({ kind: 'result', ok: true, costUsd, at })

test('turnMeta shows model, cost and the time since the turn started', () => {
  const items = [user(0), reply(1000), result(38_000, 0.4812)]
  assert.equal(turnMeta(items, 2, 'claude-opus'), 'claude-opus · $0.48 · 38s')
  assert.equal(turnMeta([user(0), result(125_000)], 1), '2m 5s')
})

test('turnMeta measures from the last user message of the same turn only', () => {
  const items = [user(0), result(5000, 0.1), reply(6000), result(9000, 0.2)]
  assert.equal(turnMeta(items, 3), '$0.20')
  assert.equal(turnMeta(items, 0), '')
})

const tool = (at: number): ChatItem => ({ kind: 'tool', id: `t${at}`, name: 'Bash', summary: 'ls', ok: true, at })

test('interimReplies: a single reply is never interim', () => {
  assert.deepEqual([...interimReplies([user(0), reply(1), result(2)])], [])
})

test('interimReplies: text before tools is interim, the last text of the turn is not', () => {
  const items = [user(0), reply(1), tool(2), tool(3), reply(4), result(5)]
  assert.deepEqual([...interimReplies(items)], [1])
})

test('interimReplies: replies of different turns do not affect each other', () => {
  const items = [user(0), reply(1), result(2), reply(3), result(4), user(5), reply(6), tool(7), reply(8), result(9)]
  assert.deepEqual([...interimReplies(items)], [6])
})

test('interimReplies: in a running turn a new reply makes the previous one interim', () => {
  assert.deepEqual([...interimReplies([user(0), reply(1), tool(2)])], [])
  assert.deepEqual([...interimReplies([user(0), reply(1), tool(2), reply(3), tool(4), reply(5)])], [1, 3])
})

test('liveSession: chats, groomers and developers on Claude Code run on a live process', () => {
  assert.equal(liveSession({ role: 'chat', agent: 'claude-code' }), true)
  assert.equal(liveSession({ role: 'groomer', agent: 'claude-code' }), true)
  assert.equal(liveSession({ role: 'developer', agent: 'claude-code' }), true)
  assert.equal(liveSession({ role: 'reviewer', agent: 'claude-code' }), false)
  assert.equal(liveSession({ role: 'chat', agent: 'codex' }), false)
  assert.equal(liveSession({ role: 'developer', agent: 'codex' }), false)
})
