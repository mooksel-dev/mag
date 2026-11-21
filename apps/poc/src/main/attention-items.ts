import type { InboxKind, Project, Task } from '@mag/core'
import type { InboxEntry } from './core/services/inbox/index.ts'

/** Inbox kinds that get a system notification. Approvals don't: they come up while a chat is being watched. */
const NOTIFY: string[] = ['question', 'agent_failed', 'check_failed', 'ready_to_merge', 'ready_to_start'] satisfies InboxKind[]

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

/** Notifiable items of the workspace inbox (snoozed and done ones are not in it). */
export function attentionItems(items: InboxEntry[], projects: Project[], tasks: Task[]): Attention[] {
  return items.flatMap((i): Attention[] => {
    const task = i.taskId ? tasks.find((t) => t.id === i.taskId) : undefined
    const project = projects.find((p) => p.id === i.projectId)
    if (!task || !project || !NOTIFY.includes(i.kind)) return []
    return [{ key: `${i.key}:${i.text}`, projectId: project.id, taskId: task.id, title: project.name, body: `${task.key}: ${i.text}` }]
  })
}

/** Items not in `seen`; `seen` becomes the current set, so an item that leaves and comes back is new again. */
export function newAttention(seen: Set<string>, items: Attention[]): Attention[] {
  const fresh = items.filter((i) => !seen.has(i.key))
  seen.clear()
  for (const i of items) seen.add(i.key)
  return fresh
}
