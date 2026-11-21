// Feeds the search index (unified-search-across-the-workspace.1): the store's topics, docs and decisions and the
// meetings, backfilled on start and kept in step with their changes. Services stay independent: this app-layer module
// reads each source and hands the search service its IndexDocs.
import type { AgentSession, Task } from '@mag/core'
import { rowsOfDecisions, rowsOfDoc, rowsOfMeeting, rowsOfSession, textHash } from './core/lib/search-rows/index.ts'
import type { Meetings } from './core/services/meetings/index.ts'
import type { IndexDoc, Search, Sensitivity } from './core/services/search/index.ts'
import type { Store } from './store.ts'

/** Sources of each feed, by the prefix of their names. */
export const STORE_SOURCES = ['session:', 'doc:', 'dec:']
export const MEETING_SOURCES = ['mtg:']
/** A change is indexed this long after it, with the ones that follow it. */
export const FEED_DELAY_MS = 1000

export type MeetingSource = Pick<Meetings, 'list' | 'read' | 'changedAt' | 'recordingId'>

export interface SearchFeed {
  /** Backfills both feeds: what changed since the index was built, what is gone dropped. */
  indexAll(): Promise<void>
  /** A feed's sources changed: it is brought in step after FEED_DELAY_MS. */
  onChanged(feed: 'store' | 'meetings'): void
  /** Brings a feed in step now; runs one at a time. */
  sync(feed: 'store' | 'meetings'): Promise<{ updated: number; removed: number; sources: number }>
}

/** A workspace named Personal holds the user's own life: its rows are left out of other scopes. */
export const isPersonal = (name: string) => name.trim().toLowerCase() === 'personal'

/** Label ids of each item: its own (not taken off) and its project's. */
function labelIndex(store: Store) {
  const own = new Map<string, string[]>()
  for (const r of store.data.itemLabels) if (!r.removed) own.set(r.itemRef, [...(own.get(r.itemRef) ?? []), r.labelId])
  return (ref: string, projectId: string | null | undefined) => [...new Set([...(projectId ? [projectId] : []), ...(own.get(ref) ?? [])])].sort()
}

/** The topic or work a session's labels come from: its root topic, or its work (a step's root work). */
function itemOf(s: AgentSession, sessions: Map<string, AgentSession>, tasks: Map<string, Task>): string {
  if (s.taskId) return `work:${tasks.get(s.taskId)?.parentId ?? s.taskId}`
  let root = s
  for (let up = s.parentId && sessions.get(s.parentId); up; up = up.parentId ? sessions.get(up.parentId) : undefined) root = up
  return `topic:${root.id}`
}

/** IndexDocs of the store: every session mag runs (not subagents), and each work's doc and decisions. */
export function storeDocs(store: Store, docHashes = new Map<string, { text: string; hash: string }>()): IndexDoc[] {
  const labelsOf = labelIndex(store)
  const personal = new Set(store.data.workspaces.filter((w) => isPersonal(w.name)).map((w) => w.id))
  const sensitivity = (ws: string): Sensitivity => (personal.has(ws) ? 'personal' : 'work')
  const sessions = new Map(store.data.sessions.map((s) => [s.id, s]))
  const tasks = new Map(store.data.tasks.map((t) => [t.id, t]))
  const projects = new Map(store.data.projects.map((p) => [p.id, p]))
  const hash = (id: string, text: string) => {
    const was = docHashes.get(id)
    if (was?.text === text) return was.hash
    const h = textHash(text)
    docHashes.set(id, { text, hash: h })
    return h
  }
  const docs: IndexDoc[] = []
  for (const s of store.data.sessions) {
    if (s.origin === 'subagent') continue
    const labels = labelsOf(itemOf(s, sessions, tasks), s.projectId)
    const { count, lastAt } = store.itemStats(s.id)
    const task = s.taskId ? tasks.get(s.taskId) : undefined
    const title = s.title?.trim() || (task ? `${task.key}: ${task.title}` : 'New topic')
    const ws = s.workspaceId
    docs.push({
      source: `session:${s.id}`,
      version: [count, lastAt, textHash(title), s.summaryAt ?? (s.summary ? 1 : 0), labels.join(','), sensitivity(ws)].join(':'),
      workspaceId: ws,
      labels,
      sensitivity: sensitivity(ws),
      rows: () => rowsOfSession(s, store.peekItems(s.id), title),
    })
  }
  for (const t of store.data.tasks) {
    const project = projects.get(t.projectId)
    if (t.parentId || !project) continue
    const doc = store.data.docs[t.id] ?? ''
    const labels = labelsOf(`work:${t.id}`, t.projectId)
    const ws = project.workspaceId
    const base = [hash(t.id, doc), textHash(`${t.key}\n${t.title}\n${t.description}`), labels.join(','), sensitivity(ws)].join(':')
    const common = { workspaceId: ws, labels, sensitivity: sensitivity(ws) }
    docs.push({ source: `doc:${t.id}`, version: base, ...common, rows: () => rowsOfDoc(t, doc) })
    docs.push({ source: `dec:${t.id}`, version: base, ...common, rows: () => rowsOfDecisions(t, doc) })
  }
  return docs
}

/** IndexDocs of the meetings, workspace-wide; the one being recorded waits for its end. */
export function meetingDocs(meetings: MeetingSource, store: Store): IndexDoc[] {
  const labelsOf = labelIndex(store)
  const recording = meetings.recordingId()
  return meetings.list().flatMap((m) => {
    if (m.id === recording) return []
    const labels = [...new Set((m.links ?? []).flatMap((l) => labelsOf(l.topicId ? `topic:${l.topicId}` : `work:${store.data.tasks.find((t) => t.projectId === l.projectId && t.key === l.workKey)?.id}`, l.projectId)))].sort()
    return [
      {
        source: `mtg:${m.id}`,
        version: `${meetings.changedAt(m.id)}:${labels.join(',')}`,
        workspaceId: '',
        labels,
        sensitivity: 'work' as const,
        rows: () => {
          const { meta, summary, transcript } = meetings.read(m.id)
          return rowsOfMeeting({ id: m.id, title: meta.title, startedAt: meta.startedAt, summary, transcript })
        },
      },
    ]
  })
}

export function createSearchFeed(deps: {
  search: Search
  store: Store
  /** Set once meetings are started. */
  meetings: () => MeetingSource | undefined
  log: (message: string, e?: unknown) => void
  delayMs?: number
}): SearchFeed {
  const docHashes = new Map<string, { text: string; hash: string }>()
  let queue: Promise<unknown> = Promise.resolve()
  const timers = new Map<string, NodeJS.Timeout>()

  const sync = (feed: 'store' | 'meetings') => {
    const run = queue.then(async () => {
      const meetings = deps.meetings()
      if (feed === 'meetings' && !meetings) return { updated: 0, removed: 0, sources: 0 }
      const docs = feed === 'store' ? storeDocs(deps.store, docHashes) : meetingDocs(meetings!, deps.store)
      const r = await deps.search.rebuild(docs, feed === 'store' ? STORE_SOURCES : MEETING_SOURCES)
      return { ...r, sources: docs.length }
    })
    queue = run.catch(() => {})
    return run
  }

  return {
    sync,
    async indexAll() {
      const t0 = Date.now()
      const counts: string[] = []
      for (const feed of ['store', 'meetings'] as const) {
        try {
          const r = await sync(feed)
          counts.push(`${feed}: ${r.sources} sources, ${r.updated} updated, ${r.removed} removed`)
        } catch (e) {
          deps.log(`indexing ${feed} failed`, e)
        }
      }
      deps.log(`search index: ${counts.join('; ')} in ${Date.now() - t0} ms`)
    },
    onChanged(feed) {
      if (timers.has(feed)) return
      timers.set(
        feed,
        setTimeout(() => {
          timers.delete(feed)
          sync(feed).catch((e) => deps.log(`indexing ${feed} failed`, e))
        }, deps.delayMs ?? FEED_DELAY_MS),
      )
    },
  }
}
