// The workspace inbox (inbox-what-waits-on-me.1): what waits on the user across all projects. Items with a source of
// their own (tasks, sessions, PR activity) are derived each time; only items without one are stored (add), and the
// user's snooze and done.
import type { Destination, InboxItem, InboxKind } from '@mag/core'

/** Kinds of items added by a source that keeps no state of its own (a routine's output, a triager's inbound ask). */
export type AddedKind = 'draft' | 'inbound' | 'follow_up' | 'other'

/** An item added with add(item); stored until resolved. `id` is its key (the store's row key). */
export interface AddedItem {
  id: string
  key: string
  workspaceId: string | null
  projectId: string | null
  kind: AddedKind
  text: string
  /** What it is about: `<workspace>:<kind>:<id>` of a deliverable, message or meeting. */
  ref: string | null
  labels: string[]
  dueAt: number | null
  /** When it was added; adding the same key again is new activity. */
  at: number
  resolvedAt: number | null
}

export type NewInboxItem = Pick<AddedItem, 'key' | 'kind' | 'text'> & Partial<Pick<AddedItem, 'projectId' | 'workspaceId' | 'ref' | 'labels' | 'dueAt'>>

/** The user's action on an item, by its key (`id`, the store's row key). */
export interface InboxState {
  id: string
  key: string
  workspaceId: string | null
  /** Hidden until then (or until new activity). */
  snoozedUntil: number | null
  /** Hidden until the source has new activity. */
  untilActivity: boolean
  /** The item's activityAt when the user snoozed it or marked it done. */
  activityAt: number
  /** Hidden until the source has new activity. */
  doneAt: number | null
}

/** An item as windows get it: ids instead of the task and session. */
export interface InboxEntry {
  key: string
  kind: InboxKind | AddedKind
  text: string
  projectId: string | null
  workspaceId: string | null
  taskId: string | null
  sessionId: string | null
  approvalId?: string
  destination?: Destination
  ref?: string | null
  labels: string[]
  dueAt?: number | null
  activityAt: number
  /** Added with add(item), not derived. */
  added: boolean
}

/** Where the inbox keeps its rows; writes persist. */
export interface InboxStore {
  states(): InboxState[]
  putState(s: InboxState): void
  removeStates(keys: string[]): void
  added(): AddedItem[]
  putAdded(item: AddedItem): void
}

export interface InboxDeps {
  store: InboxStore
  /** Derived items of every project (core inbox()); the whole list, since states of keys missing from it are dropped. */
  derived(): InboxItem[]
  workspaceOf(projectId: string): string | null
  now?: () => number
}

export interface Inbox {
  /**
   * Derived and added items that wait on the user now, without the snoozed and done ones. Drops the state of an item
   * whose source cleared, so one that comes back later is new.
   */
  items(): InboxEntry[]
  /** Stores an item (the same key replaces it, as new activity); it shows until resolve(key) or Done. */
  add(item: NewInboxItem): void
  /** Its source cleared: an added item is resolved; the user's state of the key is dropped. */
  resolve(key: string): void
  /** Hides the item until `until` (ms) or new activity of its source, whichever comes first; 'activity': only the latter. */
  snooze(key: string, until: number | 'activity'): void
  /** Hides the item until its source has new activity. */
  done(key: string): void
}

/** Whether `state` hides an item whose source's activity is at `activityAt`. */
export function hidden(state: InboxState, activityAt: number, now: number): boolean {
  if (activityAt > state.activityAt) return false
  if (state.doneAt !== null || state.untilActivity) return true
  return state.snoozedUntil !== null && now < state.snoozedUntil
}

export function createInbox(deps: InboxDeps): Inbox {
  const now = deps.now ?? Date.now
  const { store } = deps

  const entry = (i: InboxItem): InboxEntry => ({
    key: i.key,
    kind: i.kind,
    text: i.text,
    projectId: i.projectId,
    // A topic without a project is in its own workspace.
    workspaceId: i.projectId ? deps.workspaceOf(i.projectId) : (i.session?.workspaceId ?? null),
    taskId: i.task?.id ?? null,
    sessionId: i.session?.id ?? null,
    ...(i.approvalId ? { approvalId: i.approvalId } : {}),
    ...(i.destination ? { destination: i.destination } : {}),
    labels: [],
    activityAt: i.activityAt,
    added: false,
  })
  const addedEntry = (a: AddedItem): InboxEntry => ({
    key: a.key,
    kind: a.kind,
    text: a.text,
    projectId: a.projectId,
    workspaceId: a.workspaceId,
    taskId: null,
    sessionId: null,
    ref: a.ref,
    labels: a.labels,
    dueAt: a.dueAt,
    activityAt: a.at,
    added: true,
  })

  /** Every item waiting, hidden ones included. */
  const all = (): InboxEntry[] => {
    const derived = deps.derived().map(entry)
    const keys = new Set(derived.map((e) => e.key))
    return [...derived, ...store.added().filter((a) => a.resolvedAt === null && !keys.has(a.key)).map(addedEntry)]
  }

  const find = (key: string): InboxEntry => {
    const e = all().find((x) => x.key === key)
    if (!e) throw new Error(`No inbox item ${key}`)
    return e
  }

  const setState = (e: InboxEntry, patch: Pick<InboxState, 'snoozedUntil' | 'untilActivity' | 'doneAt'>) =>
    store.putState({ id: e.key, key: e.key, workspaceId: e.workspaceId, activityAt: e.activityAt, ...patch })

  return {
    items() {
      const entries = all()
      const states = new Map(store.states().map((s) => [s.key, s]))
      const gone = [...states.keys()].filter((k) => !entries.some((e) => e.key === k))
      if (gone.length) store.removeStates(gone)
      const t = now()
      return entries.filter((e) => {
        const s = states.get(e.key)
        return !s || !hidden(s, e.activityAt, t)
      })
    },
    add(item) {
      if (!item.key.trim()) throw new Error('An inbox item needs a key')
      const workspaceId = item.workspaceId ?? (item.projectId ? deps.workspaceOf(item.projectId) : null)
      store.putAdded({
        id: item.key,
        key: item.key,
        workspaceId,
        projectId: item.projectId ?? null,
        kind: item.kind,
        text: item.text,
        ref: item.ref ?? null,
        labels: item.labels ?? [],
        dueAt: item.dueAt ?? null,
        at: now(),
        resolvedAt: null,
      })
    },
    resolve(key) {
      const added = store.added().find((a) => a.key === key)
      if (added && added.resolvedAt === null) store.putAdded({ ...added, resolvedAt: now() })
      if (store.states().some((s) => s.key === key)) store.removeStates([key])
    },
    snooze(key, until) {
      if (until !== 'activity' && !Number.isFinite(until)) throw new Error(`Snooze until what? ${until}`)
      setState(find(key), { snoozedUntil: until === 'activity' ? null : until, untilActivity: until === 'activity', doneAt: null })
    },
    done(key) {
      setState(find(key), { snoozedUntil: null, untilActivity: false, doneAt: now() })
    },
  }
}
