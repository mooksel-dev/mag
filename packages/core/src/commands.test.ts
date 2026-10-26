import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatCommands, type AgentSession } from './index.ts'

const session = (id: string, patch: Partial<AgentSession> = {}): AgentSession => ({
  id,
  projectId: 'p',
  taskId: null,
  role: 'chat',
  agent: 'claude-code',
  nativeSessionId: null,
  status: 'idle',
  items: [],
  createdAt: 0,
  ...patch,
})

test('chatCommands: the session own list wins', () => {
  const s = session('a', { commands: ['compact', 'review'] })
  assert.deepEqual(chatCommands(s, [session('b', { commands: ['other'], createdAt: 5 }), s]), ['compact', 'review'])
})

test('chatCommands: a fresh session borrows from the latest session of the same project and agent', () => {
  const fresh = session('new', { createdAt: 9 })
  const all = [
    session('old', { commands: ['old'], createdAt: 1 }),
    session('late', { commands: ['late'], createdAt: 5 }),
    session('codex', { agent: 'codex', commands: ['codex'], createdAt: 7 }),
    session('other', { projectId: 'q', commands: ['other'], createdAt: 8 }),
    fresh,
  ]
  assert.deepEqual(chatCommands(fresh, all), ['late'])
})

test('chatCommands: falls back to /compact', () => {
  assert.deepEqual(chatCommands(session('a'), [session('a')]), ['compact'])
  assert.deepEqual(chatCommands({ projectId: 'p', agent: 'claude-code' }, []), ['compact'])
})

test('chatCommands: none for codex', () => {
  assert.deepEqual(chatCommands(session('a', { agent: 'codex', commands: ['x'] }), []), [])
})
