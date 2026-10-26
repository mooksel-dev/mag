import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('buildArgs passes --permission-prompt-tool when set', () => {
  const args = buildArgs({ cwd: '/tmp', prompt: 'hi', permissionPromptTool: 'mcp__mag__approve_tool' })
  assert.deepEqual(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'mcp__mag__approve_tool'])
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi' }).includes('--permission-prompt-tool'))
})

test('parseClaudeLine lists MCP integrations on init, without mag', () => {
  const [e] = parseClaudeLine(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      tools: ['Read', 'mcp__mag__get_task', 'mcp__claude_ai_Cloudflare__execute', 'mcp__claude_ai_Cloudflare__search', 'mcp__claude_ai_Gmail__send', 'mcp__local__x'],
      mcp_servers: [
        { name: 'mag', status: 'connected' },
        { name: 'claude.ai Cloudflare Developer Platform', status: 'connected' },
        { name: 'claude.ai Gmail', status: 'connected' },
      ],
    }),
  )
  assert.equal(e.type, 'session.started')
  assert.deepEqual(e.type === 'session.started' && e.integrations, [
    { id: 'claude_ai_Cloudflare', name: 'claude.ai Cloudflare Developer Platform' },
    { id: 'claude_ai_Gmail', name: 'claude.ai Gmail' },
    { id: 'local', name: 'local' },
  ])
})

test('parseClaudeLine reports compaction', () => {
  const line = { type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: { trigger: 'manual', pre_tokens: 20154, post_tokens: 6464 } }
  assert.deepEqual(parseClaudeLine(JSON.stringify(line)), [{ type: 'context.compacted', preTokens: 20154 }])
})
