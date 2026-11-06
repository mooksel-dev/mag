import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { MAG_MCP_ID, type AgentEvent, type BackgroundTask, type Integration } from '@mag/core'
import { findBin } from './bin.ts'
import type { AgentAdapter, LiveHandle, RunSpec } from './index'

/** How long a closed live process may finish its work (e.g. a background task) before SIGTERM. */
const CLOSE_GRACE_MS = 5_000

/** Commands from `system/init` that work in `-p`: slash commands and skills, minus terminal-only and internal ones. */
function initCommands(j: any): string[] | undefined {
  const all = [...(j.slash_commands ?? []), ...(j.skills ?? [])].filter((c): c is string => typeof c === 'string')
  if (!all.length) return undefined
  const terminal = new Set<string>(j.terminal_slash_commands ?? [])
  return [...new Set(all)].filter((c) => !terminal.has(c) && !c.startsWith('_'))
}

const normalize = (s: string) => s.replace(/[^\w-]+/g, '_')

/**
 * MCP servers behind the tools from `system/init`: distinct `mcp__<id>__` prefixes except mag's own. The name comes
 * from `mcp_servers`, whose names normalize to the id or start with it ("claude.ai Cloudflare Developer Platform"
 * has tools under claude_ai_Cloudflare); falls back to the id.
 */
function initIntegrations(j: any): Integration[] | undefined {
  const ids = new Set<string>()
  for (const t of j.tools ?? []) {
    const m = typeof t === 'string' ? /^mcp__(.+?)__/.exec(t) : null
    if (m && m[1] !== MAG_MCP_ID) ids.add(m[1])
  }
  if (!ids.size) return undefined
  const names: string[] = (j.mcp_servers ?? []).map((s: any) => s?.name).filter((n: unknown): n is string => typeof n === 'string')
  return [...ids].map((id) => ({
    id,
    name: names.find((n) => normalize(n) === id) ?? names.find((n) => normalize(n).startsWith(`${id}_`)) ?? id,
  }))
}

/** Translate one stream-json line from `claude -p` into normalized events. */
export function parseClaudeLine(line: string): AgentEvent[] {
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return [{ type: 'raw', payload: line }]
  }
  return fromClaude(j)
}

function fromClaude(j: any): AgentEvent[] {
  switch (j.type) {
    case 'system':
      if (j.subtype === 'init' && j.session_id) {
        const commands = initCommands(j)
        const integrations = initIntegrations(j)
        return [{ type: 'session.started', nativeSessionId: j.session_id, model: j.model, ...(commands && { commands }), ...(integrations && { integrations }) }]
      }
      if (j.subtype === 'compact_boundary') return [{ type: 'context.compacted', preTokens: j.compact_metadata?.pre_tokens }]
      return [{ type: 'raw', payload: j }]
    case 'assistant': {
      const out: AgentEvent[] = []
      for (const b of j.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ type: 'message', text: b.text })
        else if (b.type === 'tool_use') out.push({ type: 'tool.call', id: b.id, name: b.name, input: b.input })
      }
      return out
    }
    case 'user': {
      const out: AgentEvent[] = []
      const content = j.message?.content
      if (Array.isArray(content))
        for (const b of content)
          if (b.type === 'tool_result') out.push({ type: 'tool.result', id: b.tool_use_id, ok: !b.is_error })
      return out
    }
    case 'result':
      return [
        {
          type: 'turn.done',
          ok: j.subtype === 'success' && !j.is_error,
          costUsd: j.total_cost_usd,
          nativeSessionId: j.session_id,
        },
      ]
    default:
      return [{ type: 'raw', payload: j }]
  }
}

/**
 * Events of a long-lived process (facts: T-40.1 spike, claude-live.test.ts). On top of parseClaudeLine: a turn starts
 * with `system/init` and ends with `result`, so an init outside a turn we started is a wake-up (`turn.started`);
 * `background_tasks_changed` lists the active background tasks, named after the tool whose `tool_use` started them
 * (`task_started.tool_use_id`, which may come after the list); the error result of our interrupt is a stop.
 * Control responses go to `onControl`.
 */
export function liveParser(onControl: (requestId: string, ok: boolean, error?: string) => void = () => {}) {
  let inTurn = false
  let stopping = false
  /** tool_use id → tool name. */
  const tools = new Map<string, string>()
  /** Task id → the tool that started it. */
  const taskTools = new Map<string, string>()
  let tasks: { task_id: string; description?: string; task_type?: string }[] = []
  const background = (): AgentEvent => ({
    type: 'background',
    tasks: tasks.map((t): BackgroundTask => ({ id: t.task_id, name: taskTools.get(t.task_id) ?? (t.description || t.task_type || 'task') })),
  })

  return {
    /** We wrote a user message: the init that follows is ours, not a wake-up. */
    sent() {
      inTurn = true
    },
    /** An interrupt is on its way; false if no turn is going on (nothing to interrupt). */
    interrupting() {
      if (inTurn) stopping = true
      return inTurn
    },
    parse(line: string): AgentEvent[] {
      let j: any
      try {
        j = JSON.parse(line)
      } catch {
        return [{ type: 'raw', payload: line }]
      }
      if (j.type === 'control_response') {
        const r = j.response ?? {}
        onControl(r.request_id, r.subtype === 'success', r.error)
        return []
      }
      if (j.type === 'system' && j.subtype === 'background_tasks_changed') {
        tasks = Array.isArray(j.tasks) ? j.tasks.filter((t: any) => typeof t?.task_id === 'string') : []
        for (const id of taskTools.keys()) if (!tasks.some((t) => t.task_id === id)) taskTools.delete(id)
        return [background()]
      }
      if (j.type === 'system' && j.subtype === 'task_started') {
        const name = tools.get(j.tool_use_id)
        if (!name) return []
        taskTools.set(j.task_id, name)
        return tasks.some((t) => t.task_id === j.task_id) ? [background()] : []
      }
      if (j.type === 'system' && j.subtype === 'init' && !inTurn) {
        inTurn = true
        return [{ type: 'turn.started' }, ...fromClaude(j)]
      }
      if (j.type === 'assistant') for (const b of j.message?.content ?? []) if (b.type === 'tool_use') tools.set(b.id, b.name)
      if (j.type === 'result') {
        const stopped = stopping && j.is_error
        inTurn = stopping = false
        if (stopped) return [{ type: 'stopped' }, { type: 'turn.done', ok: true, costUsd: j.total_cost_usd, nativeSessionId: j.session_id }]
      }
      return fromClaude(j)
    },
  }
}

/** Everything but the prompt, shared by one-off and live runs. */
function specArgs(spec: Omit<RunSpec, 'prompt'>): string[] {
  const args: string[] = []
  if (spec.resumeId) args.push('--resume', spec.resumeId, ...(spec.forkSession ? ['--fork-session'] : []))
  if (spec.model) args.push('--model', spec.model)
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt)
  if (spec.mcpConfigPath) args.push('--mcp-config', spec.mcpConfigPath)
  if (spec.allowedTools?.length) args.push('--allowedTools', spec.allowedTools.join(','))
  if (spec.disallowedTools?.length) args.push('--disallowedTools', spec.disallowedTools.join(','))
  if (spec.permissionPromptTool) args.push('--permission-prompt-tool', spec.permissionPromptTool)
  if (spec.permissionMode) args.push('--permission-mode', spec.permissionMode)
  for (const d of spec.addDirs ?? []) args.push('--add-dir', d)
  if (spec.noTools) args.push('--tools', '', '--strict-mcp-config')
  return args
}

export function buildArgs(spec: RunSpec): string[] {
  return ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose', ...specArgs(spec)]
}

/** A live process: messages come as stream-json on stdin. */
export function buildLiveArgs(spec: Omit<RunSpec, 'prompt'>): string[] {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...specArgs(spec)]
}

export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  cheapModel: 'haiku',

  async detect() {
    return findBin('claude', 'MAG_CLAUDE_BIN')
  },

  async listModels() {
    // Aliases track the latest model of each tier, so the list needs no updates.
    return [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
    ]
  },

  start(spec, onEvent) {
    const bin = findBin('claude', 'MAG_CLAUDE_BIN') ?? 'claude'
    if (!existsSync(spec.cwd)) {
      // spawn would report this as ENOENT for the binary, which is misleading.
      onEvent({ type: 'error', message: `Working directory does not exist: ${spec.cwd}` })
      return { kill: () => {}, done: Promise.resolve() }
    }
    const child = spawn(bin, buildArgs(spec), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim()) for (const e of parseClaudeLine(line)) onEvent(e)
    })

    let killed = false
    const done = new Promise<void>((resolve) => {
      child.on('error', (err) => {
        onEvent({ type: 'error', message: `Could not start ${bin}: ${err.message}` })
        resolve()
      })
      child.on('close', (code) => {
        if (killed) onEvent({ type: 'stopped' })
        else if (code && code !== 0) onEvent({ type: 'error', message: stderr.trim() || `claude exited with ${code}` })
        resolve()
      })
    })

    return {
      kill: () => {
        killed = true
        child.kill('SIGTERM')
      },
      done,
    }
  },

  open(spec, onEvent): LiveHandle {
    const bin = findBin('claude', 'MAG_CLAUDE_BIN') ?? 'claude'
    if (!existsSync(spec.cwd)) {
      onEvent({ type: 'error', message: `Working directory does not exist: ${spec.cwd}` })
      return { send() {}, interrupt: async () => {}, stopTask: async () => {}, close() {}, done: Promise.resolve() }
    }
    const child = spawn(bin, buildLiveArgs(spec), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
    const parser = liveParser((id, ok, error) => {
      const p = pending.get(id)
      pending.delete(id)
      if (ok) p?.resolve()
      else p?.reject(new Error(error || 'Control request failed'))
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim()) for (const e of parser.parse(line)) onEvent(e)
    })

    let closing = false
    let exited = false
    // Writes after the process is gone fail with EPIPE; the exit is reported on its own.
    child.stdin.on('error', () => {})
    const write = (o: unknown) => {
      if (exited || closing) return false
      child.stdin.write(JSON.stringify(o) + '\n')
      return true
    }
    let requests = 0
    const control = (request: Record<string, unknown>) =>
      new Promise<void>((resolve, reject) => {
        const id = `req_${++requests}`
        if (write({ type: 'control_request', request_id: id, request })) pending.set(id, { resolve, reject })
        else resolve()
      })

    const done = new Promise<void>((resolve) => {
      const exit = (event: AgentEvent | null) => {
        if (exited) return
        exited = true
        for (const p of pending.values()) p.resolve()
        pending.clear()
        if (event) onEvent(event)
        resolve()
      }
      child.on('error', (err) => exit({ type: 'error', message: `Could not start ${bin}: ${err.message}` }))
      child.on('close', (code) => {
        if (closing) exit({ type: 'stopped' })
        else exit(code ? { type: 'error', message: stderr.trim() || `claude exited with ${code}` } : null)
      })
    })

    return {
      send(text) {
        parser.sent()
        write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
      },
      interrupt: () => (parser.interrupting() ? control({ subtype: 'interrupt' }) : Promise.resolve()),
      stopTask: (id) => control({ subtype: 'stop_task', task_id: id }),
      close(graceMs = CLOSE_GRACE_MS) {
        if (exited) return
        if (!closing) {
          closing = true
          child.stdin.end()
        }
        // With background tasks the CLI waits for them (and wakes the agent once more) before it exits.
        setTimeout(() => exited || child.kill('SIGTERM'), graceMs).unref()
      },
      done,
    }
  },
}
