import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHOICE, TASK_KEY_RE, resolveChoice, rewriteKeys, subtaskKey, type ModelChoice } from './index.ts'

const opus: ModelChoice = { agent: 'claude-code', model: 'opus' }
const haiku: ModelChoice = { agent: 'claude-code', model: 'haiku' }

test('resolveChoice returns the role choice', () => {
  assert.deepEqual(resolveChoice({ agents: { chat: opus } }, 'chat'), opus)
})

test('resolveChoice falls back to the default', () => {
  assert.deepEqual(resolveChoice({ agents: { chat: opus } }, 'groomer'), DEFAULT_CHOICE)
  assert.deepEqual(resolveChoice({ agents: {} }, 'architect'), DEFAULT_CHOICE)
})

test('reviewer follows developer unless set', () => {
  assert.deepEqual(resolveChoice({ agents: { developer: opus } }, 'reviewer'), opus)
  assert.deepEqual(resolveChoice({ agents: { developer: opus, reviewer: haiku } }, 'reviewer'), haiku)
  assert.deepEqual(resolveChoice({ agents: {} }, 'reviewer'), DEFAULT_CHOICE)
})

test('TASK_KEY_RE matches task and subtask keys', () => {
  assert.equal('see T-12 now'.match(TASK_KEY_RE)?.[0], 'T-12')
  assert.equal('see T-12.3 now'.match(TASK_KEY_RE)?.[0], 'T-12.3')
})

test('subtaskKey', () => {
  assert.equal(subtaskKey('T-1', 2), 'T-1.2')
})

test('rewriteKeys replaces whole keys only', () => {
  const map = { 'T-2': 'T-1.1', 'T-3': 'T-1.2' }
  assert.equal(rewriteKeys('T-2 and T-3, (T-2)', map), 'T-1.1 and T-1.2, (T-1.1)')
  assert.equal(rewriteKeys('T-21 T-2.1 xT-2 T-2x T-2-a wt/T-2', map), 'T-21 T-2.1 xT-2 T-2x T-2-a wt/T-2')
  assert.equal(rewriteKeys('see T-2.', map), 'see T-1.1.')
})

test('rewriteKeys does one pass', () => {
  assert.equal(rewriteKeys('T-2 T-3', { 'T-2': 'T-3', 'T-3': 'T-4' }), 'T-3 T-4')
})

test('rewriteKeys with an empty map returns the text', () => {
  assert.equal(rewriteKeys('T-2', {}), 'T-2')
})
