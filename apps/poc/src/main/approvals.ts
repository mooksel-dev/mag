import { randomUUID } from 'node:crypto'
import { approvalName, integrationMode, integrationOf, type AgentSession, type ChatItem } from '@mag/core'
import type { Store } from './store'
import { ASKING_ROLES } from './tool-defs.ts'
import { blockedPush, projectBases } from './git-push.ts'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

/** Arguments Claude Code passes to the --permission-prompt-tool. */
export interface ApprovalArgs {
  tool_name?: unknown
  input?: unknown
  tool_use_id?: unknown
}

export interface ApprovalContext {
  sessionId?: string
  /** Aborted when the caller hangs up (the CLI stopped or crashed). */
  signal?: AbortSignal
}

export interface ApprovalTimings {
  /** How long one request waits for the user before answering {"pending":true}. */
  pollMs: number
  /** A pending approval nobody polls for this long expires: its run is gone. */
  graceMs: number
}

const DEFAULT_TIMINGS: ApprovalTimings = { pollMs: 50_000, graceMs: 15_000 }

const deny = (message: string) => JSON.stringify({ behavior: 'deny', message })

/**
 * Tool calls that wait for the user: ask-mode integration calls, and the Bash calls of a chat, owner or groomer that
 * matched an ask rule (their GitHub writes, chat-publishes-to-github-prs.2). The permission prompt tool parks each call
 * as an approval chat item until the user allows or denies it on its card in the work's conversation or the chat.
 * Requests long-poll; the MCP server repeats them while pending.
 */
export class Approvals {
  /** Wake-ups of the polls waiting per approval id. */
  private waiting = new Map<string, Set<() => void>>()
  private expiry = new Map<string, NodeJS.Timeout>()
  private timings: ApprovalTimings

  constructor(
    private store: Store,
    timings: Partial<ApprovalTimings> = {},
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings }
  }

  /** Handler of approve_tool. Returns the CLI's answer as JSON text, or {"pending":true} to be asked again. */
  async request(ctx: ApprovalContext, args: ApprovalArgs): Promise<string> {
    const toolName = String(args.tool_name ?? '')
    const session = ctx.sessionId ? this.store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
    const asked = session && this.asked(session, toolName)
    // Anything else stays denied, as it was before the prompt tool existed.
    if (!session || !asked) return deny(`Permission to use ${toolName || 'this tool'} has not been granted`)
    // A push whose target the deny rules cannot see (bare `git push` in a checkout on main) never reaches the card.
    const command = toolName === 'Bash' && typeof args.input === 'object' && args.input ? (args.input as { command?: unknown }).command : undefined
    const blocked = typeof command === 'string' ? blockedPush(command, projectBases(this.store.project(session.projectId), this.store.data.tasks)) : null
    if (blocked) return deny(blocked)

    // A repeated poll carries the same tool_use_id and finds its item.
    const useId = typeof args.tool_use_id === 'string' && args.tool_use_id ? args.tool_use_id : undefined
    const item = this.item(session, useId) ?? this.add(session, { id: useId ?? randomUUID(), ...asked, input: args.input ?? {} })
    clearTimeout(this.expiry.get(item.id))
    if (item.status === 'pending') await this.wait(item.id, ctx.signal)
    if (item.status === 'pending') {
      this.expireLater(item)
      return JSON.stringify({ pending: true })
    }
    if (item.status === 'allowed') return JSON.stringify({ behavior: 'allow', updatedInput: item.input })
    return deny(item.status === 'denied' ? 'User denied' : 'The request expired before the user answered')
  }

  /**
   * What the session may ask the user for: an integration in ask mode for its role, or Bash in a role that asks
   * (Claude Code sends Bash here only when it matched one of the run's ask rules); else null.
   */
  private asked(session: AgentSession, toolName: string): Pick<ApprovalItem, 'tool' | 'server'> | null {
    const found = integrationOf(toolName, this.store.data.integrations)
    if (found) return integrationMode(this.store.project(session.projectId), session.role, found.integration.id) === 'ask' ? { tool: found.tool, server: found.integration.name } : null
    return toolName === 'Bash' && ASKING_ROLES.includes(session.role) ? { tool: toolName } : null
  }

  /** The user's answer; wakes the waiting poll and logs it. */
  decide(sessionId: string, approvalId: string, allow: boolean) {
    const session = this.store.session(sessionId)
    const item = this.item(session, approvalId)
    if (!item) throw new Error(`No approval ${approvalId}`)
    if (item.status !== 'pending') throw new Error(`Approval is already ${item.status}`)
    item.status = allow ? 'allowed' : 'denied'
    clearTimeout(this.expiry.get(item.id))
    this.expiry.delete(item.id)
    this.store.changed()
    const task = session.taskId ? this.store.data.tasks.find((t) => t.id === session.taskId) : undefined
    this.store.logEvent({
      projectId: session.projectId,
      taskId: session.taskId,
      taskKey: task?.key ?? null,
      kind: 'approval',
      text: `${approvalName(item)} ${item.status}`,
    })
    for (const wake of this.waiting.get(item.id) ?? []) wake()
  }

  private item(session: AgentSession, id: string | undefined) {
    return id ? session.items.find((i): i is ApprovalItem => i.kind === 'approval' && i.id === id) : undefined
  }

  private add(session: AgentSession, a: Pick<ApprovalItem, 'id' | 'tool' | 'server' | 'input'>): ApprovalItem {
    const item: ApprovalItem = { kind: 'approval', ...a, status: 'pending', at: Date.now() }
    session.items.push(item)
    this.store.changed()
    return item
  }

  /** Resolves on a decision, after pollMs, or when the caller hangs up. */
  private wait(id: string, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const set = this.waiting.get(id) ?? new Set()
      this.waiting.set(id, set)
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        set.delete(done)
        if (!set.size) this.waiting.delete(id)
        resolve()
      }
      const timer = setTimeout(done, this.timings.pollMs)
      set.add(done)
      if (signal?.aborted) done()
      else signal?.addEventListener('abort', done)
    })
  }

  private expireLater(item: ApprovalItem) {
    clearTimeout(this.expiry.get(item.id))
    this.expiry.set(
      item.id,
      setTimeout(() => {
        this.expiry.delete(item.id)
        if (item.status !== 'pending' || this.waiting.has(item.id)) return
        item.status = 'expired'
        this.store.changed()
      }, this.timings.graceMs),
    )
  }
}
