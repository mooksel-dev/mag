// The Library (deliverables-library-claims-review-and.4): a view over what is final in a workspace, never a store. Final
// and published deliverables, decisions (works' §Decisions, meeting summaries' ## Decisions) and merged works.
import type { Task } from '@mag/core'
import type { LibraryFilter, LibraryList, LibraryRow } from '../preload/api'
import { decisionLines } from './core/lib/search-rows/index.ts'
import type { Deliverable, Deliverables } from './core/services/deliverables/index.ts'
import { itemOf, labelIndex, meetingLabels, type MeetingSource } from './search-feed.ts'
import type { Store } from './store.ts'

export interface Library {
  list(workspaceId: string, filter?: LibraryFilter): LibraryList
}

/** Rows the filter keeps, newest first; people-sensitive ones only when it asks for them. */
export function filterLibrary(rows: LibraryRow[], filter: LibraryFilter = {}): LibraryList {
  const matches = rows.filter(
    (r) =>
      (!filter.kind || r.kind === filter.kind) &&
      (filter.projectId === undefined || (filter.projectId === null ? !r.projectIds.length : r.projectIds.includes(filter.projectId))) &&
      (!filter.labelId || r.labelIds.includes(filter.labelId)),
  )
  const kept = filter.people ? matches : matches.filter((r) => !r.people)
  return { rows: kept.sort((a, b) => b.at - a.at), hiddenPeople: matches.length - kept.length }
}

export function createLibrary(deps: {
  store: Pick<Store, 'data'>
  deliverables: Pick<Deliverables, 'list'>
  meetings: () => MeetingSource | undefined
}): Library {
  // Summaries are read from disk once per change of their meeting.
  const summaries = new Map<string, { version: number; decisions: string[] }>()
  const decisionsOf = (m: MeetingSource, id: string) => {
    const version = m.changedAt(id)
    const was = summaries.get(id)
    if (was?.version === version) return was.decisions
    let decisions: string[]
    try {
      decisions = decisionLines(m.read(id).summary)
    } catch {
      // Deleted since it was listed.
      return []
    }
    summaries.set(id, { version, decisions })
    return decisions
  }

  const rows = (workspaceId: string): LibraryRow[] => {
    const { data } = deps.store
    const labelsOf = labelIndex(deps.store)
    const sessions = new Map(data.sessions.map((s) => [s.id, s]))
    const tasks = new Map(data.tasks.map((t) => [t.id, t]))
    const projects = new Set(data.projects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id))
    const groups = new Set(data.labelGroups.filter((g) => g.workspaceId === workspaceId).map((g) => g.id))
    const byName = new Map(data.labels.filter((l) => groups.has(l.groupId)).map((l) => [l.name.trim().toLowerCase(), l.id]))
    const works = data.tasks.filter((t) => !t.parentId && projects.has(t.projectId))
    const out: LibraryRow[] = []

    const rootWork = (taskId: string | null) => {
      const t = taskId ? tasks.get(taskId) : undefined
      return t?.parentId ? tasks.get(t.parentId) : t
    }
    const deliverableRow = (d: Deliverable): LibraryRow => {
      const topic = d.topicId ? sessions.get(d.topicId) : undefined
      const work = rootWork(d.taskId)
      const item = topic ? itemOf(topic, sessions, tasks) : work ? `work:${work.id}` : null
      const own = d.labels.map((name) => ({ name, id: byName.get(name.trim().toLowerCase()) }))
      return {
        key: `dlv:${d.id}`,
        kind: d.kind,
        source: 'deliverable',
        title: d.title,
        text: `v${d.finalVersion ?? d.versions.at(-1)?.n ?? 0} · ${d.state}`,
        at: d.publishedAt ?? d.updatedAt,
        projectIds: d.projectId ? [d.projectId] : [],
        labelIds: [...new Set([...(item ? labelsOf(item, d.projectId) : d.projectId ? [d.projectId] : []), ...own.flatMap((l) => (l.id ? [l.id] : []))])].sort(),
        tags: own.filter((l) => !l.id).map((l) => l.name),
        people: d.sensitivity === 'people',
        open: topic ? { kind: 'topic', id: topic.id, deliverableId: d.id } : work ? { kind: 'work', id: work.id } : { kind: 'reveal', deliverableId: d.id },
      }
    }
    for (const d of deps.deliverables.list({ workspaceId, state: ['final', 'published'] })) out.push(deliverableRow(d))

    const workRow = (t: Task) => ({ title: `${t.key}: ${t.title}`, at: t.updatedAt, projectIds: [t.projectId], labelIds: labelsOf(`work:${t.id}`, t.projectId), tags: [], people: false, open: { kind: 'work' as const, id: t.id } })
    for (const t of works) {
      if (t.status === 'canceled') continue
      decisionLines(data.docs[t.id] ?? '').forEach((text, n) => out.push({ ...workRow(t), key: `dec:${t.id}#${n}`, kind: 'decision', source: 'doc', text }))
      if (t.status !== 'done' || t.type === 'review') continue
      const merged = data.tasks.filter((s) => s.parentId === t.id).flatMap((s) => s.work?.repos ?? []).filter((r) => r.prState === 'merged').length
      out.push({ ...workRow(t), key: `work:${t.id}`, kind: 'change', source: 'work', text: merged ? `${merged} PR${merged > 1 ? 's' : ''} merged` : 'done' })
    }

    const meetings = deps.meetings()
    const recording = meetings?.recordingId()
    for (const m of meetings?.list() ?? []) {
      if (m.id === recording) continue
      const linked = (m.links ?? []).map((l) => l.projectId)
      const here = [...new Set(linked.filter((p) => projects.has(p)))]
      // Meetings are workspace-wide; one linked only to other workspaces' projects is theirs.
      if (linked.length && !here.length) continue
      const at = Date.parse(m.startedAt) || 0
      const labelIds = meetingLabels(m, labelsOf, data.tasks)
      decisionsOf(meetings!, m.id).forEach((text, n) =>
        out.push({ key: `mtg:${m.id}#${n}`, kind: 'decision', source: 'meeting', title: m.title, text, at, projectIds: here, labelIds, tags: [], people: false, open: { kind: 'meeting', id: m.id } }),
      )
    }
    return out
  }

  return { list: (workspaceId, filter) => filterLibrary(rows(workspaceId), filter) }
}
