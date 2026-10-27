import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BACKLOG_STATUSES, PLAN_STATUSES, rewriteKeys, subtaskKey, subtasksOf, taskChangeEvents, type AgentSession, type Canvas, type ChatItem, type Integration, type NewEvent, type Project, type ProjectEvent, type Task } from '@mag/core'
import type { NewTask } from '../preload/api'

interface Data {
  projects: Project[]
  tasks: Task[]
  sessions: AgentSession[]
  docs: Record<string, string>
  /** Agent-drawn HTML; not sent to the renderer with the state (see canvasList). */
  canvases: Record<string, Canvas>
  /** Project activity log, oldest first; kept after its task is deleted. */
  events: ProjectEvent[]
  /** MCP servers the agent CLI reported, for every project: connectors belong to the account. */
  integrations: Integration[]
}

/** Events kept per project. */
const EVENTS_PER_PROJECT = 300

const id = () => randomUUID().slice(0, 8)

/** PoC persistence: one JSON file, rewritten on change. */
export class Store {
  data: Data = { projects: [], tasks: [], sessions: [], docs: {}, canvases: {}, events: [], integrations: [] }
  private listeners: (() => void)[] = []
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private file: string) {
    if (existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) }
    this.data.events ??= []
    this.data.integrations ??= []
    // Runs don't survive a restart.
    for (const s of this.data.sessions) if (s.status === 'running') s.status = 'idle'
    // Defaults for data written by older PoC versions.
    for (const p of this.data.projects) {
      delete (p as { devPoolSize?: number }).devPoolSize
      p.templates ??= {}
      delete (p.templates as Record<string, string>).story
      p.baseBranch ??= 'main'
      p.enforceArchitecture ??= false
      p.architecture ??= null
      p.archRun ??= null
      p.agents ??= {}
      p.integrations ??= {}
      if (p.archRun?.status === 'running') p.archRun.status = 'error'
    }
    for (const t of this.data.tasks) {
      t.work ??= null
      delete (t as { dependsOn?: unknown }).dependsOn
      if ((t.type as string) === 'story') t.type = 'dev'
      t.rank ??= t.createdAt
    }
    // Subtasks are no longer groomed separately: not-started ones follow their parent.
    for (const t of this.data.tasks) {
      const parent = t.parentId ? this.data.tasks.find((x) => x.id === t.parentId) : undefined
      if (!parent || !BACKLOG_STATUSES.includes(t.status)) continue
      t.status = PLAN_STATUSES.includes(parent.status) ? 'planned' : 'groomed'
      t.needsInput = null
    }
    for (const s of this.data.sessions)
      s.projectId ??= this.data.tasks.find((t) => t.id === s.taskId)?.projectId ?? ''
    this.migrateSubtaskKeys()
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
        c.html = rw(c.html)
      }
    }
    if (maps.size) this.changed()
  }

  onChange(fn: () => void) {
    this.listeners.push(fn)
  }

  changed() {
    for (const fn of this.listeners) fn()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    }, 200)
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

  /** Canvas metadata for the renderer, without the HTML. */
  canvasList() {
    return Object.values(this.data.canvases).map(({ html: _, ...meta }) => meta)
  }

  saveCanvas(c: { id?: string; projectId: string; taskId: string | null; sessionId: string | null; title: string; html: string }): Canvas {
    const prev = c.id ? this.data.canvases[c.id] : undefined
    if (c.id && !prev) throw new Error(`No canvas ${c.id}`)
    const canvas: Canvas = prev
      ? { ...prev, title: c.title || prev.title, html: c.html, version: prev.version + 1, updatedAt: Date.now() }
      : { id: id(), projectId: c.projectId, taskId: c.taskId, sessionId: c.sessionId, title: c.title, html: c.html, version: 1, updatedAt: Date.now() }
    this.data.canvases[canvas.id] = canvas
    this.changed()
    return canvas
  }

  createProject(name: string): Project {
    const p: Project = { id: id(), name, repos: [], notes: '', templates: {}, nextTaskNo: 1, baseBranch: 'main', enforceArchitecture: true, architecture: null, archRun: null, agents: {}, integrations: {}, createdAt: Date.now() }
    this.data.projects.push(p)
    this.changed()
    return p
  }

  /** Replaces the catalogue when a run reports any servers. */
  setIntegrations(list: Integration[]) {
    if (!list.length || JSON.stringify(list) === JSON.stringify(this.data.integrations)) return
    this.data.integrations = list
    this.changed()
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
      nextSubNo: 1,
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
