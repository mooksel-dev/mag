import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AgentEvent } from '@mag/core'
import { findBin } from './bin.ts'
import type { AgentAdapter, RunSpec } from './index'

/** Edit or Bash allowed = the agent changes the repo, so it gets a writable sandbox. */
function writes(spec: RunSpec): boolean {
  return spec.allowedTools?.some((t) => t === 'Edit' || t === 'Bash') ?? false
}

/** A git worktree commits into the main repo's .git, which is outside the sandbox root. */
function gitCommonDir(cwd: string): string | null {
  try {
    const dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 5000 }).trim()
    return dir && !dir.startsWith(cwd + '/') ? dir : null
  } catch {
    return null
  }
}

/** Item types that mag shows as tool calls, mapped to Claude Code tool names so summaries keep working. */
function toolCall(item: any): { name: string; input: unknown } | null {
  switch (item.type) {
    case 'command_execution':
      return { name: 'Bash', input: { command: item.command } }
    case 'mcp_tool_call':
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} }
    case 'file_change':
      return { name: 'Edit', input: { path: (item.changes ?? []).map((c: any) => c.path).join(', ') } }
    case 'web_search':
      return { name: 'WebSearch', input: { query: item.query } }
    default:
      return null
  }
}

function itemOk(item: any): boolean {
  // web_search items carry no status.
  if (item.status && item.status !== 'completed') return false
  return item.type !== 'command_execution' || item.exit_code === 0 || item.exit_code == null
}

/** Codex reports transport retries as top-level `error` events; they are not fatal. */
const RETRY = /^Reconnecting\.\.\./

/** Translate one JSONL line from `codex exec --json` into normalized events. */
export function parseCodexLine(line: string): AgentEvent[] {
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return [{ type: 'raw', payload: line }]
  }
  switch (j.type) {
    case 'thread.started':
      return [{ type: 'session.started', nativeSessionId: j.thread_id }]
    case 'item.started': {
      const call = j.item && toolCall(j.item)
      return call ? [{ type: 'tool.call', id: j.item.id, ...call }] : [{ type: 'raw', payload: j }]
    }
    case 'item.completed': {
      const item = j.item ?? {}
      if (item.type === 'agent_message') return item.text?.trim() ? [{ type: 'message', text: item.text }] : []
      const call = toolCall(item)
      if (!call) return [{ type: 'raw', payload: j }]
      const result: AgentEvent = { type: 'tool.result', id: item.id, ok: itemOk(item) }
      // File changes are only reported once they are applied, with no item.started.
      return item.type === 'file_change' ? [{ type: 'tool.call', id: item.id, ...call }, result] : [result]
    }
    case 'turn.completed':
      // Codex reports tokens, not dollars.
      return [{ type: 'turn.done', ok: true }]
    case 'turn.failed':
      return [
        { type: 'turn.done', ok: false },
        { type: 'error', message: j.error?.message ?? 'Codex turn failed' },
      ]
    case 'error':
      if (typeof j.message === 'string' && !RETRY.test(j.message)) return [{ type: 'error', message: j.message }]
      return [{ type: 'raw', payload: j }]
    default:
      return [{ type: 'raw', payload: j }]
  }
}

/** TOML value for a `-c key=value` override. JSON strings are valid TOML basic strings. */
function toml(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toml).join(', ')}]`
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`)
      .join(', ')}}`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(String(v ?? ''))
}

/** `-c mcp_servers.*` overrides from a Claude-style `{mcpServers: {name: {command, args, env}}}` file. */
function mcpArgs(path: string): string[] {
  const { mcpServers = {} } = JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  }
  const args: string[] = []
  for (const [name, s] of Object.entries(mcpServers)) {
    const key = `mcp_servers.${name}`
    args.push('-c', `${key}.command=${toml(s.command)}`)
    if (s.args?.length) args.push('-c', `${key}.args=${toml(s.args)}`)
    if (s.env && Object.keys(s.env).length) args.push('-c', `${key}.env=${toml(s.env)}`)
  }
  return args
}

/**
 * Arguments for `codex exec`. `allowedTools`/`disallowedTools` have no Codex equivalent;
 * the sandbox is the only control: workspace-write when Edit or Bash is allowed, read-only otherwise.
 * workspace-write also gets network, since developers push and open PRs.
 */
export function buildArgs(spec: RunSpec): string[] {
  const write = writes(spec)
  const sandbox = write ? 'workspace-write' : 'read-only'
  // A read-only sandbox can still read extra dirs, so they only matter for writing.
  const dirs = write ? (spec.addDirs ?? []) : []

  const common = ['--json', '--skip-git-repo-check', '-c', 'approval_policy="never"']
  if (write) common.push('-c', 'sandbox_workspace_write.network_access=true')
  if (spec.model) common.push('--model', spec.model)
  if (spec.appendSystemPrompt) common.push('-c', `developer_instructions=${toml(spec.appendSystemPrompt)}`)
  if (spec.mcpConfigPath) common.push(...mcpArgs(spec.mcpConfigPath))

  if (spec.resumeId) {
    // `exec resume` has no -C, -s or --add-dir; it runs in the process cwd and takes the rest as config.
    const args = ['exec', 'resume', ...common, '-c', `sandbox_mode=${toml(sandbox)}`]
    if (dirs.length) args.push('-c', `sandbox_workspace_write.writable_roots=${toml(dirs)}`)
    return [...args, '--', spec.resumeId, spec.prompt]
  }
  const args = ['exec', ...common, '-C', spec.cwd, '-s', sandbox]
  for (const d of dirs) args.push('--add-dir', d)
  return [...args, '--', spec.prompt]
}

export const codex: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',

  async detect() {
    return findBin('codex', 'MAG_CODEX_BIN')
  },

  async listModels() {
    // From `codex debug models` (CLI 0.164); Codex has no tier aliases, so update when models change.
    return [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    ]
  },

  start(spec, onEvent) {
    const bin = findBin('codex', 'MAG_CODEX_BIN') ?? 'codex'
    if (!existsSync(spec.cwd)) {
      // spawn would report this as ENOENT for the binary, which is misleading.
      onEvent({ type: 'error', message: `Working directory does not exist: ${spec.cwd}` })
      return { kill: () => {}, done: Promise.resolve() }
    }
    let args: string[]
    try {
      const git = writes(spec) ? gitCommonDir(spec.cwd) : null
      args = buildArgs(git ? { ...spec, addDirs: [...(spec.addDirs ?? []), git] } : spec)
    } catch (err) {
      onEvent({ type: 'error', message: `Could not read MCP config ${spec.mcpConfigPath}: ${(err as Error).message}` })
      return { kill: () => {}, done: Promise.resolve() }
    }
    const child = spawn(bin, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      // stdin is closed so `exec` does not wait for a piped prompt.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    // A fatal error comes as `error` and then again in `turn.failed`; report it once.
    let lastError: string | null = null
    child.stderr.on('data', (d) => (stderr += d.toString()))
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      for (const e of parseCodexLine(line)) {
        if (e.type === 'error') {
          if (e.message === lastError) continue
          lastError = e.message
        }
        onEvent(e)
      }
    })

    const done = new Promise<void>((resolve) => {
      child.on('error', (err) => {
        onEvent({ type: 'error', message: `Could not start ${bin}: ${err.message}` })
        resolve()
      })
      child.on('close', (code) => {
        // After a reported error the exit code and stderr log noise add nothing.
        if (code && code !== 0 && lastError === null)
          onEvent({ type: 'error', message: stderr.trim() || `codex exited with ${code}` })
        resolve()
      })
    })

    return { kill: () => child.kill('SIGTERM'), done }
  },
}
