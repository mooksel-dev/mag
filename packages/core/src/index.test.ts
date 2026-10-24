import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHOICE, resolveChoice, type ModelChoice } from './index.ts'

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
