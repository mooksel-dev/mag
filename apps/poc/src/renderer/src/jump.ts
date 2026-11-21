import { useSyncExternalStore } from 'react'

/** Where a search hit opened (unified-search-across-the-workspace.2): the screen it opened scrolls there, then clears it. */
export type Jump = { kind: 'item'; sessionId: string; n: number } | { kind: 'person'; workspaceId: string; name: string }

let pending: Jump | null = null
const listeners = new Set<() => void>()

export function setJump(j: Jump | null) {
  pending = j
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** The pending jump `match` takes, else null; the screen calls setJump(null) once it has scrolled. */
export function useJump<J extends Jump>(match: (j: Jump) => j is J): J | null {
  const j = useSyncExternalStore(subscribe, () => pending)
  return j && match(j) ? j : null
}

let opener: ((ref: string, title: string) => void) | null = null

/** The window's opener of search hits (App's); a hit chip on a message opens with it. */
export function setHitOpener(fn: typeof opener) {
  opener = fn
}

export function openHit(ref: string, title: string) {
  opener?.(ref, title)
}
