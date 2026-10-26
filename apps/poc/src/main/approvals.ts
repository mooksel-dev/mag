import { randomUUID } from 'node:crypto'
import { integrationMode, integrationOf, type AgentSession, type ChatItem } from '@mag/core'
import type { Store } from './store'

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
 * Ask-mode integration calls: the permission prompt tool parks each call as an approval chat item until the user
 * allows or denies it in Home or the chat. Requests long-poll; the MCP server repeats them while pending.
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
    const found = integrationOf(toolName, this.store.data.integrations)
    // Anything that isn't an ask-mode integration stays denied, as it was before the prompt tool existed.
    if (!session || !found || integrationMode(this.store.project(session.projectId), session.role, found.integration.id) !== 'ask')
      return deny(`Permission to use ${toolName || 'this tool'} has not been granted`)

    // A repeated poll carries the same tool_use_id and finds its item.
    const useId = typeof args.tool_use_id === 'string' && args.tool_use_id ? args.tool_use_id : undefined
    const item =
      this.item(session, useId) ??
      this.add(session, { id: useId ?? randomUUID(), tool: found.tool, server: found.integration.name, input: args.input ?? {} })
    clearTimeout(this.expiry.get(item.id))
    if (item.status === 'pending') await this.wait(item.id, ctx.signal)
    if (item.status === 'pending') {
      this.expireLater(item)
      return JSON.stringify({ pending: true })
    }
    if (item.status === 'allowed') return JSON.stringify({ behavior: 'allow', updatedInput: item.input })
    return deny(item.status === 'denied' ? 'User denied' : 'The request expired before the user answered')
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
      text: `${item.server} · ${item.tool} ${item.status}`,
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
