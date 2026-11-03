// The work list (ux-odna-rozmova-na-robotu.2): the left column of the project window, one list of works (reviews of
// teammates' PRs included) and topics without a work, instead of the Home, Tasks and Reviews tabs.

import { inbox, isReview, reviewTopic, type AgentRole, type AgentSession, type InboxKind, type Task } from './index.ts'

/** waiting = on the user; working = an agent runs; open = planning, ready or in progress with nothing running. */
export type WorkGroup = 'waiting' | 'working' | 'open' | 'topics' | 'done'

export const WORK_GROUPS: WorkGroup[] = ['waiting', 'working', 'open', 'topics', 'done']

export const WORK_GROUP_LABELS: Record<WorkGroup, string> = {
  waiting: 'Waiting on you',
  working: 'Agents working',
  open: 'Planning · ready',
  topics: 'Topics without a work',
  done: 'Done · 7d',
}

export type WorkListItem =
  | {
      kind: 'work'
      group: WorkGroup
      task: Task
      /** waiting: what waits on the user (the most urgent of the work's inbox items). */
      badge?: InboxKind
      /** waiting: the inbox item's line. */
      text?: string
      /** working: the agent that runs and since when. */
      agent?: { role: AgentRole; since: number }
      /** Last activity: the work's update or its sessions' last item. */
      at: number
    }
  | { kind: 'topic'; group: WorkGroup; session: AgentSession; badge?: InboxKind; text?: string; at: number }

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** When a session last did something: its last item, else when its run started or it was created. */
export function sessionActivity(s: AgentSession): number {
  return Math.max(s.items.at(-1)?.at ?? 0, s.runStartedAt ?? 0, s.createdAt)
}

/**
 * The project's works and the topics that own no open work, grouped and ordered (`tasks` are the project's): waiting on
 * the user first, then agents working, planning and ready, topics, and done in the last 7 days; canceled works are left
 * out. A work's agents are its own sessions and, for a work owned by a topic (a review too), that topic. Within a
 * group the most recent activity comes first.
 */
export function workList(projectId: string, tasks: Task[], sessions: AgentSession[], now: number): WorkListItem[] {
  const items = inbox(projectId, tasks, sessions)
  const mine = sessions.filter((s) => s.projectId === projectId)
  const works = tasks.filter((t) => !t.parentId && t.projectId === projectId && t.status !== 'canceled')
  const out: WorkListItem[] = []
  // A topic that owns several open works opens as the latest updated one (as App does): its approvals count for that one.
  const latestOwned = new Map<string, Task>()
  for (const t of works) {
    if (t.status === 'done' || !t.ownerSessionId) continue
    const prev = latestOwned.get(t.ownerSessionId)
    if (!prev || t.updatedAt > prev.updatedAt) latestOwned.set(t.ownerSessionId, t)
  }
  for (const task of works) {
    const own = mine.filter((s) => s.taskId === task.id || s.id === task.ownerSessionId)
    const at = Math.max(task.updatedAt, ...own.map(sessionActivity))
    // A pending approval in the owner topic counts for the work too.
    const ownsTopic = !!task.ownerSessionId && latestOwned.get(task.ownerSessionId) === task
    const item = items.find((i) => i.task?.id === task.id || (!i.task && ownsTopic && i.session?.id === task.ownerSessionId))
    const finished = task.status === 'done'
    if (item && !finished) {
      out.push({ kind: 'work', group: 'waiting', task, badge: item.kind, text: item.text, at })
      continue
    }
    const running = finished ? undefined : own.filter((s) => s.status === 'running').sort((a, b) => (b.runStartedAt ?? 0) - (a.runStartedAt ?? 0))[0]
    if (running) out.push({ kind: 'work', group: 'working', task, agent: { role: running.role, since: running.runStartedAt ?? running.createdAt }, at })
    else if (!finished) out.push({ kind: 'work', group: 'open', task, at })
    else if (task.updatedAt >= now - WEEK_MS) out.push({ kind: 'work', group: 'done', task, at })
  }
  // A topic that owns an open work shows through it; a topic mag created for a review is that review's.
  const owners = new Set(works.filter((t) => t.status !== 'done').map((t) => t.ownerSessionId))
  for (const s of mine) {
    if (s.role !== 'chat' || s.taskId || s.reviewOf || owners.has(s.id)) continue
    if (tasks.some((t) => isReview(t) && reviewTopic(t, sessions)?.id === s.id)) continue
    const approval = items.find((i) => i.kind === 'approval' && i.session?.id === s.id)
    out.push(approval
      ? { kind: 'topic', group: 'waiting', session: s, badge: 'approval', text: approval.text, at: sessionActivity(s) }
      : { kind: 'topic', group: 'topics', session: s, at: sessionActivity(s) })
  }
  return out.sort((a, b) => WORK_GROUPS.indexOf(a.group) - WORK_GROUPS.indexOf(b.group) || b.at - a.at)
}
