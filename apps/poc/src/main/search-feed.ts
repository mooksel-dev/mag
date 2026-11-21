// Feeds the search index (unified-search-across-the-workspace.1, .2): the store's topics, docs, decisions and persons,
// the meetings and the deliverables' versions, backfilled on start and kept in step with their changes. Services stay independent: this app-layer module
// reads each source and hands the search service its IndexDocs.
import type { AgentSession, Task } from '@mag/core'
import { rowsOfDecisions, rowsOfDeliverable, rowsOfDoc, rowsOfMeeting, rowsOfPerson, rowsOfSession, textHash } from './core/lib/search-rows/index.ts'
import { currentVersion, type Deliverables } from './core/services/deliverables/index.ts'
import type { Meeting as MeetingMeta, Meetings } from './core/services/meetings/index.ts'
import type { IndexDoc, Search, Sensitivity } from './core/services/search/index.ts'
import type { Store } from './store.ts'

/** Sources of each feed, by the prefix of their names. */
export const STORE_SOURCES = ['session:', 'doc:', 'dec:', 'person:']
export const MEETING_SOURCES = ['mtg:']
export const DELIVERABLE_SOURCES = ['dlv:']
export type Feed = 'store' | 'meetings' | 'deliverables'
const FEEDS: Feed[] = ['store', 'meetings', 'deliverables']
/** A change is indexed this long after it, with the ones that follow it. */
export const FEED_DELAY_MS = 1000

export type MeetingSource = Pick<Meetings, 'list' | 'read' | 'changedAt' | 'recordingId'>
export type DeliverableSource = Pick<Deliverables, 'list' | 'read' | 'refOf'>

export interface SearchFeed {
  /** Backfills every feed: what changed since the index was built, what is gone dropped. */
  indexAll(): Promise<void>
  /** A feed's sources changed: it is brought in step after FEED_DELAY_MS. */
  onChanged(feed: Feed): void
  /** Brings a feed in step now; runs one at a time. A feed whose source is not started yet does nothing. */
  sync(feed: Feed): Promise<{ updated: number; removed: number; sources: number }>
}

/** A workspace named Personal holds the user's own life: its rows are left out of other scopes. */
export const isPersonal = (name: string) => name.trim().toLowerCase() === 'personal'

/** Label ids of each item: its own (not taken off) and its project's. */
export function labelIndex(store: Pick<Store, 'data'>) {
  const own = new Map<string, string[]>()
  for (const r of store.data.itemLabels) if (!r.removed) own.set(r.itemRef, [...(own.get(r.itemRef) ?? []), r.labelId])
  return (ref: string, projectId: string | null | undefined) => [...new Set([...(projectId ? [projectId] : []), ...(own.get(ref) ?? [])])].sort()
}

/** The topic or work a session's labels come from: its root topic, or its work (a step's root work). */
export function itemOf(s: AgentSession, sessions: Map<string, AgentSession>, tasks: Map<string, Task>): string {
  if (s.taskId) return `work:${tasks.get(s.taskId)?.parentId ?? s.taskId}`
  let root = s
  for (let up = s.parentId && sessions.get(s.parentId); up; up = up.parentId ? sessions.get(up.parentId) : undefined) root = up
  return `topic:${root.id}`
}

/** IndexDocs of the store: every session mag runs (not subagents), each work's doc and decisions, every person (sensitivity people). */
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
  const handles = new Map<string, { system: string; handle: string; name?: string }[]>()
  for (const i of store.data.identities) if (i.personId) handles.set(i.personId, [...(handles.get(i.personId) ?? []), { system: i.system, handle: i.handle, ...(i.name && { name: i.name }) }])
  for (const p of store.data.persons) {
    const person = { ...p, handles: (handles.get(p.id) ?? []).sort((a, b) => `${a.system}:${a.handle}`.localeCompare(`${b.system}:${b.handle}`)) }
    const text = JSON.stringify([person.name, person.email, person.title, person.handles])
    docs.push({ source: `person:${p.id}`, version: textHash(text), workspaceId: p.workspaceId, labels: [], sensitivity: 'people', rows: () => rowsOfPerson(person) })
  }
  return docs
}

/** A meeting's label ids: those of the topics and works it is linked to, their projects included. */
export function meetingLabels(m: Pick<MeetingMeta, 'links'>, labelsOf: ReturnType<typeof labelIndex>, tasks: Task[]): string[] {
  return [...new Set((m.links ?? []).flatMap((l) => labelsOf(l.topicId ? `topic:${l.topicId}` : `work:${tasks.find((t) => t.projectId === l.projectId && t.key === l.workKey)?.id}`, l.projectId)))].sort()
}

/**
 * IndexDocs of the deliverables at their current version (the final one, else the latest: what read shows), so a hit
 * never opens an older text than the one in use; labeled with their project and topic's labels and the workspace labels
 * their own names match. People-sensitive ones (assessments) stay out unless asked, as Personal ones do.
 */
export function deliverableDocs(dlv: DeliverableSource, store: Store): IndexDoc[] {
  const labelsOf = labelIndex(store)
  const personal = new Set(store.data.workspaces.filter((w) => isPersonal(w.name)).map((w) => w.id))
  const groupWs = new Map(store.data.labelGroups.map((g) => [g.id, g.workspaceId]))
  const readOr = (id: string, n: number) => {
    try {
      return dlv.read(id, n)
    } catch {
      return ''
    }
  }
  return dlv.list().map((d) => {
    const named = new Set(d.labels.map((l) => l.toLowerCase()))
    const matched = store.data.labels.filter((l) => groupWs.get(l.groupId) === d.workspaceId && named.has(l.name.toLowerCase())).map((l) => l.id)
    const labels = [...new Set([...(d.topicId ? labelsOf(`topic:${d.topicId}`, d.projectId) : d.projectId ? [d.projectId] : []), ...matched])].sort()
    const sensitivity: Sensitivity = d.sensitivity === 'people' ? 'people' : personal.has(d.workspaceId) ? 'personal' : 'work'
    const ref = dlv.refOf(d)
    const n = currentVersion(d)
    const current = d.versions.find((v) => v.n === n)
    return {
      source: `dlv:${d.id}`,
      version: [current ? `${current.n}@${current.at}` : '', textHash(`${ref}\n${d.title}\n${d.kind}\n${d.labels.join(',')}`), labels.join(','), sensitivity].join(':'),
      workspaceId: d.workspaceId,
      labels,
      sensitivity,
      rows: () =>
        rowsOfDeliverable({
          ref,
          title: d.title,
          kind: d.kind,
          labels: d.labels,
          // A version file deleted by hand leaves only the title row.
          versions: current ? [{ n: current.n, at: current.at, text: readOr(d.id, current.n) }] : [],
        }),
    }
  })
}

/** IndexDocs of the meetings, workspace-wide; the one being recorded waits for its end. */
export function meetingDocs(meetings: MeetingSource, store: Store): IndexDoc[] {
  const labelsOf = labelIndex(store)
  const recording = meetings.recordingId()
  return meetings.list().flatMap((m) => {
    if (m.id === recording) return []
    const labels = meetingLabels(m, labelsOf, store.data.tasks)
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
  /** Set once deliverables are started. */
  deliverables?: () => DeliverableSource | undefined
  log: (message: string, e?: unknown) => void
  delayMs?: number
}): SearchFeed {
  const docHashes = new Map<string, { text: string; hash: string }>()
  let queue: Promise<unknown> = Promise.resolve()
  const timers = new Map<string, NodeJS.Timeout>()

  const sourcesOf = (feed: Feed): { docs: IndexDoc[]; prefixes: string[] } | null => {
    if (feed === 'store') return { docs: storeDocs(deps.store, docHashes), prefixes: STORE_SOURCES }
    if (feed === 'meetings') {
      const meetings = deps.meetings()
      return meetings ? { docs: meetingDocs(meetings, deps.store), prefixes: MEETING_SOURCES } : null
    }
    const dlv = deps.deliverables?.()
    return dlv ? { docs: deliverableDocs(dlv, deps.store), prefixes: DELIVERABLE_SOURCES } : null
  }
  const sync = (feed: Feed) => {
    const run = queue.then(async () => {
      const got = sourcesOf(feed)
      if (!got) return { updated: 0, removed: 0, sources: 0 }
      const r = await deps.search.rebuild(got.docs, got.prefixes)
      return { ...r, sources: got.docs.length }
    })
    queue = run.catch(() => {})
    return run
  }

  return {
    sync,
    async indexAll() {
      const t0 = Date.now()
      const counts: string[] = []
      for (const feed of FEEDS) {
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
