// The summary of an archived chat (archive-of-chats-summaries-search.1): closing a topic, a work or a review (the
// redesign's Close, shown as Archive) writes one with the cheap model, so it can be found and referenced later.

import type { AgentSession, ChatItem, Task } from './index.ts'

/** What a closed topic or work was about; `keywords` include files, PRs and links. */
export interface ChatSummary {
  title: string
  /** 3-6 lines. */
  gist: string[]
  decisions: string[]
  open: string[]
  keywords: string[]
}

/** Longest text a summary run reads; a longer one keeps its start and its end. */
export const SUMMARY_SOURCE_MAX = 60_000

const isTask = (item: AgentSession | Task): item is Task => !('items' in item)

const ownerTopic = (task: Task, sessions: AgentSession[]) => sessions.find((s) => s.id === task.ownerSessionId)

const said = (items: ChatItem[]) => items.filter((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'job')

/** `at` of the last item a summary of `item` covers: a topic's last message, a work's owner topic's (else its creation). */
export function summaryCovers(item: AgentSession | Task, sessions: AgentSession[]): number {
  const items = isTask(item) ? (ownerTopic(item, sessions)?.items ?? []) : item.items
  const last = said(items).at(-1)?.at
  return last ?? (isTask(item) ? item.createdAt : 0)
}

/** Archived: a closed topic; a closed or canceled work or review (never a step). */
export function isArchived(item: AgentSession | Task): boolean {
  if (!isTask(item)) return !!item.closedAt
  return !item.parentId && (!!item.closedAt || item.status === 'canceled')
}

/** Archived, with something to summarize, and without a summary covering its last item. */
export function needsSummary(item: AgentSession | Task, sessions: AgentSession[]): boolean {
  if (!isArchived(item)) return false
  if (!isTask(item) && said(item.items).length === 0) return false
  return item.summaryAt == null || !item.summary || item.summaryAt < summaryCovers(item, sessions)
}

function transcript(items: ChatItem[]): string {
  return said(items)
    .map((i) => (i.kind === 'user' ? `User: ${i.text}` : i.kind === 'assistant' ? `Assistant: ${i.text}` : `mag (${i.title}): ${i.text}`))
    .join('\n\n')
}

/** Keeps the start and the end of a text longer than `max`. */
export function trimMiddle(text: string, max = SUMMARY_SOURCE_MAX): string {
  if (text.length <= max) return text
  const marker = '\n\n[…]\n\n'
  const half = Math.floor((max - marker.length) / 2)
  return text.slice(0, half) + marker + text.slice(text.length - half)
}

/** The text a summary is written from: a topic's messages; a work's (or review's) doc, then its owner topic's messages. */
export function summarySource(item: AgentSession | Task, sessions: AgentSession[], doc = ''): string {
  if (!isTask(item)) return trimMiddle(`Topic: ${item.title ?? ''}\n\n${transcript(item.items)}`)
  const topic = ownerTopic(item, sessions)
  const parts = [`${item.type === 'review' ? 'Review' : 'Work'} ${item.key}: ${item.title}`, doc.trim() && `Document:\n${doc.trim()}`, topic && `Conversation:\n${transcript(topic.items)}`]
  return trimMiddle(parts.filter(Boolean).join('\n\n'))
}

export function summaryPrompt(source: string): string {
  return [
    'Summarize this archived conversation so it can be found and understood later. Write in the language of the conversation.',
    'Reply with JSON only, no prose and no code fence:',
    '{"title": "3-8 words", "gist": ["3 to 6 short lines: what it was about and how it ended"], "decisions": ["what was decided"], "open": ["questions left open"], "keywords": ["names, files, PRs, links, terms to search by"]}',
    'Leave an array empty when there is nothing for it.',
    '',
    '<conversation>',
    source,
    '</conversation>',
  ].join('\n')
}

const strings = (v: unknown, max: number): string[] | null => {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') v = v.split('\n')
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null
  return (v as string[]).map((s) => s.trim()).filter(Boolean).slice(0, max)
}

/** The summary from a summary run's reply (JSON, maybe fenced or with text around it), or null if it isn't one. */
export function parseSummary(raw: string): ChatSummary | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || typeof o.title !== 'string' || !o.title.trim()) return null
  const gist = strings(o.gist, 6)
  const decisions = strings(o.decisions, 20)
  const open = strings(o.open, 20)
  const keywords = strings(o.keywords, 40)
  if (!gist?.length || !decisions || !open || !keywords) return null
  return { title: o.title.trim().slice(0, 120), gist, decisions, open, keywords }
}
