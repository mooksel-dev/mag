// get_pack, propose_rule and the pack in a topic's prompt (deliverables-library-claims-review-and.3).
import { randomUUID } from 'node:crypto'
import type { AgentSession, ChatItem } from '@mag/core'
import { isKind, slugOf, workspaceFolder, type Deliverable, type Deliverables, type Origin } from './core/services/deliverables/index.ts'
import { packText, rubricText, type Pack, type Packs } from './core/services/packs/index.ts'
import type { Store } from './store'

type RuleItem = Extract<ChatItem, { kind: 'rule' }>

export interface PackPrompts {
  /** The pack of `kind` in a workspace, with its project's overrides (projectId null: none). */
  packAt(workspaceId: string, projectId: string | null, kind: string): Pack
  /**
   * A session's next turn (a topic's or its children's): the packs of the kinds its topic's deliverables are, each only
   * when it was not shown to the session as it is now; '' when there is none.
   */
  blockFor(session: AgentSession): string
  /** The pack was shown to the session (get_pack): its next turn does not repeat it. */
  shown(sessionId: string, pack: Pack): void
  /** The user's Accept (appends the rule to its rules.md) or Reject (writes nothing) on a propose_rule card. */
  answerRule(sessionId: string, itemId: string, accept: boolean): void
}

const text = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** `originOf`: where a session's deliverables are made (deliverableOrigin). */
export function createPackPrompts(deps: { store: Store; packs: Packs; deliverables: () => Deliverables | undefined; originOf: (session: AgentSession) => Origin }): PackPrompts {
  const { store, packs } = deps
  const seen = new Map<string, Map<string, string>>()
  // A project deleted since: the workspace's pack.
  const projectFolder = (projectId: string | null) => {
    const p = projectId ? store.data.projects.find((x) => x.id === projectId) : undefined
    return p ? slugOf(p.name, 'project') : null
  }
  const self: PackPrompts = {
    packAt: (workspaceId, projectId, kind) => packs.resolve(workspaceFolder(store.workspace(workspaceId).name), projectFolder(projectId), kind),
    blockFor(session) {
      const dlv = deps.deliverables()
      if (!dlv || session.taskId) return ''
      const origin = deps.originOf(session)
      if (!origin.topicId) return ''
      const kinds = [...new Set(dlv.list({ topicIds: [origin.topicId] }).map((d) => d.kind))].sort()
      const blocks = kinds.flatMap((kind) => {
        const pack = self.packAt(origin.workspaceId, origin.projectId, kind)
        const t = packText(pack)
        if (!t || seen.get(session.id)?.get(kind) === t) return []
        self.shown(session.id, pack)
        return [t]
      })
      return blocks.join('\n\n')
    },
    shown(sessionId, pack) {
      const m = seen.get(sessionId) ?? new Map<string, string>()
      m.set(pack.kind, packText(pack))
      seen.set(sessionId, m)
    },
    answerRule(sessionId, itemId, accept) {
      const session = store.session(sessionId)
      const item = session.items.find((i): i is RuleItem => i.kind === 'rule' && i.id === itemId)
      if (!item) throw new Error('No such rule card')
      if (item.status !== 'proposed') throw new Error(`This rule is ${item.status} already`)
      if (accept) {
        const project = item.scope === 'project' ? item.projectId : null
        item.path = packs.addRule(workspaceFolder(store.workspace(item.workspaceId).name), projectFolder(project), item.pack, item.rule, item.why)
        item.status = 'accepted'
      } else item.status = 'rejected'
      store.itemChanged(sessionId, item)
      const said = accept ? `The user accepted the rule for the ${item.pack} pack; it is in ${item.path}: ${item.rule}` : `The user rejected the rule for the ${item.pack} pack; nothing was written: ${item.rule}`
      store.pushItem(sessionId, { kind: 'notice', text: accept ? `Rule added to the ${item.pack} pack` : `Rule rejected`, at: Date.now(), forAgent: true, agentText: said })
    },
  }
  return self
}

export function packTool(pp: PackPrompts | undefined, store: Store, origin: Origin, sessionId: string | undefined, name: 'get_pack' | 'propose_rule', args: Record<string, unknown>): string {
  if (!pp) throw new Error('Packs are not ready yet')
  const kind = text(args.kind)
  if (!isKind(kind)) throw new Error(`kind must be a deliverable kind: report, assessment, proposal, decision, reply, ticket, agenda, other`)
  if (name === 'get_pack') {
    const pack = pp.packAt(origin.workspaceId, origin.projectId, kind)
    const t = packText(pack)
    if (sessionId) pp.shown(sessionId, pack)
    return t || `No ${kind} pack yet. The user can write one; propose_rule starts its rules.md.`
  }
  const session = sessionId ? store.data.sessions.find((s) => s.id === sessionId) : undefined
  if (!session) throw new Error('propose_rule needs a chat to show its card in')
  const rule = text(args.rule)
  if (!rule) throw new Error('Pass rule: one line, as the user would want it followed')
  const scope = args.scope === 'project' ? 'project' : 'workspace'
  if (scope === 'project' && !origin.projectId) throw new Error('This topic has no project: propose it for the workspace')
  const why = text(args.why)
  // One card per rule while it waits for the user.
  const waiting = session.items.find((i): i is RuleItem => i.kind === 'rule' && i.status === 'proposed' && i.pack === kind && i.rule === rule && i.scope === scope)
  if (!waiting)
    store.pushItem(session.id, { kind: 'rule', id: randomUUID(), pack: kind, rule, why, scope, workspaceId: origin.workspaceId, projectId: scope === 'project' ? origin.projectId : null, status: 'proposed', at: Date.now() })
  return `The user sees the rule on a card; Accept adds it to the ${kind} pack's rules.md (${scope === 'project' ? "the project's" : "the workspace's"}), Reject drops it. Go on; mag tells you their answer with your next message.`
}

/** What a verifier of `d` judges by: the rubric and rules of its kind's pack where it was made. */
export function verifierRubric(pp: PackPrompts | undefined, d: Pick<Deliverable, 'workspaceId' | 'projectId' | 'kind'>): string {
  return pp ? rubricText(pp.packAt(d.workspaceId, d.projectId, d.kind)) : ''
}
