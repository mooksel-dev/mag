import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backgroundLabel, cleanTitle, liveSession, titlePrompt, turnMeta, type ChatItem } from './index.ts'

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

test('liveSession: only project chats on Claude Code run on a live process', () => {
  assert.equal(liveSession({ role: 'chat', agent: 'claude-code' }), true)
  assert.equal(liveSession({ role: 'chat', agent: 'codex' }), false)
  assert.equal(liveSession({ role: 'groomer', agent: 'claude-code' }), false)
  assert.equal(liveSession({ role: 'developer', agent: 'claude-code' }), false)
})
