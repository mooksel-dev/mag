import { useCallback, useSyncExternalStore } from 'react'
import type { ChatItem } from '@mag/core'
import { createItemsCache } from './sessionItems'

const cache = createItemsCache((sid) => window.mag.sessionItems(sid), (cb) => void window.mag.onSessionItem(cb))
const NONE: ChatItem[] = []

/** A session's items: [] until they load, then live (see createItemsCache). */
export function useSessionItems(sid: string): ChatItem[] {
  const subscribe = useCallback((fn: () => void) => cache.watch(sid, fn), [sid])
  return useSyncExternalStore(subscribe, () => cache.get(sid) ?? NONE)
}
