// Deliverables (deliverables-library-claims-review-and.1): non-code results with versions and one final version. A
// version's text is a markdown file in the workspace's folder (workspace-files); the rest is a record the app persists
// (DeliverableRecords, in workspace-db). A deliverable whose folder is gone is gone.
import { randomUUID } from 'node:crypto'
import type { Destination } from '@mag/core'
import type { WorkspaceFiles } from '../../clients/workspace-files/index.ts'
import { DELIVERABLE_KINDS, type Deliverable, type DeliverableKind, type DeliverableRecords, type DeliverableState, type Sensitivity } from './types.ts'

export type * from './types.ts'
export { DELIVERABLE_KINDS } from './types.ts'

/** Where a deliverable is made: its workspace (with its folder name), project, topic and work. */
export interface Origin {
  workspaceId: string
  folder: string
  projectId: string | null
  topicId: string | null
  taskId: string | null
}

/** A new deliverable (no ref) or a new version of `ref`'s; title, labels and destination given replace the old. */
export interface SaveInput {
  ref?: string
  kind?: string
  title?: string
  md: string
  labels?: string[]
  destination?: Destination | null
  sensitivity?: Sensitivity
  by?: 'agent' | 'user'
}

export interface Saved {
  deliverable: Deliverable
  n: number
  ref: string
  path: string
}

/** Deliverables of a workspace, project or topics; `labels`: has every one of them. */
export interface ListFilter {
  workspaceId?: string
  projectId?: string
  topicIds?: string[]
  kind?: DeliverableKind
  state?: DeliverableState[]
  labels?: string[]
}

export interface Deliverables {
  /** Creates a deliverable with v1, or adds the next version to `input.ref`'s; a new version sets it back to draft. */
  save(input: SaveInput, origin: Origin): Saved
  /** A new draft for a routine or a topic: v1 holds the brief and the refs to work from. */
  draft(kind: DeliverableKind, brief: string, refs: string[], origin: Origin): Deliverable
  /** The latest final or published deliverable of `kind` with every one of `labels`: the previous issue. */
  lastFinal(kind: DeliverableKind, labels: string[], workspaceId?: string): Deliverable | null
  /** The user's Mark final of version `n`. */
  markFinal(id: string, n: number): Deliverable
  /** A final deliverable posted to `destination`. */
  markPublished(id: string, destination: Destination): Deliverable
  /** Newest first; deliverables whose folder is gone are dropped (and forgotten). */
  list(filter?: ListFilter): Deliverable[]
  /** Version `n`'s text; without `n`, the final version of a final or published one, else the latest. */
  read(id: string, n?: number): string
  get(id: string): Deliverable
  /** A ref `<folder>:dlv:<slug>`, or `dlv:<slug>` in workspace `workspaceId` (whatever its folder is named now). */
  resolve(ref: string, workspaceId?: string): Deliverable
  refOf(d: Deliverable): string
  /** The file of version `n` (default as read's), else the folder. */
  pathOf(id: string, n?: number): string
  reveal(id: string): void
  /** The user's Publish, sent to the session that will post it; the deliverable must be final. */
  requestPublish(id: string, sessionId: string): Deliverable
  /** A write to `destination` allowed in `sessionId`: the deliverables it was asked to publish are published. */
  writeAllowed(sessionId: string, destination: Destination): Deliverable[]
  /** Forgets deliverables whose folder is gone; returns how many. */
  prune(): number
}

const REF = /^(?:([\p{L}\p{N}][\p{L}\p{N}-]*):)?dlv:([\p{L}\p{N}][\p{L}\p{N}-]*)$/u

/** A folder name from a title: lowercase letters, digits and dashes, ≤ 40 characters. */
export const slugOf = (title: string, fallback = 'deliverable') =>
  title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || fallback

/** A workspace's folder under ~/Documents/mag, from its name. */
export const workspaceFolder = (name: string) => slugOf(name, 'workspace')

export const isKind = (k: unknown): k is DeliverableKind => typeof k === 'string' && (DELIVERABLE_KINDS as readonly string[]).includes(k)

const latest = (d: Deliverable) => d.versions.at(-1)?.n ?? 0

/** The version read and Publish mean: the final one of a final or published deliverable, else the latest. */
export const currentVersion = (d: Deliverable) => ((d.state === 'final' || d.state === 'published') && d.finalVersion ? d.finalVersion : latest(d))

const hasLabels = (d: Deliverable, labels: string[]) => labels.every((l) => d.labels.some((x) => x.toLowerCase() === l.toLowerCase()))

const cleanLabels = (labels: string[] | undefined) => [...new Set((labels ?? []).map((l) => l.trim()).filter(Boolean))]

export function createDeliverables(deps: { files: WorkspaceFiles; records: DeliverableRecords; now?: () => number }): Deliverables {
  const { files, records } = deps
  const now = deps.now ?? Date.now
  const alive = (d: Deliverable) => files.exists(d.folder, d.slug)
  const get = (id: string) => {
    const d = records.all().find((x) => x.id === id)
    if (!d) throw new Error(`No deliverable ${id}`)
    if (!alive(d)) {
      records.remove(d.id)
      throw new Error(`Deliverable ${d.title} is gone: its folder ${files.dirOf(d.folder, d.slug)} was deleted`)
    }
    return d
  }
  const put = (d: Deliverable) => {
    d.updatedAt = now()
    records.put(d)
    return d
  }
  const refOf = (d: Deliverable) => `${d.folder}:dlv:${d.slug}`
  const hasVersion = (d: Deliverable, n: number) => d.versions.some((v) => v.n === n)

  const self: Deliverables = {
    get,
    refOf,
    save(input, origin) {
      const md = input.md ?? ''
      if (!md.trim()) throw new Error('A version needs its text: md')
      const title = input.title?.replace(/\s+/g, ' ').trim()
      let d: Deliverable
      if (input.ref) {
        // A copy: a write that fails changes nothing.
        d = structuredClone(self.resolve(input.ref, origin.workspaceId))
        if (input.kind !== undefined && input.kind !== d.kind) throw new Error(`${refOf(d)} is a ${d.kind}; its kind stays`)
        if (title) d.title = title
      } else {
        if (!isKind(input.kind)) throw new Error(`kind must be one of ${DELIVERABLE_KINDS.join(', ')}`)
        if (!title) throw new Error('A new deliverable needs a title')
        const t = now()
        d = {
          id: randomUUID().slice(0, 8),
          slug: files.createDeliverable(origin.folder, slugOf(title)),
          workspaceId: origin.workspaceId,
          folder: origin.folder,
          projectId: origin.projectId,
          topicId: origin.topicId,
          taskId: origin.taskId,
          kind: input.kind,
          title,
          labels: [],
          sensitivity: input.sensitivity ?? (input.kind === 'assessment' ? 'people' : 'work'),
          state: 'draft',
          finalVersion: null,
          destination: null,
          publishedAt: null,
          versions: [],
          publishing: null,
          createdAt: t,
          updatedAt: t,
        }
      }
      if (input.labels) d.labels = cleanLabels(input.labels)
      if (input.destination !== undefined) d.destination = input.destination
      if (input.sensitivity) d.sensitivity = input.sensitivity
      // A file put there by hand counts: the next number is past both.
      const n = Math.max(latest(d), ...files.versions(d.folder, d.slug), 0) + 1
      const path = files.writeVersion(d.folder, d.slug, n, md)
      d.versions.push({ n, at: now(), by: input.by ?? 'agent' })
      d.state = 'draft'
      d.publishing = null
      put(d)
      return { deliverable: d, n, ref: refOf(d), path }
    },
    draft(kind, brief, refs, origin) {
      const text = brief.trim()
      if (!text) throw new Error('A draft needs a brief')
      const title = text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80).trim() || kind
      const sources = refs.map((r) => r.trim()).filter(Boolean)
      const md = `# ${title}\n\n> Draft. Brief: ${text.replace(/\n+/g, ' ')}\n${sources.length ? `\n## Sources\n${sources.map((r) => `- ${r}`).join('\n')}\n` : ''}`
      return self.save({ kind, title, md }, origin).deliverable
    },
    lastFinal(kind, labels, workspaceId) {
      const done = self.list({ kind, workspaceId, state: ['final', 'published'], labels })
      return done.sort((a, b) => (b.publishedAt ?? b.updatedAt) - (a.publishedAt ?? a.updatedAt))[0] ?? null
    },
    markFinal(id, n) {
      const d = get(id)
      if (!hasVersion(d, n)) throw new Error(`${refOf(d)} has no version ${n}`)
      if (!files.versions(d.folder, d.slug).includes(n)) throw new Error(`Version ${n} of ${refOf(d)} was deleted from its folder`)
      d.finalVersion = n
      d.state = 'final'
      return put(d)
    },
    markPublished(id, destination) {
      const d = get(id)
      if (d.state !== 'final') throw new Error(`${refOf(d)} is ${d.state}: only a final deliverable is published`)
      d.state = 'published'
      d.destination = destination
      d.publishedAt = now()
      d.publishing = null
      return put(d)
    },
    list(filter = {}) {
      self.prune()
      const labels = filter.labels ?? []
      return records
        .all()
        .filter(
          (d) =>
            (!filter.workspaceId || d.workspaceId === filter.workspaceId) &&
            (!filter.projectId || d.projectId === filter.projectId) &&
            (!filter.topicIds || (!!d.topicId && filter.topicIds.includes(d.topicId))) &&
            (!filter.kind || d.kind === filter.kind) &&
            (!filter.state || filter.state.includes(d.state)) &&
            hasLabels(d, labels),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    read(id, n) {
      const d = get(id)
      const v = n ?? currentVersion(d)
      if (!hasVersion(d, v)) throw new Error(`${refOf(d)} has no version ${v}; it has ${d.versions.map((x) => x.n).join(', ')}`)
      return files.readVersion(d.folder, d.slug, v)
    },
    resolve(ref, workspaceId) {
      const m = REF.exec(ref.trim())
      if (!m) throw new Error(`Not a deliverable ref: ${ref} (want <workspace>:dlv:<slug> or dlv:<slug>)`)
      if (!m[1] && !workspaceId) throw new Error(`${ref}: name its workspace, <workspace>:dlv:<slug>`)
      const found = records.all().find((d) => d.slug === m[2] && (m[1] ? d.folder === m[1] : d.workspaceId === workspaceId))
      if (!found) throw new Error(`No deliverable ${ref.trim()}`)
      return get(found.id)
    },
    pathOf(id, n) {
      const d = get(id)
      const v = n ?? currentVersion(d)
      return v && files.versions(d.folder, d.slug).includes(v) ? files.versionPath(d.folder, d.slug, v) : files.dirOf(d.folder, d.slug)
    },
    reveal(id) {
      files.reveal(self.pathOf(id))
    },
    requestPublish(id, sessionId) {
      const d = get(id)
      if (d.state !== 'final') throw new Error(`${refOf(d)} is ${d.state}: mark a version final first`)
      d.publishing = { sessionId, at: now() }
      return put(d)
    },
    writeAllowed(sessionId, destination) {
      return records
        .all()
        .filter((d) => d.publishing?.sessionId === sessionId && d.state === 'final' && alive(d))
        .map((d) => self.markPublished(d.id, destination))
    },
    prune() {
      const gone = records.all().filter((d) => !alive(d))
      for (const d of gone) records.remove(d.id)
      return gone.length
    },
  }
  return self
}
