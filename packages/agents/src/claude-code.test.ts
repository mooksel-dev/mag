import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AgentEvent } from '@mag/core'
import { buildArgs, buildLiveArgs, claudeCode, liveParser, parseClaudeLine } from './claude-code.ts'

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

test('buildArgs passes --effort when set, to one-off and live runs, and omits it by default', () => {
  for (const args of [buildArgs({ cwd: '/tmp', prompt: 'hi', effort: 'max' }), buildLiveArgs({ cwd: '/tmp', effort: 'max' })])
    assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'max'])
  assert.ok(!buildArgs({ cwd: '/tmp', prompt: 'hi' }).includes('--effort'))
  assert.ok(!buildLiveArgs({ cwd: '/tmp' }).includes('--effort'))
})

test('claudeCode lists full model ids with version, a context window and every effort; aliases map to them', async () => {
  const models = await claudeCode.listModels()
  assert.deepEqual(models.map((m) => [m.id, m.label, m.alias]), [
    ['claude-opus-5-5', 'Opus 5.5', 'opus'],
    ['claude-sonnet-5-5', 'Sonnet 5.5', 'sonnet'],
    ['claude-haiku-5-5', 'Haiku 5.5', 'haiku'],
    ['claude-fable-5-2', 'Fable 5.2', 'fable'],
  ])
  for (const m of models) {
    assert.equal(m.contextWindow, 1_000_000)
    assert.deepEqual(m.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  }
})

const usage = (events: AgentEvent[]) => events.filter((e) => e.type === 'usage')

test('parseClaudeLine: context used is the last request of the session itself, a subagent skipped; the window from modelUsage', () => {
  const events = recorded('foreground').flatMap(parseClaudeLine)
  // The fixture's main-thread requests: 2+7605+13403, then 2+3477+21008 (twice: one line per content block); the
  // subagent's (2+16088) is not the session's context.
  assert.deepEqual(usage(events), [
    { type: 'usage', model: 'claude-haiku-5-5', contextUsed: 21010 },
    { type: 'usage', model: 'claude-haiku-5-5', contextUsed: 24487 },
    { type: 'usage', model: 'claude-haiku-5-5', contextUsed: 24487 },
    { type: 'usage', model: 'claude-haiku-5-5', contextWindow: 1_000_000 },
  ])
  // The window comes before the turn ends, so the turn's last state has both.
  assert.ok(events.findIndex((e) => e.type === 'usage' && e.contextWindow) < events.findIndex((e) => e.type === 'turn.done'))
})

test('parseClaudeLine: no usage event without usage numbers', () => {
  assert.deepEqual(usage(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))), [])
  assert.deepEqual(usage(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', modelUsage: { m: { contextWindow: 0 } } }))), [])
})

test('liveParser reports usage as parseClaudeLine does, also for a stopped turn', () => {
  const parser = liveParser()
  assert.deepEqual(usage(recorded('foreground').flatMap((l) => parser.parse(l))), usage(recorded('foreground').flatMap(parseClaudeLine)))
  const live = liveParser()
  live.sent()
  live.interrupting()
  const stopped = live.parse(JSON.stringify({ type: 'result', is_error: true, modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 } } }))
  assert.deepEqual(stopped.map((e) => e.type), ['stopped', 'usage', 'turn.done'])
})
