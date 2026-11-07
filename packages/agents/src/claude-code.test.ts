import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AgentEvent } from '@mag/core'
import { buildArgs, buildLiveArgs, liveParser, parseClaudeLine } from './claude-code.ts'

test('buildArgs passes --model when set', () => {
  const args = buildArgs({ cwd: '/tmp', prompt: 'hi', model: 'sonnet', resumeId: 'abc' })
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'sonnet'])
  assert.ok(args.includes('--resume'))
})

test('buildArgs forks the resumed session only when asked', () => {
  const fork = buildArgs({ cwd: '/tmp', prompt: 'hi', resumeId: 'abc', forkSession: true })
  assert.deepEqual(fork.slice(fork.indexOf('--resume'), fork.indexOf('--resume') + 3), ['--resume', 'abc', '--fork-session'])
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi', resumeId: 'abc' }).includes('--fork-session'))
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi', forkSession: true }).includes('--fork-session'))
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

test('buildArgs passes --permission-mode when set, to one-off and live runs', () => {
  const args = buildArgs({ cwd: '/tmp', prompt: 'hi', permissionMode: 'auto', permissionPromptTool: 'mcp__mag__approve_tool' })
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto'])
  const live = buildLiveArgs({ cwd: '/tmp', permissionMode: 'default' })
  assert.deepEqual(live.slice(live.indexOf('--permission-mode'), live.indexOf('--permission-mode') + 2), ['--permission-mode', 'default'])
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi' }).includes('--permission-mode'))
})

test('buildArgs passes askTools as --settings permissions.ask, to one-off and live runs', () => {
  const ask = ['Bash(gh pr comment:*)', 'Bash(git * push *)']
  for (const args of [buildArgs({ cwd: '/tmp', prompt: 'hi', askTools: ask }), buildLiveArgs({ cwd: '/tmp', askTools: ask })]) {
    const i = args.indexOf('--settings')
    assert.ok(i > 0)
    assert.deepEqual(JSON.parse(args[i + 1]), { permissions: { ask } })
  }
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi' }).includes('--settings'))
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi', askTools: [] }).includes('--settings'))
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

test('buildArgs turns off tools and MCP servers for noTools', () => {
  const args = buildArgs({ cwd: '/tmp', prompt: 'hi', noTools: true })
  assert.deepEqual(args.slice(args.indexOf('--tools')), ['--tools', '', '--strict-mcp-config'])
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi' }).includes('--tools'))
})

/** A recorded `claude -p` stream (Claude Code 2.1.306, hooks and init details left out) with one Agent call. */
const recorded = (name: 'background' | 'foreground') =>
  readFileSync(new URL(`./fixtures/claude-subagent-${name}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean)

/** The events of a subagent's run: what routes it (topics-a-tree-of-agent.4). */
const subagentEvents = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === 'subagent.started' || e.type === 'subagent.done'
      ? [`${e.type} ${e.toolUseId}${e.type === 'subagent.started' ? (e.background ? ' background' : ' foreground') : e.ok ? ' ok' : ' failed'}`]
      : e.type === 'tool.call' || e.type === 'tool.result' || e.type === 'message'
        ? [`${e.type}${e.type === 'message' ? '' : ` ${e.id}`}${e.type === 'tool.call' ? ` ${e.name}` : ''}${e.parentToolUseId ? ` < ${e.parentToolUseId}` : ''}`]
        : [],
  )

test('parseClaudeLine: a background subagent outlives its Agent call; its events carry the call id, and it ends at its notification', () => {
  const agent = 'toolu_01Y1vDWTBouKS2coW4xSKETm'
  const read = 'toolu_01Ti62vBxwk1qJe2Q9XAJwPy'
  const events = recorded('background').flatMap(parseClaudeLine)
  assert.deepEqual(subagentEvents(events), [
    `tool.call ${agent} Agent`,
    `subagent.started ${agent} background`,
    `tool.result ${agent}`,
    `tool.call ${read} Read < ${agent}`,
    `tool.result ${read} < ${agent}`,
    'message',
    `message < ${agent}`,
    `subagent.done ${agent} ok`,
    'message',
  ])
  const done = events.find((e) => e.type === 'subagent.done')
  assert.equal(done?.type === 'subagent.done' && done.summary, 'The file contains:\n\n```\nhello\n```')
})

test('parseClaudeLine: a foreground subagent ends before its Agent call returns', () => {
  const agent = 'toolu_01LVezVhdAHMdfdcnyZH4Feb'
  const read = 'toolu_01AYBKAWkYqrNaRsPoTBwSk3'
  assert.deepEqual(subagentEvents(recorded('foreground').flatMap(parseClaudeLine)), [
    `tool.call ${agent} Agent`,
    `subagent.started ${agent} foreground`,
    `tool.call ${read} Read < ${agent}`,
    `tool.result ${read} < ${agent}`,
    `subagent.done ${agent} ok`,
    `tool.result ${agent}`,
    'message',
  ])
})

test('liveParser reads subagents as parseClaudeLine does, and still lists the background task', () => {
  for (const name of ['background', 'foreground'] as const) {
    const parser = liveParser()
    const events = recorded(name).flatMap((l) => parser.parse(l))
    assert.deepEqual(subagentEvents(events), subagentEvents(recorded(name).flatMap(parseClaudeLine)))
    if (name === 'background') assert.ok(events.some((e) => e.type === 'background' && e.tasks.some((t) => t.name === 'Agent')))
  }
})

test('parseClaudeLine: a background Bash task starts no subagent; a failed or stopped one ends not ok', () => {
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 't1', task_type: 'local_bash' })), [{ type: 'raw', payload: { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 't1', task_type: 'local_bash' } }])
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'task_notification', tool_use_id: 't2', status: 'stopped' })), [{ type: 'subagent.done', toolUseId: 't2', ok: false }])
})
