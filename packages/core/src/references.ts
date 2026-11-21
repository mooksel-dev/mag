// References to other chats (archive-of-chats-summaries-search.3): "@" in the composer or a row's "Reference in current
// chat" puts a ChatRef on the user's message; the agent gets the referenced chat's summary in its prompt and reads the
// whole history with the mag tool read_chat.

import type { AgentSession, ChatItem, SessionLike, Task } from './index.ts'
import { isArchived } from './summary.ts'
import { shortTitle, type ChatRef } from './work-list.ts'

const isTask = (item: SessionLike | Task): item is Task => 'type' in item

/** A referenced chat as the composer, the bubble and the prompt show it. */
export interface RefTarget<S extends SessionLike = AgentSession> {
  ref: ChatRef
  item: S | Task
  title: string
  /** A work's or review's key. */
  key: string | null
  archived: boolean
}

/** The chat a ref points at, or null when it is gone. */
export function resolveRef<S extends SessionLike>(ref: ChatRef, tasks: Task[], sessions: S[]): RefTarget<S> | null {
  const item = ref.kind === 'topic' ? sessions.find((s) => s.id === ref.id) : tasks.find((t) => t.id === ref.id)
  if (!item) return null
  return { ref, item, title: shortTitle(item), key: 'key' in item ? item.key : null, archived: isArchived(item) }
}

/** Well-formed refs (they come over IPC) without duplicates, in their order. */
export function uniqueRefs(refs: unknown): ChatRef[] {
  if (!Array.isArray(refs)) return []
  const seen = new Set<string>()
  return refs.filter((r): r is ChatRef => {
    if (!r || (r.kind !== 'topic' && r.kind !== 'task') || typeof r.id !== 'string' || !r.id) return false
    const k = `${r.kind}:${r.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * What goes before the user's text when the message references chats: per chat its title, key, whether it is
 * archived, its summary (title only without one) and how to read it whole. Empty when no ref resolves.
 */
export function referencesBlock(refs: ChatRef[], tasks: Task[], sessions: AgentSession[]): string {
  const targets = uniqueRefs(refs).flatMap((r) => resolveRef(r, tasks, sessions) ?? [])
  if (!targets.length) return ''
  const id = (t: RefTarget) => t.key ?? t.ref.id
  const parts = targets.map((t) => {
    const s = t.item.summary
    const what = t.ref.kind === 'topic' ? 'Topic' : isTask(t.item) && t.item.type === 'review' ? 'Review' : 'Work'
    const lines = [`## ${what}${t.key ? ` ${t.key}` : ''}: ${t.title}${t.archived ? ' (archived)' : ''}`, `read_chat id: ${id(t)}`]
    if (s) {
      lines.push(...s.gist)
      if (s.decisions.length) lines.push('Decisions:', ...s.decisions.map((d) => `- ${d}`))
      if (s.open.length) lines.push('Open questions:', ...s.open.map((d) => `- ${d}`))
      if (s.keywords.length) lines.push(`Keywords: ${s.keywords.join(', ')}`)
    } else lines.push('(no summary yet)')
    return lines.join('\n')
  })
  return [
    '<referenced-chats>',
    'The user references these chats of this project. Their summaries follow; call read_chat(id) for the full history when you need more.',
    '',
    parts.join('\n\n'),
    '</referenced-chats>',
  ].join('\n')
}

/** Characters of one read_chat page. */
export const TRANSCRIPT_PAGE = 40_000

const time = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

function line(i: ChatItem): string | null {
  switch (i.kind) {
    case 'user':
      return `[${time(i.at)}] User: ${i.text}${i.refs?.length ? ` (references ${i.refs.map((r) => r.id).join(', ')})` : ''}`
    case 'assistant':
      return `[${time(i.at)}] Assistant: ${i.text}`
    case 'job':
      return `[${time(i.at)}] mag (${i.title}): ${i.text}`
    case 'tool':
      return `[${time(i.at)}] tool ${i.name} ${i.summary}`.replace(/\s+/g, ' ').trim()
    default:
      return null
  }
}

/** A session's messages, a tool call on one line each. */
function sessionText(s: AgentSession): string {
  return s.items.flatMap((i) => line(i) ?? []).join('\n\n')
}

const topicHead = (s: AgentSession) => `Topic: ${shortTitle(s)}${isArchived(s) ? ' (archived)' : ''}\n\n`

/** Where item `n` of a topic starts in its chatTranscript (the next message's line when it has none). */
export function itemOffset(s: AgentSession, n: number): number {
  const before = s.items.slice(0, Math.max(0, n)).flatMap((i) => line(i) ?? []).join('\n\n')
  return topicHead(s).length + (before ? before.length + 2 : 0)
}

/**
 * A chat's history for read_chat, one page of `limit` characters from `offset`: a topic's messages; a work's (or
 * review's) title, doc, then its owner topic's messages. `next`: the offset of the next page, null on the last one.
 */
export function chatTranscript(item: AgentSession | Task, sessions: AgentSession[], doc = '', offset = 0, limit = TRANSCRIPT_PAGE): { text: string; next: number | null } {
  let full: string
  if (!isTask(item)) full = `${topicHead(item)}${sessionText(item)}`
  else {
    const topic = sessions.find((s) => s.id === item.ownerSessionId)
    full = [
      `${item.type === 'review' ? 'Review' : 'Work'} ${item.key}: ${item.title} (${item.status}${isArchived(item) ? ', archived' : ''})`,
      doc.trim() ? `Document:\n${doc.trim()}` : 'Document: (empty)',
      topic ? `Conversation:\n${sessionText(topic)}` : 'Conversation: (none)',
    ].join('\n\n')
  }
  const start = Math.max(0, Math.floor(offset))
  const end = start + Math.max(1, Math.floor(limit))
  return { text: full.slice(start, end), next: end < full.length ? end : null }
}
