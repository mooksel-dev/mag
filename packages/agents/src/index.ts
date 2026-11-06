import type { AgentEvent, AgentKind, AgentModel } from '@mag/core'
import { claudeCode } from './claude-code.ts'
import { codex } from './codex.ts'

export interface RunSpec {
  cwd: string
  prompt: string
  /** Agent-native session id to continue. */
  resumeId?: string
  /** With resumeId: continue in a new session that starts as a copy of it; the original stays as it was. Claude Code only. */
  forkSession?: boolean
  /** Provider model id or alias; omitted = the provider's default. */
  model?: string
  appendSystemPrompt?: string
  /** Path to an MCP config JSON file. */
  mcpConfigPath?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  /** MCP tool the CLI asks for permission on tools that are neither allowed nor disallowed. Claude Code only. */
  permissionPromptTool?: string
  /**
   * Claude Code's permission mode (`--permission-mode`); omitted = the CLI's default. Under `-p` in `auto`
   * (chat-publishes-to-github-prs.1): a classifier runs or denies each call, even Bash in allowedTools, and never sends
   * it to permissionPromptTool; only calls matching an `ask` rule reach it. disallowedTools still win. Claude Code only.
   */
  permissionMode?: 'auto' | 'default'
  /**
   * Permission rules (`Bash(gh pr comment:*)` syntax) that ask through permissionPromptTool instead of running, even
   * when allowedTools allows the tool as a whole; disallowedTools still win (chat-publishes-to-github-prs.2). Passed as
   * `--settings` permissions.ask. Claude Code only.
   */
  askTools?: string[]
  addDirs?: string[]
  env?: Record<string, string>
  /** Plain completion: no tools and no MCP servers. Codex runs read-only anyway. */
  noTools?: boolean
  /**
   * The run changes nothing (Bash is for reading by its prompt): Codex, which has no deny rules, runs it in a read-only
   * sandbox without network. Claude Code holds it with disallowedTools.
   */
  readOnly?: boolean
}

export interface RunHandle {
  kill(): void
  /** Resolves when the process exits. */
  done: Promise<void>
}

/** A long-lived agent process (T-40): the turn ends at its result, not when the process exits. */
export interface LiveHandle {
  /** Write one user message. During a turn the CLI folds it into that turn. */
  send(text: string): void
  /** Stop the current turn: it ends (as `stopped` + `turn.done`); the process and its background tasks live on. */
  interrupt(): Promise<void>
  /** Stop one background task; the agent is not woken. */
  stopTask(id: string): Promise<void>
  /** Close stdin, SIGTERM after `graceMs`; the exit emits `stopped`, never `error`. */
  close(graceMs?: number): void
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
  /** Cheapest model, for small background jobs like naming a chat; omitted = the provider's default. */
  cheapModel?: string
  start(spec: RunSpec, onEvent: (e: AgentEvent) => void): RunHandle
  /** Long-lived session: messages go through `send`, the turn ends at its result. Claude Code only. */
  open?(spec: Omit<RunSpec, 'prompt'>, onEvent: (e: AgentEvent) => void): LiveHandle
}

export const adapters: Record<AgentKind, AgentAdapter> = {
  'claude-code': claudeCode,
  codex,
}

export { buildArgs, buildLiveArgs, claudeCode, liveParser, parseClaudeLine } from './claude-code.ts'
export { buildArgs as buildCodexArgs, codex, parseCodexLine } from './codex.ts'
