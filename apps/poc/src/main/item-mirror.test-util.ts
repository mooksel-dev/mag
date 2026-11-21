import { applyItemEvent, type ChatItem } from '@mag/core'
import type { Store } from './store.ts'

/**
 * A session's items as an open chat sees them: what they were, then every item event, cloned as IPC clones it (so an
 * item changed in place without an event stays stale here). Returns the items now.
 */
export function mirrorItems(store: Store, sid: string): () => ChatItem[] {
  let items = structuredClone(store.items(sid))
  store.onItem((e) => {
    if (e.sid === sid) items = applyItemEvent(items, structuredClone(e))
  })
  return () => items
}
