import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@mag/core'
import { buildArgs, codex, parseCodexLine } from './codex.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap(parseCodexLine)
    .filter((e) => e.type !== 'raw')

/** Value that follows `flag` each time it appears. */
const values = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))

// Item shapes follow codex-rs/exec/src/exec_events.rs (CLI 0.164).
test('parseCodexLine maps a successful run', () => {
  const events: AgentEvent[] = [
    { type: 'session.started', nativeSessionId: '01a16fb6-76fa-7111-bac1-3107c589625a' },
    { type: 'tool.call', id: 'item_1', name: 'mcp__mag__get_task', input: {} },
    { type: 'tool.result', id: 'item_1', ok: true },
    { type: 'tool.call', id: 'item_2', name: 'Bash', input: { command: '/bin/zsh -lc ls' } },
    { type: 'tool.result', id: 'item_2', ok: true },
    { type: 'tool.call', id: 'item_3', name: 'Bash', input: { command: "/bin/zsh -lc 'cat missing.txt'" } },
    { type: 'tool.result', id: 'item_3', ok: false },
    { type: 'tool.call', id: 'item_5', name: 'Edit', input: { path: '/tmp/mag-codex-run/hello.txt' } },
    { type: 'tool.result', id: 'item_5', ok: true },
    { type: 'tool.call', id: 'ws_1', name: 'WebSearch', input: { query: 'codex exec json' } },
    { type: 'tool.result', id: 'ws_1', ok: true },
    { type: 'message', text: 'Created hello.txt with the task title. BANANA' },
    { type: 'turn.done', ok: true },
  ]
  assert.deepEqual(fixture('codex.jsonl'), events)
})

// Captured from a real `codex exec --json` run with expired auth.
test('parseCodexLine ignores retries and reports the fatal error', () => {
  const events = fixture('codex-auth-failed.jsonl')
  assert.deepEqual(events[0], { type: 'session.started', nativeSessionId: '01a16fb6-76fa-7111-bac1-3107c589625a' })
  assert.deepEqual(events.slice(1), [
    { type: 'error', message: 'workspace routing discovery unauthorized (401)' },
    { type: 'turn.done', ok: false },
    { type: 'error', message: 'workspace routing discovery unauthorized (401)' },
  ])
})

test('parseCodexLine passes reasoning, todo lists and bad JSON through as raw', () => {
  assert.equal(parseCodexLine('not json')[0].type, 'raw')
  assert.equal(parseCodexLine('{"type":"turn.started"}')[0].type, 'raw')
  assert.equal(parseCodexLine('{"type":"item.completed","item":{"id":"i","type":"reasoning","text":"x"}}')[0].type, 'raw')
  assert.equal(parseCodexLine('{"type":"item.updated","item":{"id":"i","type":"todo_list","items":[]}}')[0].type, 'raw')
})

test('buildArgs: fresh read-only run with the default model', () => {
  const args = buildArgs({ cwd: '/repo', prompt: '-hi', addDirs: ['/other'], allowedTools: ['Read', 'mcp__mag'] })
  assert.deepEqual(args.slice(0, 2), ['exec', '--json'])
  assert.deepEqual(values(args, '-C'), ['/repo'])
  assert.deepEqual(values(args, '-s'), ['read-only'])
  assert.ok(!args.includes('--model'))
  assert.ok(!args.includes('--add-dir'))
  assert.ok(!args.includes('sandbox_workspace_write.network_access=true'))
  assert.deepEqual(args.slice(-2), ['--', '-hi'])
})

test('buildArgs: fresh workspace-write run with a model', () => {
  const args = buildArgs({ cwd: '/wt', prompt: 'go', model: 'gpt-6-luna', addDirs: ['/a', '/b c'], allowedTools: ['Edit', 'Bash'] })
  assert.deepEqual(values(args, '--model'), ['gpt-6-luna'])
  assert.deepEqual(values(args, '-s'), ['workspace-write'])
  assert.deepEqual(values(args, '--add-dir'), ['/a', '/b c'])
  assert.ok(values(args, '-c').includes('sandbox_workspace_write.network_access=true'))
})

test('buildArgs: resume passes the sandbox as config and the id before the prompt', () => {
  const args = buildArgs({ cwd: '/wt', prompt: 'next', resumeId: 'th-1', addDirs: ['/a'], allowedTools: ['Bash'] })
  assert.deepEqual(args.slice(0, 2), ['exec', 'resume'])
  assert.ok(!args.includes('-C') && !args.includes('-s') && !args.includes('--add-dir'))
  const c = values(args, '-c')
  assert.ok(c.includes('sandbox_mode="workspace-write"'))
  assert.ok(c.includes('sandbox_workspace_write.writable_roots=["/a"]'))
  assert.deepEqual(args.slice(-3), ['--', 'th-1', 'next'])
})

test('buildArgs: system prompt and MCP servers become TOML -c overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-codex-'))
  const mcpConfigPath = join(dir, 'mcp.json')
  const server = { command: '/Applications/My App/node', args: ['/x/task "mcp".js'], env: { MAG_TASK_ID: 't 1' } }
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { mag: server } }))
  const c = values(buildArgs({ cwd: '/r', prompt: 'p', mcpConfigPath, appendSystemPrompt: 'Line 1\n"quoted"' }), '-c')
  assert.ok(c.includes('developer_instructions="Line 1\\n\\"quoted\\""'))
  assert.ok(c.includes('mcp_servers.mag.command="/Applications/My App/node"'))
  assert.ok(c.includes('mcp_servers.mag.args=["/x/task \\"mcp\\".js"]'))
  assert.ok(c.includes('mcp_servers.mag.env={"MAG_TASK_ID" = "t 1"}'))
  assert.ok(!c.some((x) => x.includes('tool_timeout_sec')), "Codex's default without a timeout")
  const waits = values(buildArgs({ cwd: '/r', prompt: 'p', mcpConfigPath, env: { MCP_TOOL_TIMEOUT: '604800000' } }), '-c')
  assert.ok(waits.includes('mcp_servers.mag.tool_timeout_sec=604800'), 'a publish waits for the user, not a minute')
})

test('buildArgs: a read-only run gets the read-only sandbox without network, even with Bash (prompts-use-the-models-to.2)', () => {
  const fresh = buildArgs({ cwd: '/repo', prompt: 'p', addDirs: ['/a'], allowedTools: ['Read', 'Bash', 'WebSearch'], readOnly: true })
  assert.deepEqual(values(fresh, '-s'), ['read-only'])
  assert.ok(!fresh.includes('--add-dir'))
  assert.ok(!values(fresh, '-c').includes('sandbox_workspace_write.network_access=true'))
  const resumed = values(buildArgs({ cwd: '/repo', prompt: 'p', resumeId: 'th-1', allowedTools: ['Bash'], readOnly: true }), '-c')
  assert.ok(resumed.includes('sandbox_mode="read-only"'))
  assert.ok(!resumed.includes('sandbox_workspace_write.network_access=true'))
})

test('buildArgs ignores permissionMode, which is Claude Code only', () => {
  const spec = { cwd: '/wt', prompt: 'go', allowedTools: ['Bash'] }
  assert.deepEqual(buildArgs({ ...spec, permissionMode: 'auto' }), buildArgs(spec))
})

test('buildArgs ignores askTools, which is Claude Code only', () => {
  const spec = { cwd: '/wt', prompt: 'go', allowedTools: ['Bash'] }
  assert.deepEqual(buildArgs({ ...spec, askTools: ['Bash(git push:*)'] }), buildArgs(spec))
})

test('buildArgs passes effort as model_reasoning_effort, max as xhigh, to fresh and resumed runs; none by default', () => {
  for (const resumeId of [undefined, 'thread-1']) {
    assert.ok(values(buildArgs({ cwd: '/r', prompt: 'hi', effort: 'low', resumeId }), '-c').includes('model_reasoning_effort="low"'))
    assert.ok(values(buildArgs({ cwd: '/r', prompt: 'hi', effort: 'max', resumeId }), '-c').includes('model_reasoning_effort="xhigh"'))
    assert.ok(!values(buildArgs({ cwd: '/r', prompt: 'hi', resumeId }), '-c').some((v) => v.startsWith('model_reasoning_effort')))
  }
})

test('codex lists its models with a version and the efforts it takes, no max; context windows unknown', async () => {
  for (const m of await codex.listModels()) {
    assert.ok(m.version, m.id)
    assert.equal(m.contextWindow, null)
    assert.deepEqual(m.efforts, ['low', 'medium', 'high', 'xhigh'])
  }
})

test('parseCodexLine reports no context fill: turn usage adds up its requests', () => {
  assert.ok(!fixture('codex.jsonl').some((e) => e.type === 'usage'))
})
