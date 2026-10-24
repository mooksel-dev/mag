import type { AgentEvent, AgentKind } from '@mag/core'
import { claudeCode } from './claude-code'

export interface RunSpec {
  cwd: string
  prompt: string
  /** Agent-native session id to continue. */
  resumeId?: string
  appendSystemPrompt?: string
  /** Path to an MCP config JSON file. */
  mcpConfigPath?: string
  allowedTools?: string[]
  disallowedTools?: string[]
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
  start(spec: RunSpec, onEvent: (e: AgentEvent) => void): RunHandle
}

export const adapters: Record<AgentKind, AgentAdapter> = {
  'claude-code': claudeCode,
}

export { claudeCode, parseClaudeLine } from './claude-code'
