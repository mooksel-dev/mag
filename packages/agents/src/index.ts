import type { AgentEvent, AgentKind, AgentModel } from '@mag/core'
import { claudeCode } from './claude-code'
import { codex } from './codex'

export interface RunSpec {
  cwd: string
  prompt: string
  /** Agent-native session id to continue. */
  resumeId?: string
  /** Provider model id or alias; omitted = the provider's default. */
  model?: string
  appendSystemPrompt?: string
  /** Path to an MCP config JSON file. */
  mcpConfigPath?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  /** MCP tool that answers permission prompts (Claude Code only). */
  permissionPromptTool?: string
  addDirs?: string[]
  env?: Record<string, string>
}

export interface RunHandle {
  kill(): void
  /** Resolves when the process exits. */
  done: Promise<void>
}

export interface AgentAdapter {
  id: AgentKind
  displayName: string
  /** Absolute path or command name of the CLI, if found. */
  detect(): Promise<string | null>
  /** Models the user can pick; the provider's default is implied and not listed. */
  listModels(): Promise<AgentModel[]>
  start(spec: RunSpec, onEvent: (e: AgentEvent) => void): RunHandle
}

export const adapters: Record<AgentKind, AgentAdapter> = {
  'claude-code': claudeCode,
  codex,
}

export { buildArgs, claudeCode, parseClaudeLine } from './claude-code'
export { buildArgs as buildCodexArgs, codex, parseCodexLine } from './codex'
