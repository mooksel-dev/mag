import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { workspaceAsProject, projectGroupId, digestOf, type SessionDigest, ideaText, ideaTitle, isLegacy, resolveChoice, sessionTree, migratePrReview, type LegacyPrReview, setOf, rewriteKeys, subtaskKey, subtasksOf, taskChangeEvents, workKey, type AgentSession, type ArchDiagram, type ArchNode, type Canvas, type CanvasPlacement, type ChangeInventory, type ChatItem, type ChatSummary, type Diagram, type Integration, type SessionHeader, type SessionItemEvent, sessionHeader, type NewEvent, type Project, type ProjectEvent, type Task, type Workspace, type ItemRef, type ItemLabel, type Label, type LabelGroup } from '@mag/core'
import type { NewTask, WindowKind } from '../preload/api'
import type { Bounds } from './bounds'
import { log } from './log.ts'
import { createLabels, type Labels } from './core/services/labels/index.ts'
import { fromProjectWindows, type LegacyProjectWindow, type WorkspaceWindow } from './windowViews.ts'
import { openWorkspaceDb, removeDb, type Counts, type EntityRow, type ImportData, type WorkspaceDb } from './core/clients/workspace-db/index.ts'
import type { AddedItem, InboxState } from './core/services/inbox/index.ts'
import type { Deliverable, DeliverableRecords } from './core/services/deliverables/types.ts'
import type { Identity, IdentityOverride, Person } from './core/services/people/types.ts'
import type { Routine, RoutineRecords, RoutineRun } from './core/services/routines/index.ts'

interface Data {
  workspaces: Workspace[]
  projects: Project[]
  tasks: Task[]
  sessions: AgentSession[]
  docs: Record<string, string>
  /** Agent-drawn HTML pages and diagrams; the HTML is not sent to the renderer with the state (see canvasList). */
  canvases: Record<string, Canvas>
  /** Project activity log, oldest first; kept after its task is deleted. */
  events: ProjectEvent[]
  /** MCP servers agents reported on start; global, since connectors belong to the account. */
  integrations: Integration[]
  /** The user's snooze and done of inbox items, by item key; not sent to the renderer (it gets the inbox). */
  inboxStates: InboxState[]
  /** Inbox items added by sources without state of their own (see services/inbox); not sent to the renderer. */
  inboxItems: AddedItem[]
  /** Label groups, labels and the labels of items (workspaces-and-labels-project-as.2); kept by `Store.labels`. */
  labelGroups: LabelGroup[]
  labels: Label[]
  itemLabels: ItemLabel[]
  /** Non-code results; their versions' text is in the workspace folder (deliverables-library-claims-review-and.1). */
  deliverables: Deliverable[]
  /** People of each workspace (who-is-who-people-from.1); kept by services/people, not sent to the renderer. */
  persons: Person[]
  identities: Identity[]
  identityOverrides: IdentityOverride[]
  /** Scheduled drafts and their runs (routines-scheduled-drafts-and-a.1); kept by services/routines. */
  routines: Routine[]
  routineRuns: RoutineRun[]
  /** Window layout; not app state, so not sent to the renderer. */
  ui: UiState
  /** How many of the store's migrations (see Store.migrations) have run; each runs once. */
  schemaVersion?: number
  /** Before schemaVersion: migrateToSteps has run (T-28). */
  stepsMigrated?: boolean
}

/** An idea as stored before ideas-are-parked-topics.1 (T-55.6), until migrateToParkedTopics turns it into a topic. */
interface LegacyIdea {
  id: string
  projectId: string
  text: string
  createdAt: number
  source?: string | null
  /** The topic that discussed it. */
  topicId?: string | null
}

type LegacyData = Data & { ideas?: LegacyIdea[] }

interface UiState {
  /** Last bounds per pop-out kind. */
  windows: Partial<Record<WindowKind, Bounds>>
  /** Workspace windows open on quit (or now), in opening order; missing until the first save since project windows. */
  workspaceWindows?: WorkspaceWindow[]
  /** Project windows saved before workspace windows; read once into `workspaceWindows`. */
  projectWindows?: LegacyProjectWindow[]
  /** Project ids, most recently opened first. */
  recent: string[]
}

/** Recent projects kept. */
const RECENT_MAX = 10

/** Task work before T-22: one worktree per task. */
interface LegacyWork {
  repo: string
  branch: string
  worktree: string
  prUrl: string | null
  feedbackSeenAt: number
  checkError?: string | null
}

/** A review as a file may hold it: of today, or from before one result per format. */
type PrReviewOnDisk = NonNullable<Task['prReview']> | LegacyPrReview

/** Events kept per project. */
const EVENTS_PER_PROJECT = 300

const id = () => randomUUID().slice(0, 8)

/** Replaces the element of `list` with `x`'s id, or appends `x`. */
function upsert<T extends { id: string }>(list: T[], x: T) {
  const i = list.findIndex((y) => y.id === x.id)
  if (i >= 0) list[i] = x
  else list.push(x)
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app'

type LegacyArch = { summary: string; apps: { name: string; path?: string; kind?: string; nodes: (Omit<ArchNode, 'uses'> & { uses: string[] })[] }[]; updatedAt: number }

/**
 * Apps of an architecture before T-27 become top-level modules with their nodes as children; `uses: string[]` become
 * `{ to, calls: [] }`. Node ids were unique per app only, so a repeated id gets its app's id as a prefix.
 */
export function migrateArch(a: ArchDiagram | LegacyArch | null | undefined): ArchDiagram | null {
  if (!a) return null
  if (!('apps' in a)) return a
  const taken = new Set<string>()
  const unique = (want: string) => {
    let s = want
    for (let i = 2; taken.has(s); i++) s = `${want}-${i}`
    taken.add(s)
    return s
  }
  const modules = a.apps.map((app): ArchNode => {
    const appId = unique(slug(app.name))
    const ids = new Map(app.nodes.map((n) => [n.id, taken.has(n.id) ? unique(`${appId}-${n.id}`) : unique(n.id)]))
    return {
      id: appId,
      name: app.name,
      ...(app.kind ? { kind: app.kind } : {}),
      ...(app.path ? { path: app.path } : {}),
      description: '',
      uses: [],
      children: app.nodes.map((n) => ({ ...n, id: ids.get(n.id)!, uses: n.uses.filter((u) => ids.has(u)).map((u) => ({ to: ids.get(u)!, calls: [] })) })),
    }
  })
  return { summary: a.summary, modules, updatedAt: a.updatedAt }
}

/** Where migrateToWorkspaces puts projects: workspace names with their projects' names, and the workspace for the rest. */
export interface WorkspaceMap {
  workspaces: Record<string, string[]>
  fallback: string
}

/** The user's workspaces (mag-as-the-user-s). */
export const WORKSPACE_MAP: WorkspaceMap = { workspaces: { Aura: ['Aura Data Removal', 'Money Problems'], Personal: ['mag', 'synapse'] }, fallback: 'Personal' }

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Daily backups of db.json kept. */
export const BACKUPS_KEPT = 7

/**
 * Writes `text` to `file` through `file.tmp`, synced, then renamed over it: a crash or a failed write leaves the old file
 * whole. A failed write removes the temp file and throws. `write` is for tests.
 */
export function writeAtomic(file: string, text: string, write: (fd: number, text: string) => void = (fd, t) => writeFileSync(fd, t)) {
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    try {
      write(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** `db-YYYY-MM-DD.json`, by local day. */
export function backupName(at: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `db-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`
}

/**
 * The day's first write copies the file as it was to `backups/db-YYYY-MM-DD.json` next to it, keeping the newest
 * BACKUPS_KEPT. Returns the backup's path, or null when today's exists or there is no file yet.
 */
export function backupDaily(file: string, now = new Date()): string | null {
  if (!existsSync(file)) return null
  const dir = join(dirname(file), 'backups')
  const dest = join(dir, backupName(now))
  if (existsSync(dest)) return null
  mkdirSync(dir, { recursive: true })
  copyFileSync(file, dest)
  const all = readdirSync(dir).filter((f) => /^db-\d{4}-\d\d-\d\d\.json$/.test(f)).sort()
  for (const f of all.slice(0, -BACKUPS_KEPT)) rmSync(join(dir, f), { force: true })
  return dest
}

/** Data's lists and maps stored one row per element, by entity kind; `ui` is one row, any other field a `meta` row. */
const LIST_KINDS = { workspaces: 'workspace', projects: 'project', tasks: 'task', sessions: 'session', events: 'event', integrations: 'integration', inboxStates: 'inbox_state', inboxItems: 'inbox_item', labelGroups: 'label_group', labels: 'label', itemLabels: 'item_label', deliverables: 'deliverable', persons: 'person', identities: 'identity', identityOverrides: 'identity_override', routines: 'routine', routineRuns: 'routine_run' } as const
const MAP_KINDS = { docs: 'doc', canvases: 'canvas' } as const
type ListKey = keyof typeof LIST_KINDS
type MapKey = keyof typeof MAP_KINDS
const isListKey = (k: string): k is ListKey => k in LIST_KINDS
const isMapKey = (k: string): k is MapKey => k in MAP_KINDS

/** Fields of `data` stored as `meta` rows: the ones that are neither lists, maps nor ui. */
const metaKeys = (data: object) => Object.entries(data).filter(([k, v]) => v !== undefined && !isListKey(k) && !isMapKey(k) && k !== 'ui').map(([k]) => k)

/** A session's fields without its items; reads no items. */
function sessionFields(s: AgentSession): Omit<AgentSession, 'items'> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(s)) if (k !== 'items') out[k] = (s as unknown as Record<string, unknown>)[k]
  return out as Omit<AgentSession, 'items'>
}

/** `data` as entity rows; a session without its items, with `digest` of them as `itemsDigest`. */
function entityRows(data: Partial<LegacyData>, digest: (s: AgentSession) => SessionDigest): EntityRow[] {
  const rows: EntityRow[] = []
  const projectOfTask = new Map((data.tasks ?? []).map((t) => [t.id, t.projectId]))
  for (const key of Object.keys(LIST_KINDS) as ListKey[]) {
    const kind = LIST_KINDS[key]
    for (const x of (data[key] ?? []) as { id: string; projectId?: string }[]) {
      const json = kind === 'session' ? JSON.stringify({ ...sessionFields(x as AgentSession), itemsDigest: digest(x as AgentSession) }) : JSON.stringify(x)
      rows.push({ kind, id: x.id, projectId: kind === 'project' ? x.id : (x.projectId ?? null), json })
    }
  }
  for (const [id, text] of Object.entries(data.docs ?? {})) rows.push({ kind: 'doc', id, projectId: projectOfTask.get(id) ?? null, json: JSON.stringify(text) })
  for (const [id, c] of Object.entries(data.canvases ?? {})) rows.push({ kind: 'canvas', id, projectId: c.projectId ?? null, json: JSON.stringify(c) })
  if (data.ui) rows.push({ kind: 'ui', id: 'ui', projectId: null, json: JSON.stringify(data.ui) })
  for (const k of metaKeys(data)) rows.push({ kind: 'meta', id: k, projectId: null, json: JSON.stringify((data as Record<string, unknown>)[k]) })
  return rows
}

/** What a db.json holds, counted from the file's data: elements per entity kind and items per session. */
function fileCounts(data: Partial<LegacyData>): Counts {
  const entities: Record<string, number> = {}
  for (const key of Object.keys(LIST_KINDS) as ListKey[]) entities[LIST_KINDS[key]] = data[key]?.length ?? 0
  for (const key of Object.keys(MAP_KINDS) as MapKey[]) entities[MAP_KINDS[key]] = Object.keys(data[key] ?? {}).length
  entities.ui = data.ui ? 1 : 0
  entities.meta = metaKeys(data).length
  const items: Record<string, number> = {}
  for (const s of data.sessions ?? []) items[s.id] = (items[s.id] ?? 0) + (s.items?.length ?? 0)
  return { entities, items }
}

function importData(data: Partial<LegacyData>): ImportData {
  const items: Record<string, string[]> = {}
  for (const s of data.sessions ?? []) items[s.id] = [...(items[s.id] ?? []), ...(s.items ?? []).map((i) => JSON.stringify(i))]
  return { entities: entityRows(data, (s) => digestOf(s.items ?? [])), items }
}

const rowKey = (kind: string, id: string) => `${kind}\u0000${id}`

/** A loaded session's item rows: `stored` rows in the db, the first `clean` of them as in memory except `dirty` ones. */
interface ItemRows {
  stored: number
  clean: number
  dirty: Set<number>
}

/**
 * Persistence: SQLite in mag.sqlite next to `file` (db.json), imported from it on the first start; on JSON in `file`
 * when that import fails, or with backend 'json'.
 */
export class Store {
  data: Data = { workspaces: [], projects: [], tasks: [], sessions: [], docs: {}, canvases: {}, events: [], integrations: [], inboxStates: [], inboxItems: [], labelGroups: [], labels: [], itemLabels: [], deliverables: [], persons: [], identities: [], identityOverrides: [], routines: [], routineRuns: [], ui: { windows: {}, workspaceWindows: [], recent: [] } }
  private listeners: (() => void)[] = []
  private itemListeners: ((e: SessionItemEvent) => void)[] = []
  private saveTimer: NodeJS.Timeout | null = null
  /** Null when on JSON. */
  private db: WorkspaceDb | null = null
  /** Each entity's JSON as last written, by rowKey. */
  private written = new Map<string, string>()
  /** Sessions whose items are not loaded yet. */
  private unloaded = new Set<string>()
  /** The digest stored with each session's row, by session id. */
  private digests = new Map<string, SessionDigest>()
  private itemRows = new Map<string, ItemRows>()
  /** Label groups, labels and item labels over `data`; settings of an item resolve through it. */
  labels!: Labels

  constructor(
    private file: string,
    backend: 'auto' | 'json' = 'auto',
  ) {
    const stored = backend === 'json' ? this.readFile() : this.openDb()
    if (stored) this.data = { ...this.data, ...stored }
    this.data.workspaces ??= []
    this.data.labelGroups ??= []
    this.data.labels ??= []
    this.data.itemLabels ??= []
    this.data.persons ??= []
    this.data.identities ??= []
    this.data.identityOverrides ??= []
    this.data.events ??= []
    this.data.integrations ??= []
    this.data.inboxStates ??= []
    this.data.inboxItems ??= []
    this.data.deliverables ??= []
    this.data.routines ??= []
    this.data.routineRuns ??= []
    this.data.ui ??= { windows: {}, workspaceWindows: [], recent: [] }
    this.data.ui.windows ??= {}
    this.data.ui.recent ??= []
    // Runs and live processes don't survive a restart, nor do their pending approvals and background tasks.
    for (const s of this.data.sessions) {
      if (s.status === 'running') s.status = 'idle'
      if (s.background?.length) s.items.push({ kind: 'notice', text: 'Background tasks ended with the process', at: Date.now() })
      delete s.background
      delete s.live
      // Only sessions with a pending approval have their items loaded for it.
      const digest = this.digests.get(s.id)
      if (this.unloaded.has(s.id) && digest && !digest.pendingApprovals.length) continue
      s.items.forEach((i, n) => {
        if (i.kind !== 'approval' || i.status !== 'pending') return
        i.status = 'expired'
        this.itemRowsOf(s.id).dirty.add(n)
      })
    }
    // Defaults for data written by older PoC versions.
    for (const p of this.data.projects) {
      delete (p as { devPoolSize?: number }).devPoolSize
      p.enforceArchitecture ??= false
      p.architecture = migrateArch(p.architecture)
      p.archRun ??= null
      p.agents ??= {}
      p.integrations ??= {}
      // T-55.5: mag has no tracker settings; a ticket is a link.
      delete (p as { trackers?: unknown }).trackers
      if (p.archRun?.status === 'running') p.archRun.status = 'error'
    }
    for (const t of this.data.tasks) {
      t.work ??= null
      delete (t as { dependsOn?: unknown }).dependsOn
      if ((t.type as string) === 'story') t.type = 'dev'
      t.rank ??= t.createdAt
      // T-55.5: the one tracker link (T-10, T-36) becomes the work's tickets; a link without a URL (an old import by key) goes.
      const old = (t as { tracker?: { key?: string; url?: string | null } | null }).tracker
      if (old !== undefined) {
        if (!t.parentId && old?.url) t.tickets = [old.key ? { url: old.url, key: old.key } : { url: old.url }]
        delete (t as { tracker?: unknown }).tracker
      }
    }
    for (const c of Object.values(this.data.canvases)) c.kind ??= 'html'
    for (const s of this.data.sessions) {
      if (s.projectId === undefined) s.projectId = this.data.tasks.find((t) => t.id === s.taskId)?.projectId ?? ''
      s.stepId ??= null
    }
    this.labels = createLabels(this.data, {
      workspaces: () => this.data.workspaces,
      projects: () => this.data.projects,
      item: (ref) => this.itemPlace(ref),
      setProject: (ref, pid) => this.moveItem(ref, pid),
      updateProject: (pid, patch) => this.updateProject(pid, patch),
    }, () => this.changed())
    this.migrate()
  }

  private readFile(): Partial<LegacyData> | null {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null
  }

  /**
   * Opens mag.sqlite next to the file. The first start imports the file in one transaction and keeps it as
   * db.pre-sqlite.json; a failed import leaves no db and returns the file's data, so the store runs on JSON.
   */
  private openDb(): Partial<LegacyData> | null {
    const dir = dirname(this.file)
    const path = join(dir, 'mag.sqlite')
    const kept = join(dir, 'db.pre-sqlite.json')
    const db = openWorkspaceDb(path)
    if (!db.ready()) {
      let json: Partial<LegacyData> | null = null
      try {
        json = this.readFile()
        if (json) db.importAll(importData(json), fileCounts(json))
        else db.init()
      } catch (e) {
        db.close()
        removeDb(path)
        if (!json) throw e
        log.error('store', `db.json not imported into SQLite, running on JSON: ${e instanceof Error ? e.message : e}`)
        return json
      }
      if (json) {
        log.info('store', `db.json imported into ${path}, kept as ${kept}`)
        this.keepFile(kept)
      }
    } else if (existsSync(this.file)) {
      if (existsSync(kept)) log.warn('store', `${this.file} ignored: ${path} holds the workspace`)
      // An import whose rename did not happen.
      else this.keepFile(kept)
    }
    this.db = db
    return this.fromRows(db.load())
  }

  private keepFile(dest: string) {
    try {
      renameSync(this.file, dest)
    } catch (e) {
      log.error('store', `could not keep ${this.file} as ${dest}`, e)
    }
  }

  private fromRows(rows: EntityRow[]): Partial<LegacyData> {
    const lists: Record<string, ListKey> = Object.fromEntries(Object.entries(LIST_KINDS).map(([k, kind]) => [kind, k as ListKey]))
    const data: Record<string, unknown> & Pick<Data, ListKey | MapKey> = { workspaces: [], projects: [], tasks: [], sessions: [], events: [], integrations: [], inboxStates: [], inboxItems: [], labelGroups: [], labels: [], itemLabels: [], deliverables: [], persons: [], identities: [], identityOverrides: [], routines: [], routineRuns: [], docs: {}, canvases: {} }
    for (const r of rows) {
      this.written.set(rowKey(r.kind, r.id), r.json)
      const value = JSON.parse(r.json)
      if (r.kind === 'session') {
        const { itemsDigest, ...session } = value as AgentSession & { itemsDigest?: SessionDigest }
        if (itemsDigest) this.digests.set(session.id, itemsDigest)
        this.lazyItems(session)
        data.sessions.push(session)
      } else if (lists[r.kind]) (data[lists[r.kind]] as unknown[]).push(value)
      else if (r.kind === 'doc') data.docs[r.id] = value
      else if (r.kind === 'canvas') data.canvases[r.id] = value
      else if (r.kind === 'ui') data.ui = value
      else if (r.kind === 'meta') data[r.id] = value
    }
    return data as Partial<LegacyData>
  }

  /** `s.items` loads the session's items from the db when first read; setting them rewrites all of its rows. */
  private lazyItems(s: AgentSession) {
    const sid = s.id
    let items: ChatItem[] | null = null
    this.unloaded.add(sid)
    const load = () => {
      if (items) return items
      items = this.db!.items(sid).map((json) => JSON.parse(json) as ChatItem)
      this.unloaded.delete(sid)
      this.itemRows.set(sid, { stored: items.length, clean: items.length, dirty: new Set() })
      return items
    }
    Object.defineProperty(s, 'items', {
      enumerable: true,
      configurable: true,
      get: load,
      set: (next: ChatItem[]) => {
        load()
        items = next
        this.itemRowsOf(sid).clean = 0
      },
    })
  }

  private itemRowsOf(sid: string): ItemRows {
    let rows = this.itemRows.get(sid)
    if (!rows) this.itemRows.set(sid, (rows = { stored: 0, clean: 0, dirty: new Set() }))
    return rows
  }

  /** Format migrations in the order they were added; a new one goes last. */
  private migrations = [
    () => this.migrateSubtaskKeys(),
    () => this.migrateToTaskWork(),
    () => this.migrateStatuses(),
    () => this.migrateToSteps(),
    () => this.migrateToWorkStates(),
    () => this.migrateToReviewResults(),
    () => this.migrateToClosedMark(),
    () => this.migrateToSessionTree(),
    () => this.migrateToParkedTopics(),
    () => this.migrateToTopicOwners(),
    () => this.migrateToReadsAuto(),
    () => this.migrateToEffort(),
    () => this.migrateToWorkspaces(WORKSPACE_MAP),
    () => this.migrateToLabels(),
  ]

  /** Runs the migrations this file has not had yet, each once, and records them in schemaVersion. */
  private migrate() {
    const from = this.data.schemaVersion ?? this.inferredVersion()
    delete this.data.stepsMigrated
    for (const run of this.migrations.slice(from)) run()
    if (this.data.schemaVersion === this.migrations.length) return
    this.data.schemaVersion = this.migrations.length
    this.changed()
  }

  /**
   * A file from before schemaVersion: every migration ran on each start then, so data of a later model means the
   * earlier ones have run. Work states (T-55.7) mean all of them; steps (T-28) mean all up to migrateToSteps.
   */
  private inferredVersion() {
    const { tasks } = this.data
    if (tasks.some((t) => !t.parentId && (t.status === 'planning' || t.status === 'ready'))) return 5
    // Through migrateToSteps.
    if (this.data.stepsMigrated || tasks.some((t) => t.parentId && t.work?.repos)) return 4
    return 0
  }

  /**
   * An idea is a parked topic (ideas-are-parked-topics.1): each idea becomes a parked chat topic titled after it, its
   * text the brief. One with a topic of its own parks that topic, unless the topic has messages: then it stays a live
   * topic with the brief. The ideas list goes.
   */
  private migrateToParkedTopics() {
    const data = this.data as LegacyData
    const used = new Set<string>()
    const talked = (s: AgentSession) => s.items.some((i) => i.kind === 'user' || i.kind === 'job' || i.kind === 'assistant')
    for (const idea of data.ideas ?? []) {
      const brief = idea.text.trim()
      if (!brief || !this.data.projects.some((p) => p.id === idea.projectId)) continue
      const own = idea.topicId && !used.has(idea.topicId) ? this.data.sessions.find((s) => s.id === idea.topicId && s.projectId === idea.projectId && s.role === 'chat' && !s.taskId && !s.parentId) : undefined
      const topic = own ?? this.newTopic(idea.projectId, idea.createdAt)
      used.add(topic.id)
      topic.brief = brief
      topic.source = idea.source ?? null
      if (own && talked(own)) continue
      topic.title = ideaTitle(brief).slice(0, 60)
      topic.titleGenerated = true
      // parkedAt marks a parked topic, so it is never 0 (an old idea without a real time).
      topic.parkedAt = idea.createdAt || Date.now()
      topic.closedAt = null
    }
    delete data.ideas
  }

  /**
   * Projects move into workspaces (workspaces-and-labels-project-as.1): one without a workspace goes to the one `map`
   * names it under (else `map.fallback`), made when missing; each workspace's repos get its projects' repos. With no
   * project, the fallback workspace is made. Idempotent: a second run changes nothing.
   */
  migrateToWorkspaces(map: WorkspaceMap) {
    const before = JSON.stringify([this.data.workspaces, this.data.projects.map((p) => p.workspaceId)])
    const named = (name: string) => this.data.workspaces.find((w) => sameName(w.name, name)) ?? this.newWorkspace(name)
    for (const p of this.data.projects) {
      if (this.data.workspaces.some((w) => w.id === p.workspaceId)) continue
      const target = Object.entries(map.workspaces).find(([, projects]) => projects.some((n) => sameName(n, p.name)))?.[0] ?? map.fallback
      p.workspaceId = named(target).id
    }
    if (!this.data.workspaces.length) named(map.fallback)
    for (const p of this.data.projects) this.addRepos(p)
    if (JSON.stringify([this.data.workspaces, this.data.projects.map((p) => p.workspaceId)]) !== before) this.changed()
  }

  /**
   * Labels (workspaces-and-labels-project-as.2): each workspace gets its Project group, each session the workspace of
   * its project (else the first one).
   */
  private migrateToLabels() {
    for (const w of this.data.workspaces) this.labels.ensureSystem(w.id)
    const first = this.data.workspaces[0]?.id ?? ''
    for (const s of this.data.sessions) s.workspaceId ||= this.data.projects.find((p) => p.id === s.projectId)?.workspaceId ?? first
    this.changed()
  }

  /** A choice gets an effort (model-picker-full-model-list.1): none stored = the provider's default. */
  private migrateToEffort() {
    for (const p of this.data.projects) for (const c of Object.values(p.agents ?? {})) if (c) c.effort ??= null
    for (const s of this.data.sessions) if (s.choice) s.choice.effort ??= null
  }

  /**
   * An integration on auto goes to reads (reads run at once, posts and changes wait for the user's Allow): what posts
   * for the user is asked first by default. The architect keeps auto: it has no chat to ask in.
   */
  private migrateToReadsAuto() {
    for (const p of this.data.projects) {
      for (const [role, modes] of Object.entries(p.integrations ?? {})) {
        if (role === 'architect' || !modes) continue
        for (const [id, mode] of Object.entries(modes)) if (mode === 'auto') modes[id] = 'reads'
      }
    }
  }

  /**
   * A work is its topic's: the sidebar lists only topics. A work without a chat topic for owner (one started from a
   * ticket before) is owned by the conversation the user had about it, its latest groomer's: that session becomes the
   * work's topic, its history and agent session kept. Nothing new is made: a work nobody talked about stays as it is.
   */
  private migrateToTopicOwners() {
    const topicIds = new Set(this.data.sessions.filter((s) => s.role === 'chat' && !s.taskId).map((s) => s.id))
    for (const t of this.data.tasks) {
      if (t.parentId || t.type === 'review' || (t.ownerSessionId && topicIds.has(t.ownerSessionId))) continue
      const groomer = this.data.sessions.filter((s) => s.taskId === t.id && s.role === 'groomer').at(-1)
      if (!groomer) continue
      Object.assign(groomer, { role: 'chat', taskId: null, stepId: null, parentId: null, title: t.title.slice(0, 60), titleGenerated: true })
      const finished = t.status === 'done' || t.status === 'canceled' || !!t.closedAt
      groomer.closedAt = finished ? (t.closedAt ?? t.updatedAt) : null
      t.ownerSessionId = groomer.id
    }
  }

  /**
   * Sessions form a tree (topics-a-tree-of-agent.2): a branched topic's branchOf becomes its parentId, so it is a child
   * of the topic it was branched from. One whose parent is gone becomes a topic of its own.
   */
  private migrateToSessionTree() {
    const ids = new Set(this.data.sessions.map((s) => s.id))
    for (const s of this.data.sessions) {
      const old = s as AgentSession & { branchOf?: string | null }
      if (!('branchOf' in old)) continue
      if (old.branchOf && ids.has(old.branchOf) && old.branchOf !== s.id) s.parentId = old.branchOf
      delete old.branchOf
    }
  }

  /**
   * The closed mark (redesign-start-screen-big-composer.2): every task gets closedAt; a review closed before it (done,
   * not imported) is closed since its last update.
   */
  private migrateToClosedMark() {
    for (const t of this.data.tasks) t.closedAt ??= t.type === 'review' && t.status === 'done' && !t.imported ? t.updatedAt : null
  }

  /**
   * One result per format (review-v2-part-2-v1-2.1): a review's result moves from its top-level fields to results.v2
   * when it has a report (with the user's direction call and its draft), else to results.v1; run by its owner topic.
   */
  private migrateToReviewResults() {
    for (const t of this.data.tasks) if (t.prReview) t.prReview = migratePrReview(t.prReview as PrReviewOnDisk, t.ownerSessionId)
  }

  /**
   * Task management goes (T-55.7): statuses become work states (grooming → planning, todo → ready), the project's
   * T-N counter and auto-archive go, archived works are just done or canceled. A backlog task nobody started on (no
   * steps, doc, sessions or diagrams) becomes an idea; one with any of them has a state, so it stays a work in planning.
   */
  private migrateToWorkStates() {
    let changed = false
    for (const p of this.data.projects) {
      const old = p as { nextTaskNo?: number; autoArchiveDays?: number }
      if (old.nextTaskNo === undefined && old.autoArchiveDays === undefined) continue
      delete old.nextTaskNo
      delete old.autoArchiveDays
      changed = true
    }
    const started = (t: Task) =>
      subtasksOf(t.id, this.data.tasks).length > 0 ||
      !!this.data.docs[t.id]?.trim() ||
      this.data.sessions.some((s) => s.taskId === t.id) ||
      Object.values(this.data.canvases).some((c) => c.taskId === t.id)
    for (const t of [...this.data.tasks]) {
      const status = t.status as string
      if ('archivedAt' in t) {
        delete (t as { archivedAt?: unknown }).archivedAt
        changed = true
      }
      if (t.parentId) continue
      if (status === 'grooming') t.status = 'planning'
      else if (status === 'todo') t.status = 'ready'
      else if (status === 'backlog' && started(t)) t.status = 'planning'
      else if (status === 'backlog') {
        const text = [t.title, t.description.trim(), ...(t.tickets ?? []).map((x) => x.url)].filter(Boolean).join('\n\n')
        const legacy = this.data as LegacyData
        legacy.ideas ??= []
        legacy.ideas.push({ id: id(), projectId: t.projectId, text, createdAt: t.createdAt })
        this.data.tasks = this.data.tasks.filter((x) => x.id !== t.id)
        delete this.data.docs[t.id]
      } else continue
      changed = true
    }
    if (changed) this.changed()
  }

  /**
   * Subtasks become steps (T-28). Checklists become steps that start on their own; a todo or in-progress task
   * without subtasks gets one step with its title. A legacy task (see isLegacy) is left alone: it finishes on its own
   * work, its subtasks stay a checklist.
   */
  private migrateToSteps() {
    for (const t of this.data.tasks) if (t.parentId) t.startManually ??= false
    for (const t of [...this.data.tasks]) {
      // Before T-55.7: todo is ready now (see migrateToWorkStates, which runs after).
      if (t.parentId || isLegacy(t) || ((t.status as string) !== 'todo' && t.status !== 'in_progress')) continue
      if (subtasksOf(t.id, this.data.tasks).length) continue
      const now = Date.now()
      this.data.tasks.push({
        id: id(), projectId: t.projectId, key: subtaskKey(t.key, t.nextSubNo++), parentId: t.id, title: t.title, type: t.type, status: 'todo', description: '',
        rank: 1, needsInput: null, work: null, startManually: false, nextSubNo: 1, createdAt: now, updatedAt: now,
      })
    }
    this.changed()
  }

  /**
   * Statuses before T-26: groomed and planned become todo, planned first in their order, then groomed by creation;
   * in_review becomes in_progress (its open PR shows as a badge).
   */
  private migrateStatuses() {
    let changed = false
    const old = (t: Task) => t.status as string
    for (const pid of new Set(this.data.tasks.map((t) => t.projectId))) {
      const mine = this.data.tasks.filter((t) => t.projectId === pid && !t.parentId)
      const groomed = mine.filter((t) => old(t) === 'groomed').sort((a, b) => a.createdAt - b.createdAt)
      let rank = Math.max(0, ...mine.filter((t) => ['planned', 'in_progress', 'in_review'].includes(old(t))).map((t) => t.rank))
      // Statuses of that time; migrateToWorkStates maps them to work states.
      for (const t of groomed) Object.assign(t, { status: 'todo', rank: ++rank })
      for (const t of mine) if (old(t) === 'planned') t.status = 'todo'
      changed ||= groomed.length > 0
    }
    for (const t of this.data.tasks) {
      if (old(t) === 'planned') t.status = 'todo'
      else if (old(t) === 'in_review') t.status = 'in_progress'
      else if (t.parentId && !['todo', 'in_progress', 'done'].includes(old(t))) t.status = 'todo'
      else continue
      changed = true
    }
    if (changed) this.changed()
  }

  /**
   * One developer session per task (T-22): work moves to the per-repo shape, subtasks become todo/done plan steps
   * without work, and their sessions and canvases move to the parent. A started parent that has no work of its own
   * (its subtasks had it) goes back to planned, so a developer picks it up as a whole. Only tasks of that time are
   * touched: one whose subtasks had work of the old shape; a step with per-repo work (T-28) keeps it.
   */
  private migrateToTaskWork() {
    let changed = false
    const oldWork = (t: Task) => !!t.work && !(t.work as { repos?: unknown }).repos
    const oldParents = new Set(this.data.tasks.filter((t) => t.parentId && oldWork(t)).map((t) => t.parentId!))
    const oldSubs = new Set(this.data.tasks.filter((t) => t.parentId && oldParents.has(t.parentId) && (!t.work || oldWork(t))).map((t) => t.id))
    for (const t of this.data.tasks) {
      const old = t.work as unknown as (LegacyWork & { repos?: unknown }) | null
      if (!old || old.repos) continue
      const prState = old.prUrl ? (t.status === 'done' ? 'merged' : 'open') : null
      t.work = { repos: [{ repo: old.repo, branch: old.branch, worktree: old.worktree, prUrl: old.prUrl, prState, checkError: old.checkError ?? null }], dir: old.worktree, feedbackSeenAt: old.feedbackSeenAt }
      changed = true
    }
    for (const sub of this.data.tasks) {
      const parent = oldSubs.has(sub.id) ? this.data.tasks.find((x) => x.id === sub.parentId) : undefined
      if (!parent) continue
      const status = sub.status === 'done' || parent.status === 'done' ? 'done' : 'todo'
      if (sub.status === status && !sub.work && !sub.needsInput) continue
      Object.assign(sub, { status, work: null, needsInput: null })
      changed = true
    }
    const parentOf = new Map(this.data.tasks.filter((t) => oldSubs.has(t.id)).map((t) => [t.id, t.parentId!]))
    for (const s of this.data.sessions) {
      const parentId = s.taskId && parentOf.get(s.taskId)
      if (!parentId) continue
      s.taskId = parentId
      // It ran in the subtask's worktree; the agent can't resume it from the task dir, so the next run starts fresh.
      s.nativeSessionId = null
      changed = true
    }
    for (const c of Object.values(this.data.canvases)) {
      const parentId = c.taskId && parentOf.get(c.taskId)
      if (!parentId) continue
      c.taskId = parentId
      changed = true
    }
    for (const t of this.data.tasks) {
      if (!oldParents.has(t.id) || t.work || (t.status !== 'in_progress' && (t.status as string) !== 'in_review')) continue
      // Before T-26's statuses; migrateStatuses turns it into todo.
      ;(t as { status: string }).status = 'planned'
      changed = true
    }
    if (changed) this.changed()
  }

  /** Subtasks used to take keys from the project counter (T-7); give them parent-based keys (T-6.1) and rewrite mentions. */
  private migrateSubtaskKeys() {
    const maps = new Map<string, Record<string, string>>()
    for (const parent of this.data.tasks) {
      parent.nextSubNo ??= 1
      for (const sub of subtasksOf(parent.id, this.data.tasks)) {
        if (sub.key.includes('.')) continue
        const key = subtaskKey(parent.key, parent.nextSubNo++)
        if (!maps.has(sub.projectId)) maps.set(sub.projectId, {})
        maps.get(sub.projectId)![sub.key] = key
        // work.branch / work.worktree keep the old key: they name real branches and dirs.
        sub.key = key
      }
    }
    for (const [pid, map] of maps) {
      const rw = (text: string) => rewriteKeys(text, map)
      for (const p of this.data.projects) if (p.id === pid) p.notes = rw(p.notes)
      for (const t of this.data.tasks) {
        if (t.projectId !== pid) continue
        t.title = rw(t.title)
        t.description = rw(t.description)
        if (this.data.docs[t.id] != null) this.data.docs[t.id] = rw(this.data.docs[t.id])
      }
      for (const s of this.data.sessions) {
        if (s.projectId !== pid) continue
        if (s.title) s.title = rw(s.title)
        s.items = s.items.map((i): ChatItem => {
          if (i.kind === 'user' || i.kind === 'assistant' || i.kind === 'error') return { ...i, text: rw(i.text) }
          if (i.kind === 'job') return { ...i, title: rw(i.title), text: rw(i.text) }
          if (i.kind === 'tool') return { ...i, summary: rw(i.summary) }
          if (i.kind === 'canvas') return { ...i, canvas: { ...i.canvas, title: rw(i.canvas.title) } }
          return i
        })
      }
      for (const c of Object.values(this.data.canvases)) {
        if (c.projectId !== pid) continue
        c.title = rw(c.title)
        if (c.html) c.html = rw(c.html)
      }
    }
    if (maps.size) this.changed()
  }

  onChange(fn: () => void) {
    this.listeners.push(fn)
  }

  /** Every change of a session's items: a push, an item changed in place, a cut or a replacement (see setItems). */
  onItem(fn: (e: SessionItemEvent) => void) {
    this.itemListeners.push(fn)
  }

  private emitItem(e: SessionItemEvent) {
    for (const fn of this.itemListeners) fn(e)
  }

  changed() {
    for (const fn of this.listeners) fn()
    this.save()
  }

  /** Sessions as windows get them: without items (see SessionHeader). */
  sessionHeaders(): SessionHeader[] {
    return this.data.sessions.map((s) => {
      const digest = this.digests.get(s.id)
      if (!this.unloaded.has(s.id) || !digest) return sessionHeader(s)
      const { rewound, ...rest } = sessionFields(s)
      return { ...rest, ...digest, rewound: !!rewound }
    })
  }

  /** A session's items from index `from`. */
  items(sid: string, from = 0): ChatItem[] {
    return this.session(sid).items.slice(Math.max(0, from))
  }

  /** A session's items without loading them into memory for good: the search index reads every session once. */
  peekItems(sid: string): ChatItem[] {
    if (!this.unloaded.has(sid) || !this.db) return this.session(sid).items
    return this.db.items(sid).map((json) => JSON.parse(json) as ChatItem)
  }

  /** How many items a session has and the last one's `at`, without loading them. */
  itemStats(sid: string): { count: number; lastAt: number | null } {
    const digest = this.digests.get(sid)
    if (this.unloaded.has(sid) && digest) return { count: digest.itemCount, lastAt: digest.lastItemAt }
    const items = this.session(sid).items
    return { count: items.length, lastAt: items.at(-1)?.at ?? null }
  }

  private save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 200)
  }

  /** Writes a pending save now, e.g. on quit, when the timer would not fire. */
  flush() {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    mkdirSync(dirname(this.file), { recursive: true })
    try {
      const backup = this.db ? this.db.backup(join(dirname(this.file), 'backups')) : backupDaily(this.file)
      if (backup) log.info('store', `backup: ${backup}`)
    } catch (e) {
      // A backup that fails must not stop the save.
      log.error('store', 'backup failed', e)
    }
    if (this.db) this.writeRows(this.db)
    else writeAtomic(this.file, JSON.stringify(this.data, null, 2))
  }

  /**
   * Writes the entities whose JSON changed since last written, removes the ones gone, and writes the loaded sessions'
   * changed and new items, in one transaction. A failure writes nothing, and the next flush writes it all again.
   */
  private writeRows(db: WorkspaceDb) {
    const itemsChanged = (s: AgentSession) => {
      const r = this.itemRows.get(s.id)
      return !r || r.dirty.size > 0 || r.clean !== s.items.length || r.stored !== s.items.length
    }
    const digest = (s: AgentSession) => {
      const stored = this.digests.get(s.id)
      if (stored && (this.unloaded.has(s.id) || !itemsChanged(s))) return stored
      const fresh = digestOf(s.items)
      this.digests.set(s.id, fresh)
      return fresh
    }
    const rows = entityRows(this.data, digest)
    const keys = new Set(rows.map((r) => rowKey(r.kind, r.id)))
    const put = rows.filter((r) => this.written.get(rowKey(r.kind, r.id)) !== r.json)
    const gone = [...this.written.keys()].filter((k) => !keys.has(k))
    const sessions = this.data.sessions.filter((s) => !this.unloaded.has(s.id) && itemsChanged(s))
    db.transaction(() => {
      for (const k of gone) db.remove(...(k.split('\u0000') as [string, string]))
      for (const r of put) db.put(r)
      for (const s of sessions) {
        const { items } = s
        const r = this.itemRowsOf(s.id)
        if (r.stored > items.length) db.cutItems(s.id, items.length)
        for (const n of r.dirty) if (n < Math.min(r.clean, items.length)) db.putItem(s.id, n, JSON.stringify(items[n]))
        for (let n = r.clean; n < items.length; n++) db.putItem(s.id, n, JSON.stringify(items[n]))
      }
    })
    for (const k of gone) {
      this.written.delete(k)
      const [kind, id] = k.split('\u0000')
      if (kind !== 'session') continue
      this.itemRows.delete(id)
      this.digests.delete(id)
      this.unloaded.delete(id)
    }
    for (const r of put) this.written.set(rowKey(r.kind, r.id), r.json)
    for (const s of sessions) this.itemRows.set(s.id, { stored: s.items.length, clean: s.items.length, dirty: new Set() })
  }

  /** Last bounds of a pop-out window of this kind. */
  windowBounds(kind: WindowKind): Bounds | undefined {
    return this.data.ui.windows[kind]
  }

  /** Remembers pop-out bounds; listeners are not told, since this is not app state. */
  saveWindowBounds(kind: WindowKind, bounds: Bounds) {
    this.data.ui.windows[kind] = bounds
    this.save()
  }

  /** Workspace windows to reopen on start; old project windows come as windows filtered to their project. */
  workspaceWindows(): WorkspaceWindow[] {
    return this.data.ui.workspaceWindows ?? fromProjectWindows(this.data.ui.projectWindows ?? [], this.data.projects)
  }

  /** Remembers the open workspace windows; not app state, so listeners are not told. */
  setWorkspaceWindows(list: WorkspaceWindow[]) {
    this.data.ui.workspaceWindows = list
    delete this.data.ui.projectWindows
    this.save()
  }

  /** Project ids, most recently opened first. */
  recent(): string[] {
    return this.data.ui.recent
  }

  /** Moves the project to the front of the recent list; listeners are told, so menus can rebuild. */
  touchRecent(pid: string) {
    const list = [pid, ...this.data.ui.recent.filter((x) => x !== pid)].slice(0, RECENT_MAX)
    if (list.join() === this.data.ui.recent.join()) return
    this.data.ui.recent = list
    this.changed()
  }

  project(pid: string) {
    const p = this.data.projects.find((x) => x.id === pid)
    if (!p) throw new Error(`No project ${pid}`)
    return p
  }

  task(tid: string) {
    const t = this.data.tasks.find((x) => x.id === tid)
    if (!t) throw new Error(`No task ${tid}`)
    return t
  }

  session(sid: string) {
    const s = this.data.sessions.find((x) => x.id === sid)
    if (!s) throw new Error(`No session ${sid}`)
    return s
  }

  /** Where an item is, for labels: null when there is no such topic or work. */
  private itemPlace(ref: ItemRef): { workspaceId: string; projectId: string | null; doc?: { text: string; stepKey?: string } } | null {
    const [kind, iid] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]
    if (kind === 'topic') {
      const s = this.data.sessions.find((x) => x.id === iid)
      return s ? { workspaceId: s.workspaceId, projectId: s.projectId } : null
    }
    const t = this.data.tasks.find((x) => x.id === iid)
    const p = t && this.data.projects.find((x) => x.id === t.projectId)
    if (!t || !p) return null
    return { workspaceId: p.workspaceId, projectId: t.projectId, doc: { text: this.data.docs[t.parentId ?? t.id] ?? '', ...(t.parentId && { stepKey: t.key }) } }
  }

  /** A topic moves to project `pid` (null: none); a work stays in its project. */
  private moveItem(ref: ItemRef, pid: string | null) {
    if (!ref.startsWith('topic:')) throw new Error('A work stays in its project')
    this.moveTopic(ref.slice('topic:'.length), pid)
  }

  /**
   * Moves a topic, with the sessions under it and the canvases drawn in them, to project `pid` of its workspace (null:
   * no project). Refused for a session under a topic and for a topic that owns a work or a review: they stay with it.
   */
  moveTopic(sid: string, pid: string | null) {
    const s = this.session(sid)
    if (s.taskId || s.parentId || s.role !== 'chat') throw new Error('Only a topic moves between projects')
    if (s.projectId === pid) return
    if (pid !== null && this.project(pid).workspaceId !== s.workspaceId) throw new Error('A topic moves between projects of its workspace')
    const tree = sessionTree(sid, this.data.sessions)
    const ids = new Set(tree.map((x) => x.id))
    const owned = this.data.tasks.filter((t) => !t.parentId && (ids.has(t.ownerSessionId ?? '') || tree.some((x) => x.reviewOf === t.id)))
    if (owned.length) throw new Error(`The topic owns ${owned.map((t) => t.key).join(', ')}: it stays in their project`)
    for (const x of tree) x.projectId = pid
    for (const c of Object.values(this.data.canvases)) if (c.sessionId && ids.has(c.sessionId) && !c.taskId) c.projectId = pid ?? ''
    for (const d of this.data.deliverables) if (d.topicId && ids.has(d.topicId)) d.projectId = pid
    this.changed()
  }

  /**
   * The project an item's runs read their settings from: its project, or for a topic without one a project made of its
   * workspace (id ''), with notes, playbook, agents and integrations resolved along its labels (Labels.settings); a
   * topic without a project gets its workspace's repos.
   */
  scopeOf(ref: ItemRef): Project {
    const place = this.itemPlace(ref)
    if (!place) throw new Error(`No item ${ref}`)
    const s = this.labels.settings(ref)
    const base = place.projectId ? this.project(place.projectId) : this.workspaceProject(place.workspaceId)
    return { ...base, notes: s.notes, playbook: s.playbook, agents: s.agents, integrations: s.integrations, repos: place.projectId ? base.repos : s.repos }
  }

  private workspaceProject(wid: string): Project {
    return workspaceAsProject(this.workspace(wid))
  }

  /** The settings scope of a session: its work's (a step's own), else its topic's. */
  sessionScope(session: Pick<AgentSession, 'id' | 'taskId' | 'stepId' | 'projectId' | 'workspaceId'>): Project {
    if (session.taskId) return this.scopeOf(`work:${session.stepId ?? session.taskId}`)
    if (!this.data.sessions.some((x) => x.id === session.id)) return session.projectId ? this.project(session.projectId) : this.workspaceProject(session.workspaceId)
    return this.scopeOf(`topic:${session.id}`)
  }

  /** Canvases for the renderer: without the HTML, with diagram data (it is small). */
  canvasList() {
    return Object.values(this.data.canvases).map(({ html: _, ...meta }) => meta)
  }

  /**
   * A new canvas, or a new version of `id`; a revision keeps the kind, and its placement, root and inventory unless given.
   * root: true makes it the only root of its set (povnyi-diff-nabir-pov-iazanykh.1).
   */
  saveCanvas(
    c: { id?: string; projectId: string; taskId: string | null; sessionId: string | null; title: string; placement?: CanvasPlacement; root?: boolean; inventory?: ChangeInventory } & (
      | { kind: 'html'; html: string }
      | { kind: 'diagram'; diagram: Diagram }
    ),
  ): Canvas {
    const prev = c.id ? this.data.canvases[c.id] : undefined
    if (c.id && !prev) throw new Error(`No canvas ${c.id}`)
    if (prev && prev.kind !== c.kind) throw new Error(`Canvas ${prev.id} is ${prev.kind === 'diagram' ? 'a diagram: revise it with show_diagram' : 'HTML: revise it with show_canvas'}`)
    const content = c.kind === 'html' ? { kind: c.kind, html: c.html } : { kind: c.kind, diagram: c.diagram }
    const extra = { ...(c.root !== undefined && { root: c.root }), ...(c.inventory !== undefined && { inventory: c.inventory }) }
    const canvas: Canvas = prev
      ? { ...prev, title: c.title || prev.title, ...content, ...c.placement, ...extra, version: prev.version + 1, updatedAt: Date.now() }
      : { id: id(), projectId: c.projectId, taskId: c.taskId, sessionId: c.sessionId, title: c.title, ...content, ...c.placement, ...extra, version: 1, updatedAt: Date.now() }
    this.data.canvases[canvas.id] = canvas
    if (canvas.root) for (const o of setOf(canvas, Object.values(this.data.canvases))) if (o.id !== canvas.id && o.root) this.data.canvases[o.id] = { ...o, root: false }
    this.changed()
    return canvas
  }

  /** Places a diagram in its work (T-55.3); the content and its version stay. */
  placeCanvas(canvasId: string, placement: CanvasPlacement): Canvas {
    const prev = this.data.canvases[canvasId]
    if (!prev) throw new Error(`No canvas ${canvasId}`)
    const canvas = { ...prev, ...placement }
    this.data.canvases[canvasId] = canvas
    this.changed()
    return canvas
  }

  /** The deliverables service's records, kept with the rest of the workspace. */
  deliverableRecords(): DeliverableRecords {
    return {
      all: () => this.data.deliverables,
      put: (d) => {
        const i = this.data.deliverables.findIndex((x) => x.id === d.id)
        if (i < 0) this.data.deliverables.push(d)
        else this.data.deliverables[i] = d
        this.changed()
      },
      remove: (id) => {
        const before = this.data.deliverables.length
        this.data.deliverables = this.data.deliverables.filter((x) => x.id !== id)
        if (this.data.deliverables.length !== before) this.changed()
      },
    }
  }

  /** The routines service's rows, kept with the rest of the workspace. */
  routineRecords(): RoutineRecords {
    return {
      routines: () => this.data.routines,
      putRoutine: (r) => {
        upsert(this.data.routines, r)
        this.changed()
      },
      removeRoutine: (id) => {
        this.data.routines = this.data.routines.filter((r) => r.id !== id)
        this.changed()
      },
      runs: () => this.data.routineRuns,
      putRun: (r) => {
        upsert(this.data.routineRuns, r)
        this.changed()
      },
      removeRuns: (ids) => {
        const gone = new Set(ids)
        this.data.routineRuns = this.data.routineRuns.filter((r) => !gone.has(r.id))
        this.changed()
      },
    }
  }

  /** Removes a canvas for good; a link to it in a chat or a doc shows as its title (right-panel-only-what-is.1). */
  deleteCanvas(canvasId: string) {
    if (!this.data.canvases[canvasId]) throw new Error(`No canvas ${canvasId}`)
    delete this.data.canvases[canvasId]
    this.changed()
  }

  /**
   * The canvases among `ids` that belong to no task yet (drawn in the project chat) move into the task: a doc that
   * links them makes them part of its work. Returns the ones moved.
   */
  adoptCanvases(taskId: string, ids: string[]): Canvas[] {
    const projectId = this.task(taskId).projectId
    const moved = ids.flatMap((cid) => {
      const c = this.data.canvases[cid]
      return c && c.projectId === projectId && c.taskId === null ? [(this.data.canvases[cid] = { ...c, taskId })] : []
    })
    if (moved.length) this.changed()
    return moved
  }

  workspaces(): Workspace[] {
    return this.data.workspaces
  }

  workspace(wid: string) {
    const w = this.data.workspaces.find((x) => x.id === wid)
    if (!w) throw new Error(`No workspace ${wid}`)
    return w
  }

  /** A new empty workspace; `name` trimmed, required and unique (case aside). */
  createWorkspace(name: string): Workspace {
    const w = this.newWorkspace(name)
    this.changed()
    return w
  }

  private newWorkspace(name: string): Workspace {
    const n = this.workspaceName(name)
    const w: Workspace = { id: id(), name: n, profile: '', notes: '', repos: [], playbook: null, agents: {}, integrations: {}, createdAt: Date.now() }
    this.data.workspaces.push(w)
    // Before labels exist (an early migration), migrateToLabels makes it.
    this.labels?.ensureSystem(w.id)
    return w
  }

  private workspaceName(name: string, except?: string) {
    const n = name.trim()
    if (!n) throw new Error('A workspace needs a name')
    if (this.data.workspaces.some((w) => w.id !== except && sameName(w.name, n))) throw new Error(`A workspace named ${n} exists`)
    return n
  }

  /** Changes a workspace; its repos must keep every repo of its projects. */
  updateWorkspace(wid: string, patch: Partial<Omit<Workspace, 'id' | 'createdAt'>>) {
    const w = this.workspace(wid)
    const next = { ...patch }
    if (next.name !== undefined) next.name = this.workspaceName(next.name, wid)
    if (next.repos) {
      const used = this.data.projects.filter((p) => p.workspaceId === wid).flatMap((p) => p.repos.filter((r) => !next.repos!.includes(r)).map((r) => `${r} (${p.name})`))
      if (used.length) throw new Error(`Repos of the workspace's projects stay: ${used.join(', ')}`)
    }
    Object.assign(w, next, { id: wid, createdAt: w.createdAt })
    this.changed()
  }

  /**
   * A project moved from workspace `from`: its sessions go with it, its Project label's rules to the new Project group;
   * its items' labels of the old workspace's groups are dropped.
   */
  private moveLabels(p: Project, from: string) {
    for (const s of this.data.sessions) if (s.projectId === p.id) s.workspaceId = p.workspaceId
    for (const l of this.data.labels) if (l.id === p.id && l.groupId === projectGroupId(from)) l.groupId = projectGroupId(p.workspaceId)
    const refs = new Set([...this.data.sessions.filter((s) => s.projectId === p.id).map((s) => `topic:${s.id}`), ...this.data.tasks.filter((t) => t.projectId === p.id).map((t) => `work:${t.id}`)])
    const old = new Set(this.data.labels.filter((l) => this.data.labelGroups.some((g) => g.id === l.groupId && g.workspaceId === from)).map((l) => l.id))
    this.data.itemLabels = this.data.itemLabels.filter((r) => !(refs.has(r.itemRef) && old.has(r.labelId)))
    this.labels.ensureSystem(p.workspaceId)
  }

  /** The project's repos join its workspace's. */
  private addRepos(p: Project) {
    const w = this.data.workspaces.find((x) => x.id === p.workspaceId)
    if (!w) return
    const missing = p.repos.filter((r) => !w.repos.includes(r))
    if (missing.length) w.repos = [...w.repos, ...missing]
  }

  /** A new project, in `workspaceId`, else in the workspace of the last opened project, else the first. */
  createProject(name: string, workspaceId?: string): Project {
    if (workspaceId) this.workspace(workspaceId)
    const recent = this.data.projects.find((x) => x.id === this.data.ui.recent[0])?.workspaceId
    const wid = workspaceId ?? recent ?? this.data.workspaces[0]?.id ?? this.newWorkspace(WORKSPACE_MAP.fallback).id
    const p: Project = { id: id(), name, workspaceId: wid, repos: [], notes: '', enforceArchitecture: true, architecture: null, archRun: null, agents: {}, integrations: {}, sidebar: [], createdAt: Date.now() }
    this.data.projects.push(p)
    this.changed()
    return p
  }

  /** Stores the user's state of an inbox item, replacing the one of its key. */
  putInboxState(state: InboxState) {
    upsert(this.data.inboxStates, state)
    this.changed()
  }

  removeInboxStates(keys: string[]) {
    const gone = new Set(keys)
    const kept = this.data.inboxStates.filter((s) => !gone.has(s.key))
    if (kept.length === this.data.inboxStates.length) return
    this.data.inboxStates = kept
    this.changed()
  }

  /** Stores an added inbox item, replacing the one of its key. */
  putInboxItem(item: AddedItem) {
    upsert(this.data.inboxItems, item)
    this.changed()
  }

  /**
   * Adds or renames the integrations a run reported. Known ones are kept even when a run doesn't report them:
   * an integration that is off may be missing from the run's tools.
   */
  saveIntegrations(found: Integration[]) {
    let changed = false
    for (const f of found) {
      const known = this.data.integrations.find((i) => i.id === f.id)
      if (!known) this.data.integrations.push({ ...f })
      else if (known.name !== f.name && f.name !== f.id) known.name = f.name
      else continue
      changed = true
    }
    if (changed) this.changed()
  }

  /** Changes a project; moved to another workspace (`workspaceId`) or given repos, its repos join that workspace's. */
  updateProject(pid: string, patch: Partial<Project>) {
    if (patch.workspaceId !== undefined) this.workspace(patch.workspaceId)
    const p = this.project(pid)
    const from = p.workspaceId
    Object.assign(p, patch, { id: pid })
    if (p.workspaceId !== from) this.moveLabels(p, from)
    this.addRepos(p)
    this.changed()
  }

  createTask(n: NewTask): Task {
    const p = this.project(n.projectId)
    const now = Date.now()
    const parentId = n.parentId ?? null
    const mine = this.data.tasks.filter((x) => x.projectId === p.id)
    const parent = parentId ? this.task(parentId) : null
    const t: Task = {
      id: id(),
      projectId: p.id,
      key: parent ? subtaskKey(parent.key, parent.nextSubNo++) : workKey(n.title, n.tickets, mine.filter((x) => !x.parentId).map((x) => x.key)),
      parentId,
      title: n.title,
      type: n.type,
      status: n.status ?? (parent ? 'todo' : 'planning'),
      description: n.description,
      // Steps keep their order; works have none.
      rank: parent ? Math.max(0, ...subtasksOf(parent.id, mine).map((x) => x.rank)) + 1 : 0,
      needsInput: null,
      work: null,
      closedAt: null,
      ...(parent && { startManually: n.startManually ?? false }),
      ...(parent && n.repos && { repos: n.repos }),
      ...(!parent && n.tickets?.length && { tickets: n.tickets }),
      ...(!parent && n.ownerSessionId && { ownerSessionId: n.ownerSessionId }),
      nextSubNo: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.data.tasks.push(t)
    if (!parent) this.autoLabelWork(t.id)
    this.changed()
    return t
  }

  /**
   * An imported review (review-v2-part-2-v1-2.3): a review work, done and read only, with its doc and its diagrams as
   * they came (their ids already new to this machine).
   */
  createImportedReview(projectId: string, r: { task: Pick<Task, 'title' | 'description' | 'prReview' | 'fact' | 'imported'>; doc: string; canvases: Omit<Canvas, 'projectId' | 'sessionId' | 'taskId'>[] }): Task {
    for (const c of r.canvases) if (this.data.canvases[c.id]) throw new Error(`Canvas ${c.id} exists already`)
    const t = this.createTask({ projectId, title: r.task.title, type: 'review', description: r.task.description, status: 'done' })
    Object.assign(t, { prReview: r.task.prReview, fact: r.task.fact, imported: r.task.imported })
    this.data.docs[t.id] = r.doc
    for (const c of r.canvases) this.data.canvases[c.id] = { ...c, projectId, taskId: t.id, sessionId: null }
    this.changed()
    return t
  }

  updateTask(tid: string, patch: Partial<Task>) {
    const t = this.task(tid)
    const prev = { ...t }
    // The questions behind needsInput go with it (ux-odna-rozmova-na-robotu.2).
    if ('needsInput' in patch && !('needsQuestions' in patch)) patch = { ...patch, needsQuestions: null }
    Object.assign(t, patch, { id: tid, updatedAt: Date.now() })
    for (const e of taskChangeEvents(prev, t)) this.logEvent(e)
    // Rules run again only when a signal changed: a ticket, or the set of repositories; not on every PR poll.
    const signal = (x: Pick<Task, 'tickets' | 'work'>) => JSON.stringify([(x.tickets ?? []).map((k) => k.key ?? ''), [...new Set((x.work?.repos ?? []).map((r) => r.repo))].sort()])
    if ((patch.tickets || patch.work) && signal(prev) !== signal(t)) this.autoLabelWork(t.parentId ?? t.id)
    this.changed()
  }

  /** Rules label a work from its own signals: its tickets' keys, its and its steps' repositories, its project. */
  private autoLabelWork(tid: string) {
    const t = this.task(tid)
    const steps = this.data.tasks.filter((x) => x.parentId === t.id)
    const repos = [...new Set([t, ...steps].flatMap((x) => (x.work?.repos ?? []).map((r) => r.repo)))]
    const ticketKeys = (t.tickets ?? []).flatMap((k) => (k.key ? [k.key] : []))
    this.labels.autoLabel(`work:${t.id}`, { repos, ticketKeys, openedFrom: t.projectId })
  }

  /** Appends an item to a session's chat and saves. */
  pushItem(sid: string, item: ChatItem) {
    const items = this.session(sid).items
    items.push(item)
    this.emitItem({ sid, n: items.length - 1, item })
    this.changed()
  }

  /** `item`, one of the session's, was changed in place; saves. One no longer there (cut by a rewind) only saves. */
  itemChanged(sid: string, item: ChatItem) {
    const n = this.session(sid).items.indexOf(item)
    if (n >= 0) {
      this.itemRowsOf(sid).dirty.add(n)
      this.emitItem({ sid, n, item })
    }
    this.changed()
  }

  /** Replaces a session's items (a rewind, its undo); windows get the cut and the items after what both share. */
  setItems(sid: string, items: ChatItem[]) {
    const s = this.session(sid)
    let same = 0
    while (same < items.length && same < s.items.length && items[same] === s.items[same]) same++
    if (same < s.items.length) this.emitItem({ sid, truncate: same })
    const rows = this.itemRowsOf(sid)
    const clean = Math.min(rows.clean, same)
    s.items = items
    rows.clean = clean
    for (let n = same; n < items.length; n++) this.emitItem({ sid, n, item: items[n] })
    this.changed()
  }

  /** Appends to the project's activity log, keeping the last EVENTS_PER_PROJECT. */
  logEvent(e: NewEvent) {
    this.data.events.push({ ...e, id: id(), at: Date.now() })
    const mine = this.data.events.filter((x) => x.projectId === e.projectId)
    if (mine.length > EVENTS_PER_PROJECT) {
      const drop = new Set(mine.slice(0, mine.length - EVENTS_PER_PROJECT))
      this.data.events = this.data.events.filter((x) => !drop.has(x))
    }
    this.changed()
  }

  /** Sets the subtask order of a parent: `ids` must name each of its subtasks exactly once. */
  reorderSubtasks(parentId: string, ids: string[]) {
    const subs = subtasksOf(parentId, this.data.tasks)
    const known = new Set(subs.map((t) => t.id))
    if (ids.length !== subs.length || new Set(ids).size !== ids.length || !ids.every((x) => known.has(x)))
      throw new Error(`Pass every subtask exactly once: ${subs.map((t) => t.key).join(', ')}`)
    ids.forEach((tid, rank) => this.updateTask(tid, { rank }))
  }

  /** Removes a task with its doc, canvases and sessions; its events stay in the log. */
  deleteTask(tid: string) {
    this.task(tid)
    this.labels.forget(`work:${tid}`)
    this.data.tasks = this.data.tasks.filter((t) => t.id !== tid)
    this.data.sessions = this.data.sessions.filter((s) => s.taskId !== tid)
    delete this.data.docs[tid]
    for (const c of Object.values(this.data.canvases)) if (c.taskId === tid) delete this.data.canvases[c.id]
    this.changed()
  }

  /**
   * Parks a new topic, an idea (ideas-are-parked-topics.1): titled after `text` (trimmed, required), which is its brief;
   * `source`: the work or step key whose agent parked it.
   */
  parkTopic(projectId: string, text: string, source?: string | null): AgentSession {
    this.project(projectId)
    const brief = ideaText(text)
    const now = Date.now()
    const topic = this.newTopic(projectId, now)
    Object.assign(topic, { title: ideaTitle(brief).slice(0, 60), titleGenerated: true, parkedAt: now, brief, source: source ?? null })
    this.changed()
    return topic
  }

  /** An empty chat topic of the project, run by the project's chat agent. */
  private newTopic(projectId: string, createdAt: number): AgentSession {
    const topic: AgentSession = {
      id: id(), workspaceId: this.project(projectId).workspaceId, projectId, taskId: null, stepId: null, role: 'chat', agent: resolveChoice(this.project(projectId), 'chat').agent,
      status: 'idle', title: 'New topic', createdAt, items: [], nativeSessionId: null,
    }
    this.data.sessions.push(topic)
    return topic
  }

  /** A new session; without `workspaceId`, its project's. */
  createSession(s: Omit<AgentSession, 'id' | 'createdAt' | 'items' | 'nativeSessionId' | 'workspaceId'> & { workspaceId?: string }): AgentSession {
    const workspaceId = s.workspaceId ?? (s.projectId ? this.project(s.projectId).workspaceId : null)
    if (!workspaceId) throw new Error('A session without a project needs a workspace')
    this.workspace(workspaceId)
    const full: AgentSession = { ...s, workspaceId, id: id(), createdAt: Date.now(), items: [], nativeSessionId: null }
    this.data.sessions.push(full)
    this.changed()
    return full
  }

  /** Closes a project topic: listed under Done, its history kept. */
  closeSession(sid: string) {
    this.session(sid).closedAt = Date.now()
    this.changed()
  }

  /** Closes a done work or a review: it stays as it is (doc, sessions, history) and goes to Closed. */
  closeTask(tid: string) {
    this.updateTask(tid, { closedAt: Date.now() })
  }

  /** Restore of a closed work or review: back in the list, where it was. */
  reopenTask(tid: string) {
    if (this.task(tid).closedAt) this.updateTask(tid, { closedAt: null })
  }

  /** An archived topic's or task's summary, covering its items up to `at`; not an update of the task (updatedAt stays). */
  setSummary(kind: 'topic' | 'task', id: string, summary: ChatSummary, at: number) {
    const item = kind === 'topic' ? this.session(id) : this.task(id)
    item.summary = summary
    item.summaryAt = at
    this.changed()
  }

  /** Opens a closed topic again (writing to it does). */
  reopenSession(sid: string) {
    const s = this.session(sid)
    if (!s.closedAt) return
    s.closedAt = null
    this.changed()
  }

  /**
   * Removes a session with the sessions under it (its tree, topics-a-tree-of-agent.2); canvases drawn in them and events
   * stay.
   */
  deleteSession(sid: string) {
    this.session(sid)
    const gone = new Set(sessionTree(sid, this.data.sessions).map((s) => s.id))
    for (const g of gone) this.labels.forget(`topic:${g}`)
    this.data.sessions = this.data.sessions.filter((s) => !gone.has(s.id))
    this.changed()
  }
}
