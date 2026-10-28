import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { MAG_MCP_ID, type AgentEvent, type Integration } from '@mag/core'
import { findBin } from './bin.ts'
import type { AgentAdapter, RunSpec } from './index'

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

export function buildArgs(spec: RunSpec): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose']
  if (spec.resumeId) args.push('--resume', spec.resumeId)
  if (spec.model) args.push('--model', spec.model)
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt)
  if (spec.mcpConfigPath) args.push('--mcp-config', spec.mcpConfigPath)
  if (spec.allowedTools?.length) args.push('--allowedTools', spec.allowedTools.join(','))
  if (spec.disallowedTools?.length) args.push('--disallowedTools', spec.disallowedTools.join(','))
  if (spec.permissionPromptTool) args.push('--permission-prompt-tool', spec.permissionPromptTool)
  for (const d of spec.addDirs ?? []) args.push('--add-dir', d)
  if (spec.noTools) args.push('--tools', '', '--strict-mcp-config')
  return args
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

    const done = new Promise<void>((resolve) => {
      child.on('error', (err) => {
        onEvent({ type: 'error', message: `Could not start ${bin}: ${err.message}` })
        resolve()
      })
      child.on('close', (code) => {
        if (code && code !== 0) onEvent({ type: 'error', message: stderr.trim() || `claude exited with ${code}` })
        resolve()
      })
    })

    return { kill: () => child.kill('SIGTERM'), done }
  },
}
