import type { AppState } from '../preload/api'
import type { Store } from './store'

/** Runs `fn` once for any number of calls within one macrotask. */
export function coalesce(fn: () => void, schedule: (run: () => void) => void = setImmediate): () => void {
  let pending = false
  return () => {
    if (pending) return
    pending = true
    schedule(() => {
      pending = false
      fn()
    })
  }
}

/** The state every window gets: sessions as headers, canvases without HTML, no window layout. */
export function appState(store: Store, extra: Pick<AppState, 'claudeBin' | 'appVersion' | 'openProjects'>): AppState {
  const { canvases: _, ui: __, sessions: ___, ...data } = store.data
  return { ...data, sessions: store.sessionHeaders(), canvases: store.canvasList(), ...extra }
}
