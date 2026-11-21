// A session without its items (p0-fast-safe-store-no.1): the state windows get. A window loads the items of the sessions
// it shows (session:items) and applies SessionItemEvents; what the renderer reads across sessions is in the digest.

import type { AgentSession, ChatItem } from './index.ts'

/** Longest text a digest keeps of an item: enough for a line of a card or a legacy review's job (see reviewTopic). */
export const DIGEST_TEXT_MAX = 300

type ItemOf<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>

/** What the renderer reads from a session's items without loading them; texts cut to DIGEST_TEXT_MAX. */
export interface SessionDigest {
  itemCount: number
  /** `at` of the last item; null without items. */
  lastItemAt: number | null
  pendingApprovals: ItemOf<'approval'>[]
  offIntegrations: ItemOf<'integration'>[]
  /** Sum of the turns' reported cost. */
  costUsd: number
  lastTool: ItemOf<'tool'> | null
  lastNotice: ItemOf<'notice'> | null
  lastMessage: ItemOf<'user' | 'assistant'> | null
  lastReply: ItemOf<'assistant'> | null
  /** The first item's text when it is the user's, else null. */
  opening: string | null
}

/** rewound: an undo of the last rewind is there (its items stay in main). */
export type SessionHeader = Omit<AgentSession, 'items' | 'rewound'> & SessionDigest & { rewound: boolean }

/** A session as main holds it (with items) or as windows get it (a header). */
export type SessionLike = AgentSession | SessionHeader

/**
 * A change of a session's items: `item` is now at index `n` (n = the old length appends), or the items are cut to the
 * first `truncate`.
 */
export type SessionItemEvent = { sid: string; n: number; item: ChatItem } | { sid: string; truncate: number }

function lastOf<K extends ChatItem['kind']>(items: ChatItem[], ...kinds: K[]): ItemOf<K> | null {
  for (let i = items.length - 1; i >= 0; i--) if ((kinds as string[]).includes(items[i].kind)) return items[i] as ItemOf<K>
  return null
}

const cut = (text: string) => (text.length > DIGEST_TEXT_MAX ? text.slice(0, DIGEST_TEXT_MAX) : text)

function short<I extends ChatItem>(item: I | null): I | null {
  if (!item) return null
  if ('text' in item && item.text.length > DIGEST_TEXT_MAX) return { ...item, text: cut(item.text) }
  if (item.kind === 'tool' && item.summary.length > DIGEST_TEXT_MAX) return { ...item, summary: cut(item.summary) }
  return item
}

/** A digest whose fields are computed when read: main reads one or two of a full session's on each change. */
function lazyDigest(items: ChatItem[]): SessionDigest {
  return {
    get itemCount() {
      return items.length
    },
    get lastItemAt() {
      return items.at(-1)?.at ?? null
    },
    get pendingApprovals() {
      return items.filter((i): i is ItemOf<'approval'> => i.kind === 'approval' && i.status === 'pending')
    },
    get offIntegrations() {
      return items.filter((i): i is ItemOf<'integration'> => i.kind === 'integration' && i.status === 'off')
    },
    get costUsd() {
      return items.reduce((sum, i) => sum + (i.kind === 'result' ? (i.costUsd ?? 0) : 0), 0)
    },
    get lastTool() {
      return short(lastOf(items, 'tool'))
    },
    get lastNotice() {
      return short(lastOf(items, 'notice'))
    },
    get lastMessage() {
      return short(lastOf(items, 'user', 'assistant'))
    },
    get lastReply() {
      return short(lastOf(items, 'assistant'))
    },
    get opening() {
      return items[0]?.kind === 'user' ? cut(items[0].text) : null
    },
  }
}

export const digestOf = (items: ChatItem[]): SessionDigest => ({ ...lazyDigest(items) })

/** The digest of either shape: computed from a full session's items, read from a header. */
export const sessionDigest = (s: SessionLike): SessionDigest => ('items' in s ? lazyDigest(s.items) : s)

export function sessionHeader(s: AgentSession): SessionHeader {
  const { items, rewound, ...rest } = s
  return { ...rest, ...digestOf(items), rewound: !!rewound }
}

/**
 * Items after an event, as a new array (the same one when nothing changes). An item past the end (a gap) is dropped: it
 * can only come from an event older than the items it is applied to.
 */
export function applyItemEvent(items: ChatItem[], e: SessionItemEvent): ChatItem[] {
  if ('truncate' in e) return e.truncate < items.length ? items.slice(0, e.truncate) : items
  if (e.n > items.length) return items
  const next = items.slice()
  next[e.n] = e.item
  return next
}
