import { test } from 'node:test'
import assert from 'node:assert/strict'
import { integrationId, integrationMode, integrationRules, type Integration } from './index.ts'

const known: Integration[] = [
  { id: 'claude_ai_Cloudflare', name: 'claude.ai Cloudflare' },
  { id: 'claude_ai_Gmail', name: 'claude.ai Gmail' },
  { id: 'claude_ai_Google_Drive', name: 'claude.ai Google Drive' },
  { id: 'mag', name: 'mag' },
]

test('integrationId matches Claude Code tool prefixes', () => {
  assert.equal(integrationId('claude.ai Cloudflare Developer Platform'), 'claude_ai_Cloudflare_Developer_Platform')
  assert.equal(integrationId('plugin:shared-sessions:hub'), 'plugin_shared-sessions_hub')
})

test('integrationMode defaults to off', () => {
  assert.equal(integrationMode({ integrations: {} }, 'chat', 'claude_ai_Gmail'), 'off')
  assert.equal(integrationMode({ integrations: { chat: { claude_ai_Gmail: 'auto' } } }, 'groomer', 'claude_ai_Gmail'), 'off')
})

test('reviewer follows developer unless set', () => {
  const p = { integrations: { developer: { claude_ai_Gmail: 'auto' as const } } }
  assert.equal(integrationMode(p, 'reviewer', 'claude_ai_Gmail'), 'auto')
  assert.equal(integrationMode({ integrations: { ...p.integrations, reviewer: { claude_ai_Gmail: 'off' as const } } }, 'reviewer', 'claude_ai_Gmail'), 'off')
})

test('integrationRules splits servers by mode and never lists mag', () => {
  const p = { integrations: { chat: { claude_ai_Cloudflare: 'auto' as const, claude_ai_Gmail: 'ask' as const } } }
  assert.deepEqual(integrationRules(p, 'chat', known), {
    allowed: ['mcp__claude_ai_Cloudflare'],
    disallowed: ['mcp__claude_ai_Google_Drive'],
    ask: ['mcp__claude_ai_Gmail'],
  })
})

test('integrationRules with an empty catalogue is empty', () => {
  assert.deepEqual(integrationRules({ integrations: {} }, 'developer', []), { allowed: [], disallowed: [], ask: [] })
})
