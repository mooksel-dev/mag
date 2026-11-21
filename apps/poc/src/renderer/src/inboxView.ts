/**
 * What the rail's Inbox section shows (inbox-what-waits-on-me.2): a workspace's inbox entries in groups, their labels for
 * chips and filters, snooze presets and where Open goes.
 */
import { itemLabelIds, type ItemLabel, type ItemRef, type SessionLike, type Task } from '@mag/core'
import type { InboxEntry } from '../../main/core/services/inbox/index.ts'

export type InboxGroup = 'needs' | 'publish' | 'drafts' | 'pr' | 'inbound'

export const INBOX_GROUPS: { id: InboxGroup; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'publish', label: 'Publish' },
  { id: 'drafts', label: 'Drafts to review' },
  { id: 'pr', label: 'PR activity' },
  { id: 'inbound', label: 'Inbound' },
]

export function inboxGroup(e: InboxEntry): InboxGroup {
  if (e.kind === 'approval') return e.destination ? 'publish' : 'needs'
  if (e.kind === 'draft') return 'drafts'
  if (e.kind === 'review_activity') return 'pr'
  if (e.kind === 'inbound') return 'inbound'
  return 'needs'
}

/** Entries of workspace `workspaceId`; one without a workspace shows in every workspace, so it is never lost. */
export const workspaceInbox = (entries: InboxEntry[], workspaceId: string) => entries.filter((e) => e.workspaceId === workspaceId || e.workspaceId === null)

type Session = Pick<SessionLike, 'id' | 'taskId'> & { parentId?: string | null }

/** The top-level task of `taskId`, while it exists. */
const topTask = (taskId: string, tasks: Pick<Task, 'id' | 'parentId'>[]) => {
  const t = tasks.find((x) => x.id === taskId)
  return t?.parentId ? tasks.find((x) => x.id === t.parentId) : t
}

/** The topic a session is under: itself or its top ancestor. */
const rootSession = <S extends Session>(id: string, sessions: S[]): S | undefined => {
  let s = sessions.find((x) => x.id === id)
  for (let n = 0; s?.parentId && n < 100; n++) {
    const parent = sessions.find((x) => x.id === s!.parentId)
    if (!parent) break
    s = parent
  }
  return s
}

/** Where Open goes: the item's work, its topic, or a new topic made only then. */
export type OpenTarget = { kind: 'work'; id: string } | { kind: 'topic'; id: string } | { kind: 'new' }

export function openTarget(e: InboxEntry, tasks: Pick<Task, 'id' | 'parentId'>[], sessions: Session[]): OpenTarget {
  // An added item about a work or topic (a follow-up made from one) opens it.
  const about = /^(work|topic):(.+)$/.exec(e.ref ?? '')
  const taskId = e.taskId ?? (about?.[1] === 'work' ? about[2] : null)
  const sessionId = e.sessionId ?? (about?.[1] === 'topic' ? about[2] : null)
  const work = taskId ? topTask(taskId, tasks) : undefined
  if (work) return { kind: 'work', id: work.id }
  const s = sessionId ? sessions.find((x) => x.id === sessionId) : undefined
  const sessionWork = s?.taskId ? topTask(s.taskId, tasks) : undefined
  if (sessionWork) return { kind: 'work', id: sessionWork.id }
  if (s) return { kind: 'topic', id: s.id }
  return { kind: 'new' }
}

/** The labels item refs carry: the work's or the topic's. */
export function entryRef(e: InboxEntry, tasks: Pick<Task, 'id' | 'parentId'>[], sessions: Session[]): ItemRef | null {
  const t = openTarget(e, tasks, sessions)
  if (t.kind === 'work') return `work:${t.id}`
  if (t.kind === 'topic') return `topic:${rootSession(t.id, sessions)?.id ?? t.id}`
  return null
}

/** Label ids of an entry: its project's, its own, then those on its work or topic; once each. */
export function entryLabelIds(e: InboxEntry, ref: ItemRef | null, itemLabels: ItemLabel[]): string[] {
  const own = ref ? itemLabelIds(ref, e.projectId, itemLabels) : e.projectId ? [e.projectId] : []
  return [...new Set([...own, ...e.labels])]
}

/** 'all', or a label's id (a project's id is its Project label's). */
export type InboxFilter = string

export const inboxMatches = (labelIds: string[], filter: InboxFilter) => filter === 'all' || labelIds.includes(filter)

/** The first message of a topic opened from an item that has none. */
export function openContext(e: InboxEntry): string {
  return [`From the Inbox (${e.kind}): ${e.text}`, e.ref ? `About: ${e.ref}` : ''].filter(Boolean).join('\n')
}

export interface SnoozePreset {
  label: string
  until: number | 'activity'
}

const at9 = (d: Date, addDays: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays, 9, 0, 0, 0).getTime()

/** 1 hour, tomorrow 9:00, the next Monday 9:00 that is still ahead, and until new activity; local time. */
export function snoozePresets(now: number): SnoozePreset[] {
  const d = new Date(now)
  const toMonday = (8 - d.getDay()) % 7
  const monday = toMonday === 0 && at9(d, 0) > now ? at9(d, 0) : at9(d, toMonday || 7)
  return [
    { label: '1 hour', until: now + 60 * 60 * 1000 },
    { label: 'Tomorrow 9:00', until: at9(d, 1) },
    { label: 'Monday 9:00', until: monday },
    { label: 'Until new activity', until: 'activity' },
  ]
}
