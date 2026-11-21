import { applyItemEvent, type ChatItem, type SessionItemEvent } from '@mag/core'

interface Entry {
  /** null while loading. */
  items: ChatItem[] | null
  /** Events that came while loading, applied on top of what loaded (they are absolute, so a repeat is harmless). */
  pending: SessionItemEvent[]
  listeners: Set<() => void>
}

/**
 * The items of the sessions a window shows (p0-fast-safe-store-no.1): loaded when a session is first watched, kept up
 * to date by item events, dropped when nothing watches it.
 */
export function createItemsCache(load: (sid: string) => Promise<ChatItem[]>, onEvent: (cb: (e: SessionItemEvent) => void) => void) {
  const entries = new Map<string, Entry>()
  const notify = (e: Entry) => e.listeners.forEach((fn) => fn())

  onEvent((e) => {
    const entry = entries.get(e.sid)
    if (!entry) return
    if (!entry.items) return void entry.pending.push(e)
    const next = applyItemEvent(entry.items, e)
    if (next === entry.items) return
    entry.items = next
    notify(entry)
  })

  return {
    /** Follows a session's items; the returned function stops, and the last one to stop drops them. */
    watch(sid: string, listener: () => void): () => void {
      let entry = entries.get(sid)
      if (!entry) {
        const fresh: Entry = { items: null, pending: [], listeners: new Set() }
        entries.set(sid, fresh)
        entry = fresh
        load(sid).then(
          (items) => {
            if (entries.get(sid) !== fresh) return
            fresh.items = fresh.pending.reduce(applyItemEvent, items)
            fresh.pending = []
            notify(fresh)
          },
          () => {
            // A deleted session: nothing to show.
            if (entries.get(sid) !== fresh) return
            fresh.items = []
            notify(fresh)
          },
        )
      }
      const mine = entry
      mine.listeners.add(listener)
      return () => {
        mine.listeners.delete(listener)
        if (!mine.listeners.size && entries.get(sid) === mine) entries.delete(sid)
      }
    },
    /** The items as loaded and updated; undefined while loading or when not watched. */
    get: (sid: string): ChatItem[] | undefined => entries.get(sid)?.items ?? undefined,
  }
}

export type ItemsCache = ReturnType<typeof createItemsCache>
