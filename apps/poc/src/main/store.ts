import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isLegacy, rewriteKeys, subtaskKey, subtasksOf, taskChangeEvents, type AgentSession, type ArchDiagram, type ArchNode, type Canvas, type ChatItem, type Diagram, type Integration, type NewEvent, type Project, type ProjectEvent, type Task } from '@mag/core'
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
  /** migrateToSteps has run (T-28). */
  stepsMigrated?: boolean
}

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
      p.trackers ??= []
      if (p.archRun?.status === 'running') p.archRun.status = 'error'
    }
    for (const t of this.data.tasks) {
      t.work ??= null
      delete (t as { dependsOn?: unknown }).dependsOn
      if ((t.type as string) === 'story') t.type = 'dev'
      t.rank ??= t.createdAt
    }
    for (const c of Object.values(this.data.canvases)) c.kind ??= 'html'
    for (const s of this.data.sessions) {
      s.projectId ??= this.data.tasks.find((t) => t.id === s.taskId)?.projectId ?? ''
      s.stepId ??= null
    }
    this.migrateSubtaskKeys()
    this.migrateToTaskWork()
    this.migrateStatuses()
    this.migrateToSteps()
  }

  /**
   * Subtasks become steps (T-28), once. Checklists become steps that start on their own; a todo or in-progress task
   * without subtasks gets one step with its title. A legacy task (see isLegacy) is left alone: it finishes on its own
   * work, its subtasks stay a checklist.
   */
  private migrateToSteps() {
    if (this.data.stepsMigrated) return
    for (const t of this.data.tasks) if (t.parentId) t.startManually ??= false
    for (const t of [...this.data.tasks]) {
      if (t.parentId || isLegacy(t) || (t.status !== 'todo' && t.status !== 'in_progress')) continue
      if (subtasksOf(t.id, this.data.tasks).length) continue
      const now = Date.now()
      this.data.tasks.push({
        id: id(), projectId: t.projectId, key: subtaskKey(t.key, t.nextSubNo++), parentId: t.id, title: t.title, type: t.type, status: 'todo', description: '',
        rank: 1, needsInput: null, work: null, startManually: false, nextSubNo: 1, archivedAt: null, createdAt: now, updatedAt: now,
      })
    }
    this.data.stepsMigrated = true
    this.changed()
  }

  /**
   * Statuses before T-26: groomed and planned become todo, planned first in their order, then groomed by creation;
   * in_review becomes in_progress (its open PR shows as a badge). Every task gets an archive flag.
   */
  private migrateStatuses() {
    let changed = false
    const old = (t: Task) => t.status as string
    for (const pid of new Set(this.data.tasks.map((t) => t.projectId))) {
      const mine = this.data.tasks.filter((t) => t.projectId === pid && !t.parentId)
      const groomed = mine.filter((t) => old(t) === 'groomed').sort((a, b) => a.createdAt - b.createdAt)
      let rank = Math.max(0, ...mine.filter((t) => ['planned', 'in_progress', 'in_review'].includes(old(t))).map((t) => t.rank))
      for (const t of groomed) Object.assign(t, { status: 'todo', rank: ++rank })
      for (const t of mine) if (old(t) === 'planned') t.status = 'todo'
      changed ||= groomed.length > 0
    }
    for (const t of this.data.tasks) {
      if (t.archivedAt === undefined) {
        t.archivedAt = null
        changed = true
      }
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
   * (its subtasks had it) goes back to planned, so a developer picks it up as a whole.
   */
  private migrateToTaskWork() {
    let changed = false
    for (const t of this.data.tasks) {
      const old = t.work as unknown as (LegacyWork & { repos?: unknown }) | null
      if (!old || old.repos) continue
      const prState = old.prUrl ? (t.status === 'done' ? 'merged' : 'open') : null
      t.work = { repos: [{ repo: old.repo, branch: old.branch, worktree: old.worktree, prUrl: old.prUrl, prState, checkError: old.checkError ?? null }], dir: old.worktree, feedbackSeenAt: old.feedbackSeenAt }
      changed = true
    }
    for (const sub of this.data.tasks) {
      const parent = sub.parentId ? this.data.tasks.find((x) => x.id === sub.parentId) : undefined
      if (!parent) continue
      const status = sub.status === 'done' || parent.status === 'done' ? 'done' : 'todo'
      if (sub.status === status && !sub.work && !sub.needsInput) continue
      Object.assign(sub, { status, work: null, needsInput: null })
      changed = true
    }
    const parentOf = new Map(this.data.tasks.filter((t) => t.parentId).map((t) => [t.id, t.parentId!]))
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
      if (t.parentId || t.work || (t.status !== 'in_progress' && (t.status as string) !== 'in_review')) continue
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

  /** A new canvas, or a new version of `id`; a revision keeps the kind. */
  saveCanvas(
    c: { id?: string; projectId: string; taskId: string | null; sessionId: string | null; title: string } & ({ kind: 'html'; html: string } | { kind: 'diagram'; diagram: Diagram }),
  ): Canvas {
    const prev = c.id ? this.data.canvases[c.id] : undefined
    if (c.id && !prev) throw new Error(`No canvas ${c.id}`)
    if (prev && prev.kind !== c.kind) throw new Error(`Canvas ${prev.id} is ${prev.kind === 'diagram' ? 'a diagram: revise it with show_diagram' : 'HTML: revise it with show_canvas'}`)
    const content = c.kind === 'html' ? { kind: c.kind, html: c.html } : { kind: c.kind, diagram: c.diagram }
    const canvas: Canvas = prev
      ? { ...prev, title: c.title || prev.title, ...content, version: prev.version + 1, updatedAt: Date.now() }
      : { id: id(), projectId: c.projectId, taskId: c.taskId, sessionId: c.sessionId, title: c.title, ...content, version: 1, updatedAt: Date.now() }
    this.data.canvases[canvas.id] = canvas
    this.changed()
    return canvas
  }

  createProject(name: string): Project {
    const p: Project = { id: id(), name, repos: [], notes: '', templates: {}, nextTaskNo: 1, baseBranch: 'main', enforceArchitecture: true, architecture: null, archRun: null, agents: {}, integrations: {}, trackers: [], createdAt: Date.now() }
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
    const siblings = this.data.tasks.filter((x) => x.projectId === p.id && x.parentId === parentId)
    const parent = parentId ? this.task(parentId) : null
    const t: Task = {
      id: id(),
      projectId: p.id,
      key: parent ? subtaskKey(parent.key, parent.nextSubNo++) : `T-${p.nextTaskNo++}`,
      parentId,
      title: n.title,
      type: n.type,
      status: n.status ?? 'backlog',
      description: n.description,
      rank: Math.max(0, ...siblings.map((x) => x.rank)) + 1,
      needsInput: null,
      work: null,
      ...(parent && { startManually: n.startManually ?? false }),
      ...(!parent && n.tracker && { tracker: n.tracker }),
      nextSubNo: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.data.tasks.push(t)
    this.changed()
    return t
  }

  updateTask(tid: string, patch: Partial<Task>) {
    const t = this.task(tid)
    const prev = { ...t }
    Object.assign(t, patch, { id: tid, updatedAt: Date.now() })
    for (const e of taskChangeEvents(prev, t)) this.logEvent(e)
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

  createSession(s: Omit<AgentSession, 'id' | 'createdAt' | 'items' | 'nativeSessionId'>): AgentSession {
    const full: AgentSession = { ...s, id: id(), createdAt: Date.now(), items: [], nativeSessionId: null }
    this.data.sessions.push(full)
    this.changed()
    return full
  }
}
