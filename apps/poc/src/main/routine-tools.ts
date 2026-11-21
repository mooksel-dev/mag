// save_routine, list_routines and add_inbox_item (routines-scheduled-drafts-and-a.2): a topic sets up a routine from the
// conversation, and a routine's run (or a topic) puts what needs the user in the Inbox; add_follow_up (.3) puts it
// there on a date.
import { createHash } from 'node:crypto'
import { DEFAULT_CHOICE, type ModelChoice, type Project } from '@mag/core'
import type { Inbox } from './core/services/inbox/index.ts'
import type { Routine, Routines } from './core/services/routines/index.ts'
import { nextSlot } from './core/lib/cron/index.ts'
import { dueAtOf } from './core/services/routines/refs.ts'

export interface RoutineToolDeps {
  routines: Pick<Routines, 'list' | 'get' | 'save' | 'addFollowUp' | 'closeFollowUp'>
  inbox: Pick<Inbox, 'add'>
}

/** Who calls: the workspace it works in, its project (null: none), its session and whether it is a routine's run. */
export interface RoutineCaller {
  workspaceId: string
  projectId: string | null
  sessionId: string | null
  drafter: boolean
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const pad = (n: number) => String(n).padStart(2, '0')
const when = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The next `n` times a routine fires, from its nextAt; none when it is off or never fires. */
export function nextRuns(r: Pick<Routine, 'trigger' | 'nextAt'>, n: number): number[] {
  if (r.nextAt === null || r.trigger.kind !== 'schedule') return []
  const out = [r.nextAt]
  while (out.length < n) {
    const next = nextSlot(r.trigger.cron, out[out.length - 1])
    if (next === null) break
    out.push(next)
  }
  return out
}

export type RoutineToolName = 'save_routine' | 'list_routines' | 'add_inbox_item' | 'add_follow_up'

const routineLine = (r: Routine, projects: Project[]) => {
  const project = r.projectId ? projects.find((p) => p.id === r.projectId)?.name : null
  const next = nextRuns(r, 1)[0]
  const model = r.choice ? ` · ${r.choice.agent} ${r.choice.model ?? 'default model'}, effort ${r.choice.effort ?? 'default'}` : ''
  return `- ${r.id} · ${r.name} · ${r.trigger.kind === 'schedule' ? `cron "${r.trigger.cron}"` : r.trigger.kind}${project ? ` · project ${project}` : ''}${model} · ${!r.enabled ? 'off' : next ? `next ${when(next)}` : 'never fires'}\n  prompt: ${r.prompt.replace(/\s+/g, ' ').slice(0, 200)}${r.prompt.length > 200 ? '…' : ''}`
}

const isDefault = (v: unknown) => v === null || (typeof v === 'string' && ['', 'default'].includes(v.trim().toLowerCase()))

/**
 * save_routine's agent, model and effort over the routine's choice (`had`): undefined when none is given (kept); null
 * for the defaults (model "default" with no agent or effort); else the choice, its agent claude-code unless given.
 */
export function choiceArg(args: Record<string, unknown>, had: ModelChoice | null): ModelChoice | null | undefined {
  const given = ['agent', 'model', 'effort'].filter((k) => args[k] !== undefined)
  if (!given.length) return undefined
  if (given.length === 1 && given[0] === 'model' && isDefault(args.model)) return null
  const agent = args.agent !== undefined ? text(args.agent) : (had?.agent ?? DEFAULT_CHOICE.agent)
  const model = args.model !== undefined ? (isDefault(args.model) ? null : text(args.model)) : (had?.agent === agent ? had.model : null)
  const effort = args.effort !== undefined ? (isDefault(args.effort) ? null : text(args.effort)) : (had?.effort ?? null)
  return { agent: agent as ModelChoice['agent'], model, effort: effort as ModelChoice['effort'] }
}

/** A project of the caller's workspace by name or id; null for none (''), throws for an unknown one. */
function projectOf(value: unknown, workspaceId: string, projects: Project[]): string | null {
  const v = text(value)
  if (!v) return null
  const p = projects.find((x) => x.workspaceId === workspaceId && (x.id === v || x.name.toLowerCase() === v.toLowerCase()))
  if (!p) throw new Error(`No project "${v}" in this workspace: ${projects.filter((x) => x.workspaceId === workspaceId).map((x) => x.name).join(', ') || 'it has none'}`)
  return p.id
}

export function routineTool(deps: RoutineToolDeps | undefined, projects: Project[], caller: RoutineCaller, name: RoutineToolName, args: Record<string, unknown>): string {
  if (!deps) throw new Error('Routines are not ready yet')
  const { routines, inbox } = deps
  if (name === 'list_routines') {
    const list = routines.list(caller.workspaceId)
    return list.length ? `${list.map((r) => routineLine(r, projects)).join('\n')}\n\nEdit one with save_routine(id, …).` : 'No routines in this workspace yet. save_routine makes one.'
  }
  if (name === 'save_routine') {
    if (caller.drafter) throw new Error("A routine's run doesn't set up routines: say what to change in its Inbox item")
    const id = text(args.id) || undefined
    if (id && routines.get(id).workspaceId !== caller.workspaceId) throw new Error(`Routine ${id} is in another workspace`)
    const cron = text(args.cron)
    const choice = choiceArg(args, id ? routines.get(id).choice : null)
    const r = routines.save({
      ...(id ? { id } : { workspaceId: caller.workspaceId }),
      ...(args.name !== undefined && { name: text(args.name) }),
      ...(cron && { trigger: { kind: 'schedule', cron } }),
      ...(args.prompt !== undefined && { prompt: text(args.prompt) }),
      ...(args.project !== undefined && { projectId: projectOf(args.project, caller.workspaceId, projects) }),
      ...(choice !== undefined && { choice }),
      ...(typeof args.enabled === 'boolean' && { enabled: args.enabled }),
    })
    const next = nextRuns(r, 3)
    const runsOn = r.choice ? ` on ${r.choice.agent} · ${r.choice.model ?? 'default model'} · effort ${r.choice.effort ?? 'default'}` : ''
    return `Saved routine ${r.id} "${r.name}"${runsOn}${r.enabled ? `; next runs: ${next.map(when).join(', ') || 'none (the cron never fires)'}` : ' (off)'}. The user sees it under Routines; each run lands in the Inbox.`
  }
  if (name === 'add_follow_up') {
    const due = text(args.due)
    if (!due) throw new Error('due is required: YYYY-MM-DD, or YYYY-MM-DD HH:MM')
    const { followUp: f, added } = routines.addFollowUp({ workspaceId: caller.workspaceId, projectId: caller.projectId, who: text(args.who), what: text(args.what), dueAt: dueAtOf(due), sourceRef: text(args.ref) || null })
    return added ? `Follow-up ${f.id} set: ${f.who}: ${f.what}, back in the Inbox ${when(f.dueAt)}.` : `Already followed up: ${f.id} (${f.who}: ${f.what}), due ${when(f.dueAt)}; nothing added.`
  }
  const title = text(args.title)
  if (!title) throw new Error('title is required: one line of what needs the user')
  const why = text(args.why)
  if (!why) throw new Error('why is required: one line of why it needs the user')
  const ref = text(args.ref) || null
  // The same thing added again is the same item: it comes back as new activity, not twice.
  const key = `agent:${createHash('sha1').update(`${caller.workspaceId}\n${ref ?? title}`).digest('hex').slice(0, 16)}`
  inbox.add({ key, kind: 'other', text: `${title} · ${why}`, workspaceId: caller.workspaceId, projectId: caller.projectId, ref, labels: caller.projectId ? [caller.projectId] : [] })
  return 'Added to the Inbox. The user sees it with its Open, Snooze and Done.'
}
