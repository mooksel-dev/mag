import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ideaText, ideaTitle, isLegacy, resolveChoice, sessionTree, migratePrReview, type LegacyPrReview, setOf, rewriteKeys, subtaskKey, subtasksOf, taskChangeEvents, workKey, type AgentSession, type ArchDiagram, type ArchNode, type Canvas, type CanvasPlacement, type ChangeInventory, type ChatItem, type ChatSummary, type Diagram, type Integration, type NewEvent, type Project, type ProjectEvent, type Task } from '@mag/core'
import type { NewTask, WindowKind } from '../preload/api'
import type { Bounds } from './bounds'

interface Data {
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

/** A project window that was open, to reopen on start. */
export interface ProjectWindow {
  projectId: string
  bounds: Bounds
}

interface UiState {
  /** Last bounds per pop-out kind. */
  windows: Partial<Record<WindowKind, Bounds>>
  /** Project windows open on quit (or now), in opening order. */
  projectWindows: ProjectWindow[]
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

/** PoC persistence: one JSON file, rewritten on change. */
export class Store {
  data: Data = { projects: [], tasks: [], sessions: [], docs: {}, canvases: {}, events: [], integrations: [], ui: { windows: {}, projectWindows: [], recent: [] } }
  private listeners: (() => void)[] = []
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private file: string) {
    if (existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) }
    this.data.events ??= []
    this.data.integrations ??= []
    this.data.ui ??= { windows: {}, projectWindows: [], recent: [] }
    this.data.ui.windows ??= {}
    this.data.ui.projectWindows ??= []
    this.data.ui.recent ??= []
    // Runs and live processes don't survive a restart, nor do their pending approvals and background tasks.
    for (const s of this.data.sessions) {
      if (s.status === 'running') s.status = 'idle'
      if (s.background?.length) s.items.push({ kind: 'notice', text: 'Background tasks ended with the process', at: Date.now() })
      delete s.background
      delete s.live
      for (const i of s.items) if (i.kind === 'approval' && i.status === 'pending') i.status = 'expired'
    }
    // Defaults for data written by older PoC versions.
    for (const p of this.data.projects) {
      delete (p as { devPoolSize?: number }).devPoolSize
      p.templates ??= {}
      delete (p.templates as Record<string, string>).story
      p.baseBranch ??= 'main'
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
      s.projectId ??= this.data.tasks.find((t) => t.id === s.taskId)?.projectId ?? ''
      s.stepId ??= null
    }
    this.migrate()
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
   * Every work and review is a topic's: the sidebar lists only topics. A work without a chat topic for owner (a
   * groomer's, a ticket's from before) gets a topic of its own that owns it, closed when the work is finished; its
   * groomer stays as one of its agents. A review without one gets a topic of mag's for it (reviewOf).
   */
  private migrateToTopicOwners() {
    const topicIds = new Set(this.data.sessions.filter((s) => s.role === 'chat' && !s.taskId).map((s) => s.id))
    const reviewTopics = new Set(this.data.sessions.flatMap((s) => (s.reviewOf ? [s.reviewOf] : [])))
    for (const t of this.data.tasks) {
      if (t.parentId || (t.ownerSessionId && topicIds.has(t.ownerSessionId)) || reviewTopics.has(t.id)) continue
      if (!this.data.projects.some((p) => p.id === t.projectId)) continue
      const topic = this.newTopic(t.projectId, t.createdAt)
      topic.title = t.title.slice(0, 60)
      topic.titleGenerated = true
      const finished = t.status === 'done' || t.status === 'canceled' || !!t.closedAt
      topic.closedAt = finished ? (t.closedAt ?? t.updatedAt) : null
      if (t.type === 'review') topic.reviewOf = t.id
      else topic.items.push({ kind: 'notice', text: `This topic owns ${t.key} now: its planning conversation is under Agents.`, at: Date.now() })
      t.ownerSessionId = topic.id
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

  changed() {
    for (const fn of this.listeners) fn()
    this.save()
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
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
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

  /** Project windows to reopen on start. */
  projectWindows(): ProjectWindow[] {
    return this.data.ui.projectWindows
  }

  /** Remembers the open project windows; not app state, so listeners are not told. */
  setProjectWindows(list: ProjectWindow[]) {
    this.data.ui.projectWindows = list
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

  createProject(name: string): Project {
    const p: Project = { id: id(), name, repos: [], notes: '', templates: {}, baseBranch: 'main', enforceArchitecture: true, architecture: null, archRun: null, agents: {}, integrations: {}, sidebar: [], createdAt: Date.now() }
    this.data.projects.push(p)
    this.changed()
    return p
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

  updateProject(pid: string, patch: Partial<Project>) {
    Object.assign(this.project(pid), patch, { id: pid })
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
    this.changed()
  }

  /** Appends an item to a session's chat and saves. */
  pushItem(sid: string, item: ChatItem) {
    this.session(sid).items.push(item)
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
      id: id(), projectId, taskId: null, stepId: null, role: 'chat', agent: resolveChoice(this.project(projectId), 'chat').agent,
      status: 'idle', title: 'New topic', createdAt, items: [], nativeSessionId: null,
    }
    this.data.sessions.push(topic)
    return topic
  }

  createSession(s: Omit<AgentSession, 'id' | 'createdAt' | 'items' | 'nativeSessionId'>): AgentSession {
    const full: AgentSession = { ...s, id: id(), createdAt: Date.now(), items: [], nativeSessionId: null }
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
    this.data.sessions = this.data.sessions.filter((s) => !gone.has(s.id))
    this.changed()
  }
}
