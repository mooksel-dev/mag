import { randomUUID } from 'node:crypto'
import { ASKING_MODES, ASKING_ROLES, approvalName, integrationMode, integrationOf, runRole, type AgentSession, type ChatItem, type Destination } from '@mag/core'
import type { Store } from './store'
import { blockedPush, projectBases } from './git-push.ts'
import { classify, isAuto } from './core/lib/destinations/index.ts'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

/** What the agent gets on a deny: a write sent back with the user's note (the Publish card's Edit) is to be revised. */
const deniedMessage = (item: ApprovalItem) =>
  !item.note ? 'User denied' : item.destination ? `User sent it back to revise: ${item.note}\nRewrite it and ask again.` : `User denied: ${item.note}`

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

/** What park answers: the user's decision, or pending while the poll ran out first; a deny carries what the agent gets. */
export type ParkResult = { status: 'pending' | 'allowed' | 'expired' } | { status: 'denied'; message: string }

/** A write parked by the publish tool: the call the card shows, as approve_tool would park it. */
export interface ParkedWrite {
  /** Stable across the polls of one call: a repeated poll finds its item. */
  id: string
  tool: string
  server?: string
  input: unknown
  destination: Destination
}

const DEFAULT_TIMINGS: ApprovalTimings = { pollMs: 50_000, graceMs: 15_000 }

const grantKey = (toolName: string, input: unknown) => `${toolName}\n${JSON.stringify(input ?? {})}`

const deny = (message: string) => JSON.stringify({ behavior: 'deny', message })
const allow = (input: unknown) => JSON.stringify({ behavior: 'allow', updatedInput: input ?? {} })

/**
 * Tool calls that wait for the user: every call of an integration on ask, and every write to a destination
 * (publish-gate-for-every-outbound.1): an integration's write on reads, and a known CLI write (gh, acli) of a chat,
 * owner or groomer. A write to a destination on the project's auto list runs at once. The permission prompt tool parks
 * each as an approval chat item (with its destination) until the user allows or denies it on its card. Anything else
 * such a session asks for runs at once, as Claude Code would for the user (a read, a push of its branch, a file outside
 * the repo): mag never holds back what the CLI can do, and nothing waits without a card. A push to a base branch is
 * denied. Requests long-poll; the MCP server repeats them while pending.
 */
export class Approvals {
  /** Wake-ups of the polls waiting per approval id. */
  private waiting = new Map<string, Set<() => void>>()
  private expiry = new Map<string, NodeJS.Timeout>()
  /** Per session: calls (tool and input) the user allowed through publish, each good for one run. */
  private grants = new Map<string, Set<string>>()
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
    const project = this.store.sessionScope(session)
    const blocked = typeof command === 'string' ? blockedPush(command, projectBases(project, this.store.data.tasks)) : null
    if (blocked) return deny(blocked)
    const destination = classify(asked.tool, asked.server, args.input)
    // A read (of an integration on reads, or anything not on ask) runs at once; so does a write the project publishes unasked.
    if (!destination ? !asked.server || asked.reads : isAuto(destination, project.publish)) return allow(args.input)

    // The call a publish payload's Allow granted runs once without a second card.
    if (destination && this.takeGrant(session.id, toolName, args.input)) return allow(args.input)

    // A repeated poll carries the same tool_use_id and finds its item.
    const useId = typeof args.tool_use_id === 'string' && args.tool_use_id ? args.tool_use_id : undefined
    const item =
      this.item(session, useId) ??
      this.add(session, { id: useId ?? randomUUID(), tool: asked.tool, ...(asked.server && { server: asked.server }), input: args.input ?? {}, ...(destination && { destination }) })
    await this.settle(session.id, item, ctx.signal)
    if (item.status === 'pending') return JSON.stringify({ pending: true })
    if (item.status === 'allowed') return JSON.stringify({ behavior: 'allow', updatedInput: item.input })
    if (item.status === 'denied') return deny(deniedMessage(item))
    return deny('The request expired before the user answered')
  }

  /**
   * The publish tool's card (publish-gate-for-every-outbound.3): parks `write` on the session as approve_tool parks a
   * write, with the same card, wait and expiry, and answers the user's decision; pending when the poll ran out first.
   * A repeated poll with the same id finds its item again.
   */
  async park(ctx: ApprovalContext, write: ParkedWrite): Promise<ParkResult> {
    const session = ctx.sessionId ? this.store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
    if (!session) throw new Error('publish needs a session to show its card in')
    const item = this.item(session, write.id) ?? this.add(session, { id: write.id, tool: write.tool, ...(write.server && { server: write.server }), input: write.input ?? {}, destination: write.destination })
    await this.settle(session.id, item, ctx.signal)
    return item.status === 'denied' ? { status: 'denied', message: deniedMessage(item) } : { status: item.status }
  }

  /** Lets the session's next call of `toolName` with exactly this input run without a card: a publish payload the user allowed. */
  grant(sessionId: string, toolName: string, input: unknown) {
    const set = this.grants.get(sessionId) ?? new Set()
    set.add(grantKey(toolName, input))
    this.grants.set(sessionId, set)
  }

  private takeGrant(sessionId: string, toolName: string, input: unknown) {
    const set = this.grants.get(sessionId)
    const key = grantKey(toolName, input)
    if (!set?.has(key)) return false
    set.delete(key)
    if (!set.size) this.grants.delete(sessionId)
    return true
  }

  /** Waits up to pollMs for the user's decision on a pending item; one still pending expires unless polled again. */
  private async settle(sessionId: string, item: ApprovalItem, signal?: AbortSignal) {
    clearTimeout(this.expiry.get(item.id))
    if (item.status === 'pending') await this.wait(item.id, signal)
    if (item.status === 'pending') this.expireLater(sessionId, item)
  }

  /**
   * What the session may ask the user for: an integration in ask mode for its role, or any tool in a role that asks;
   * else null (denied).
   */
  private asked(session: AgentSession, toolName: string): (Pick<ApprovalItem, 'tool' | 'server'> & { reads?: boolean }) | null {
    const found = integrationOf(toolName, this.store.data.integrations)
    if (found) {
      const mode = integrationMode(this.store.sessionScope(session), runRole(session), found.integration.id)
      return ASKING_MODES.includes(mode) ? { tool: found.tool, server: found.integration.name, reads: mode === 'reads' } : null
    }
    return toolName && ASKING_ROLES.includes(runRole(session)) ? { tool: toolName } : null
  }

  /** The user's answer; wakes the waiting poll and logs it. `note`: the user's words on a deny, which the agent gets. */
  decide(sessionId: string, approvalId: string, allow: boolean, note?: string) {
    const session = this.store.session(sessionId)
    const item = this.item(session, approvalId)
    if (!item) throw new Error(`No approval ${approvalId}`)
    if (item.status !== 'pending') throw new Error(`Approval is already ${item.status}`)
    item.status = allow ? 'allowed' : 'denied'
    const said = note?.trim()
    if (!allow && said) item.note = said
    clearTimeout(this.expiry.get(item.id))
    this.expiry.delete(item.id)
    this.store.itemChanged(sessionId, item)
    const task = session.taskId ? this.store.data.tasks.find((t) => t.id === session.taskId) : undefined
    // A topic without a project has no project log.
    if (session.projectId) this.store.logEvent({
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

  private add(session: AgentSession, a: Pick<ApprovalItem, 'id' | 'tool' | 'server' | 'input' | 'destination'>): ApprovalItem {
    const item: ApprovalItem = { kind: 'approval', ...a, status: 'pending', at: Date.now() }
    this.store.pushItem(session.id, item)
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

  private expireLater(sessionId: string, item: ApprovalItem) {
    clearTimeout(this.expiry.get(item.id))
    this.expiry.set(
      item.id,
      setTimeout(() => {
        this.expiry.delete(item.id)
        if (item.status !== 'pending' || this.waiting.has(item.id)) return
        item.status = 'expired'
        this.store.itemChanged(sessionId, item)
      }, this.timings.graceMs),
    )
  }
}
