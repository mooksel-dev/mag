import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildArgs, parseClaudeLine } from './claude-code.ts'

test('buildArgs passes --model when set', () => {
  const args = buildArgs({ cwd: '/tmp', prompt: 'hi', model: 'sonnet', resumeId: 'abc' })
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'sonnet'])
  assert.ok(args.includes('--resume'))
})

test('buildArgs omits --model by default', () => {
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi' }).includes('--model'))
})

test('parseClaudeLine reports the model on init', () => {
  const [e] = parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet' }))
  assert.deepEqual(e, { type: 'session.started', nativeSessionId: 's1', model: 'claude-sonnet' })
})

test('parseClaudeLine lists integrations from a real init line, without mag', () => {
  const line = readFileSync(new URL('./__fixtures__/claude-init.json', import.meta.url), 'utf8')
  const [e] = parseClaudeLine(line)
  assert.equal(e.type, 'session.started')
  assert.deepEqual(e.type === 'session.started' && e.integrations, [
    { id: 'plugin_shared-sessions_hub', name: 'plugin:shared-sessions:hub' },
    { id: 'claude_ai_Claude_Docs', name: 'claude.ai Claude Docs' },
    { id: 'claude_ai_Cloudflare', name: 'claude.ai Cloudflare' },
    { id: 'claude_ai_Cloudflare_Developer_Platform', name: 'claude.ai Cloudflare Developer Platform' },
    { id: 'claude_ai_Google_Sheets', name: 'claude.ai Google Sheets' },
    { id: 'claude_ai_Gmail', name: 'claude.ai Gmail' },
    { id: 'claude_ai_Google_Drive', name: 'claude.ai Google Drive' },
    { id: 'claude_ai_Google_Calendar', name: 'claude.ai Google Calendar' },
  ])
})

test('parseClaudeLine falls back to the tool prefix when a server is not in mcp_servers', () => {
  const [e] = parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', tools: ['Read', 'mcp__x_y__go', 'mcp__mag__get_task'] }))
  assert.deepEqual(e.type === 'session.started' && e.integrations, [{ id: 'x_y', name: 'x_y' }])
})

test('buildArgs passes --permission-prompt-tool when set', () => {
  const args = buildArgs({ cwd: '/tmp', prompt: 'hi', permissionPromptTool: 'mcp__mag__approve_tool' })
  assert.deepEqual(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'mcp__mag__approve_tool'])
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi' }).includes('--permission-prompt-tool'))
})

test('parseClaudeLine lists slash commands and skills on init, without terminal-only and internal ones', () => {
  const [e] = parseClaudeLine(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      slash_commands: ['review', 'compact', 'doctor', '__remote-workflow'],
      terminal_slash_commands: ['doctor'],
      skills: ['review', 'pdf'],
    }),
  )
  assert.deepEqual(e, { type: 'session.started', nativeSessionId: 's1', model: undefined, commands: ['review', 'compact', 'pdf'] })
})

test('parseClaudeLine reports compaction', () => {
  const line = { type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: { trigger: 'manual', pre_tokens: 20154, post_tokens: 6464 } }
  assert.deepEqual(parseClaudeLine(JSON.stringify(line)), [{ type: 'context.compacted', preTokens: 20154 }])
})
