import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSession, Canvas, Project, Task } from '@mag/core'
import type { NewTask } from '../preload/api'

interface Data {
  projects: Project[]
  tasks: Task[]
  sessions: AgentSession[]
  docs: Record<string, string>
  /** Agent-drawn HTML; not sent to the renderer with the state (see canvasList). */
  canvases: Record<string, Canvas>
}

const id = () => randomUUID().slice(0, 8)

/** PoC persistence: one JSON file, rewritten on change. */
export class Store {
  data: Data = { projects: [], tasks: [], sessions: [], docs: {}, canvases: {} }
  private listeners: (() => void)[] = []
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private file: string) {
    if (existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) }
    // Runs don't survive a restart.
    for (const s of this.data.sessions) if (s.status === 'running') s.status = 'idle'
    // Defaults for data written by older PoC versions.
    for (const p of this.data.projects) {
      p.devPoolSize ??= 1
      p.baseBranch ??= 'main'
      p.enforceArchitecture ??= false
      p.architecture ??= null
      p.archRun ??= null
      if (p.archRun?.status === 'running') p.archRun.status = 'error'
    }
    for (const t of this.data.tasks) t.work ??= null
    for (const s of this.data.sessions)
      s.projectId ??= this.data.tasks.find((t) => t.id === s.taskId)?.projectId ?? ''
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
    const p: Project = { id: id(), name, repos: [], notes: '', templates: {}, nextTaskNo: 1, devPoolSize: 1, baseBranch: 'main', enforceArchitecture: true, architecture: null, archRun: null, createdAt: Date.now() }
    this.data.projects.push(p)
    this.changed()
    return p
  }

  updateProject(pid: string, patch: Partial<Project>) {
    Object.assign(this.project(pid), patch, { id: pid })
    this.changed()
  }

  createTask(n: NewTask): Task {
    const p = this.project(n.projectId)
    const now = Date.now()
    const t: Task = {
      id: id(),
      projectId: p.id,
      key: `T-${p.nextTaskNo++}`,
      parentId: n.parentId ?? null,
      title: n.title,
      type: n.type,
      status: 'backlog',
      description: n.description,
      dependsOn: null,
      needsInput: null,
      work: null,
      createdAt: now,
      updatedAt: now,
    }
    this.data.tasks.push(t)
    this.changed()
    return t
  }

  updateTask(tid: string, patch: Partial<Task>) {
    Object.assign(this.task(tid), patch, { id: tid, updatedAt: Date.now() })
    this.changed()
  }

  createSession(s: Omit<AgentSession, 'id' | 'createdAt' | 'items' | 'nativeSessionId'>): AgentSession {
    const full: AgentSession = { ...s, id: id(), createdAt: Date.now(), items: [], nativeSessionId: null }
    this.data.sessions.push(full)
    this.changed()
    return full
  }
}
