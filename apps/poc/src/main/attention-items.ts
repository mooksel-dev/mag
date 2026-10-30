import { inbox, type AgentSession, type InboxKind, type Project, type Task } from '@mag/core'

/** Inbox kinds that get a system notification. Approvals don't: they come up while a chat is being watched. */
const NOTIFY: InboxKind[] = ['question', 'agent_failed', 'check_failed', 'ready_to_merge', 'ready_to_start']

/** An inbox item a notification can be shown for. */
export interface Attention {
  /** Same while the item stays in the inbox; a new text (another question) is a new item. */
  key: string
  projectId: string
  taskId: string
  /** Project name. */
  title: string
  /** `KEY: text`. */
  body: string
}

/** Notifiable inbox items across all projects. */
export function attentionItems(projects: Project[], tasks: Task[], sessions: AgentSession[]): Attention[] {
  return projects.flatMap((p) =>
    inbox(p.id, tasks.filter((t) => t.projectId === p.id), sessions).flatMap((i): Attention[] =>
      i.task && NOTIFY.includes(i.kind)
        ? [{ key: `${i.task.id}:${i.kind}:${i.text}`, projectId: p.id, taskId: i.task.id, title: p.name, body: `${i.task.key}: ${i.text}` }]
        : [],
    ),
  )
}

/** Items not in `seen`; `seen` becomes the current set, so an item that leaves and comes back is new again. */
export function newAttention(seen: Set<string>, items: Attention[]): Attention[] {
  const fresh = items.filter((i) => !seen.has(i.key))
  seen.clear()
  for (const i of items) seen.add(i.key)
  return fresh
}
