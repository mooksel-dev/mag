import { test } from 'node:test'
import assert from 'node:assert/strict'
import { integrationMode, integrationOf, integrationRules, type Integration } from './index.ts'

const known: Integration[] = [
  { id: 'claude_ai_Cloudflare', name: 'claude.ai Cloudflare Developer Platform' },
  { id: 'claude_ai_Gmail', name: 'claude.ai Gmail' },
  { id: 'local', name: 'local' },
  { id: 'mag', name: 'mag' },
]

test('integrationMode: missing is off, reviewer follows developer', () => {
  const project = { integrations: { developer: { claude_ai_Gmail: 'ask' as const }, chat: { claude_ai_Gmail: 'auto' as const } } }
  assert.equal(integrationMode(project, 'chat', 'claude_ai_Gmail'), 'auto')
  assert.equal(integrationMode(project, 'reviewer', 'claude_ai_Gmail'), 'ask')
  assert.equal(integrationMode(project, 'groomer', 'claude_ai_Gmail'), 'off')
  assert.equal(integrationMode(project, 'chat', 'claude_ai_Cloudflare'), 'off')
  assert.equal(integrationMode({ integrations: {} }, 'chat', 'x'), 'off')
})

test('integrationRules: server-level rules per mode, never mag', () => {
  const project = { integrations: { chat: { claude_ai_Cloudflare: 'ask' as const, claude_ai_Gmail: 'auto' as const } } }
  assert.deepEqual(integrationRules(project, 'chat', known), {
    allowed: ['mcp__claude_ai_Gmail'],
    disallowed: ['mcp__local'],
    ask: ['mcp__claude_ai_Cloudflare'],
  })
})

test('integrationOf: finds the server by prefix, longest id first', () => {
  const both = [...known, { id: 'claude_ai', name: 'x' }]
  assert.deepEqual(integrationOf('mcp__claude_ai_Cloudflare__execute', both), { integration: known[0], tool: 'execute' })
  assert.equal(integrationOf('Bash', both), null)
  assert.equal(integrationOf('mcp__other__x', both), null)
})
