// Domain model shared by every mag app (PoC, desktop, web, backend).
// Keep it free of runtime dependencies.

export type TaskType = 'dev' | 'design' | 'spike' | 'research'

export type TaskStatus =
  | 'backlog'
  | 'grooming'
  | 'groomed'
  | 'planned'
  | 'in_progress'
  | 'in_review'
  | 'done'

export interface Project {
  id: string
  name: string
  /** Absolute paths of repositories attached to the project. */
  repos: string[]
  /** Free-form notes / links the agents should know about. */
  notes: string
  /** Markdown template per task type that agents follow when writing the task doc. */
  templates: Partial<Record<TaskType, string>>
  nextTaskNo: number
  /** Branch that worktrees start from and PRs target. */
  baseBranch: string
  /** Enforce the core/{lib,clients,services} layering in grooming, development and checks. */
  enforceArchitecture: boolean
  /** Architecture as an agent described it; rendered in the Architecture tab. */
  architecture: ArchDiagram | null
  /** State of the last architect run. */
  archRun: ArchRun | null
  /** Provider and model per agent role; missing roles use DEFAULT_CHOICE (see resolveChoice). */
  agents: Partial<Record<AgentRole, ModelChoice>>
  createdAt: number
}

export type ArchLayer = 'app' | 'service' | 'client' | 'lib'

export interface ArchNode {
  /** Stable id, unique within its app (kebab-case). */
  id: string
  name: string
  layer: ArchLayer
  /** Folder or file, relative to the repo. */
  path?: string
  /** One or two sentences: what it is responsible for. */
  description: string
  /** Public interface lines, e.g. "chargePlan(userId, plan): Charge  - charges and records the plan". */
  interface?: string[]
  /** Ids of nodes in the same app this one depends on. */
  uses: string[]
  /** Anything that breaks the layering or smells, in one line. */
  concern?: string
}

export interface ArchApp {
  name: string
  path?: string
  /** e.g. "Electron app", "React web", "HTTP API", "worker". */
  kind?: string
  nodes: ArchNode[]
}

export interface ArchDiagram {
  summary: string
  apps: ArchApp[]
  updatedAt: number
}

export interface ArchRun {
  status: 'running' | 'done' | 'error'
  startedAt: number
  /** Last thing the architect said or did, for the progress line. */
  note?: string
  costUsd?: number
}

/** Layering rules of the mag pattern. null = allowed. */
export function layerRule(from: ArchLayer, to: ArchLayer): { severity: 'error' | 'warning'; rule: string } | null {
  if (from === 'service' && to === 'service') return { severity: 'error', rule: 'Services must not use other services' }
  if (from === 'client' && (to === 'client' || to === 'service')) return { severity: 'error', rule: `Clients must not use ${to}s` }
  if (from === 'lib' && (to === 'client' || to === 'service')) return { severity: 'error', rule: `Lib must not use ${to}s` }
  if (from !== 'app' && to === 'app') return { severity: 'error', rule: 'Core layers must not depend on the app layer' }
  if (from === 'app' && to === 'client') return { severity: 'warning', rule: 'App layer uses a client directly; go through a service' }
  return null
}

/** Execution state of a task once a developer agent picks it up. */
export interface TaskWork {
  repo: string
  branch: string
  worktree: string
  prUrl: string | null
  /** PR feedback newer than this triggers a follow-up run. */
  feedbackSeenAt: number
  /** Last PR check problem, shown on the task; null when the last check worked. */
  checkError?: string | null
}

export interface Task {
  id: string
  projectId: string
  /** Human key: T-12 for tasks, T-12.3 for subtasks. Assigned at creation, never changes. */
  key: string
  parentId: string | null
  title: string
  type: TaskType
  status: TaskStatus
  /** What the user wrote. The agent-owned document lives separately. */
  description: string
  /** Order: top-level tasks by position in the plan, subtasks by position within the parent. */
  rank: number
  /** Set by an agent when it needs the user; one line shown in "Needs you". */
  needsInput: string | null
  work: TaskWork | null
  /** Number of the next subtask key (T-12.<n>). Only grows, so a deleted subtask's number is never reused. */
  nextSubNo: number
  createdAt: number
  updatedAt: number
}

/** chat = project-level conversation, not tied to a task. */
export type AgentRole = 'groomer' | 'developer' | 'reviewer' | 'chat' | 'architect'
export type AgentKind = 'claude-code' | 'codex'

/** Which provider runs a role and on which model. */
export interface ModelChoice {
  agent: AgentKind
  /** null = the provider's default model (no flag passed). */
  model: string | null
}

export interface AgentModel {
  id: string
  label: string
}

/** Catalogue entry for one provider. */
export interface AgentInfo {
  id: AgentKind
  displayName: string
  /** The provider's CLI was found on this machine. */
  detected: boolean
  models: AgentModel[]
}

/** Roles the user can configure; reviewer follows developer. */
export const SETTABLE_ROLES: AgentRole[] = ['chat', 'groomer', 'developer', 'architect']

export const DEFAULT_CHOICE: ModelChoice = { agent: 'claude-code', model: null }

export function resolveChoice(project: Pick<Project, 'agents'>, role: AgentRole): ModelChoice {
  const agents = project.agents ?? {}
  return agents[role] ?? (role === 'reviewer' ? agents.developer : undefined) ?? DEFAULT_CHOICE
}

export interface Attachment {
  name: string
  /** Absolute path of the app's copy. */
  path: string
  mime: string
}

/** Self-contained HTML an agent drew: mockup, diagram, comparison. Content is stored separately. */
export interface CanvasRef {
  id: string
  title: string
  version: number
}

export type ChatItem =
  | { kind: 'user'; text: string; attachments?: Attachment[]; at: number }
  | { kind: 'canvas'; canvas: CanvasRef; at: number }
  | { kind: 'assistant'; text: string; at: number }
  | { kind: 'tool'; id: string; name: string; summary: string; ok?: boolean; at: number }
  | { kind: 'result'; ok: boolean; costUsd?: number; at: number }
  | { kind: 'error'; text: string; at: number }
  /** Service line from mag itself, e.g. "context compacted". */
  | { kind: 'notice'; text: string; at: number }

export interface AgentSession {
  id: string
  projectId: string
  /** null for project chats. */
  taskId: string | null
  /** Project chats: short title from the first message. */
  title?: string
  role: AgentRole
  agent: AgentKind
  /** The agent's own session id, used to resume. */
  nativeSessionId: string | null
  /** Model the agent reported when its session started. */
  activeModel?: string
  /** Slash commands and skills the agent reported when its session last started, without the "/". */
  commands?: string[]
  status: 'running' | 'idle' | 'error'
  items: ChatItem[]
  createdAt: number
  /** When the current (or last) run started. */
  runStartedAt?: number
}

export type EventKind = 'status' | 'needs_input' | 'check_failed' | 'agent_started' | 'agent_failed' | 'architecture'

/** One line of the project's activity log. */
export interface ProjectEvent {
  id: string
  projectId: string
  taskId: string | null
  /** Copied in so the line still renders after the task is deleted. */
  taskKey: string | null
  kind: EventKind
  text: string
  at: number
}

export type NewEvent = Omit<ProjectEvent, 'id' | 'at'>

/** Normalized events every agent adapter emits. */
export type AgentEvent =
  | { type: 'session.started'; nativeSessionId: string; model?: string; commands?: string[] }
  | { type: 'message'; text: string }
  | { type: 'tool.call'; id: string; name: string; input: unknown }
  | { type: 'tool.result'; id: string; ok: boolean }
  | { type: 'turn.done'; ok: boolean; costUsd?: number; nativeSessionId?: string }
  | { type: 'context.compacted'; preTokens?: number }
  | { type: 'error'; message: string }
  | { type: 'raw'; payload: unknown }

/**
 * Slash commands offered in a chat's composer. A session that has not run yet borrows the list from the latest
 * session of the same project and agent; with none, only /compact. Codex gets none: its text goes as is.
 */
export function chatCommands(session: Pick<AgentSession, 'projectId' | 'agent' | 'commands'>, sessions: AgentSession[]): string[] {
  if (session.agent === 'codex') return []
  if (session.commands?.length) return session.commands
  const prev = sessions
    .filter((s) => s.projectId === session.projectId && s.agent === session.agent && s.commands?.length)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  return prev?.commands ?? ['compact']
}

export const PLAN_STATUSES: TaskStatus[] = ['planned', 'in_progress', 'in_review', 'done']
export const BACKLOG_STATUSES: TaskStatus[] = ['backlog', 'grooming', 'groomed']

/** A task key: T-12, or T-12.3 for a subtask. No boundaries; wrap it for the context. */
export const TASK_KEY_RE = /T-\d+(?:\.\d+)?/

export function subtaskKey(parentKey: string, n: number): string {
  return `${parentKey}.${n}`
}

/** Whole key mentions: not inside T-21, T-2.1, xT-2 or a path (worktrees/T-2); a trailing period ("see T-2.") is not part of the key. */
const KEY_MENTION = new RegExp(`(?<![\\w./-])${TASK_KEY_RE.source}(?![\\w-]|\\.\\d)`, 'g')

/** Replaces key mentions found in `map` (old key -> new key) in one pass. */
export function rewriteKeys(text: string, map: Record<string, string>): string {
  if (!Object.keys(map).length) return text
  return text.replace(KEY_MENTION, (k) => (Object.hasOwn(map, k) ? map[k] : k))
}

/** Subtasks of a task, in order. */
export function subtasksOf(id: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.parentId === id).sort((a, b) => a.rank - b.rank)
}

/** Why a task cannot enter the plan yet; empty array = it can. */
export function planBlockers(task: Task): string[] {
  const reasons: string[] = []
  if (task.parentId) reasons.push('subtasks are planned with their task')
  if (task.status !== 'groomed') reasons.push('not groomed yet')
  if (task.needsInput) reasons.push('agent is waiting for input')
  return reasons
}

/** Top-level tasks in the plan, in queue order. */
export function planQueue(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.parentId && PLAN_STATUSES.includes(t.status)).sort((a, b) => a.rank - b.rank)
}

/** Rank that puts a task at the end of the plan. */
export function nextPlanRank(tasks: Task[]): number {
  return Math.max(0, ...planQueue(tasks).map((t) => t.rank)) + 1
}

/** Work units in execution order: each plan task's subtasks, or the task itself when it has none. */
function workUnits(tasks: Task[]): Task[] {
  return planQueue(tasks).flatMap((t) => {
    const subs = subtasksOf(t.id, tasks)
    return subs.length ? subs : [t]
  })
}

/** The next unit a developer should start, or null. Execution is linear: one unit at a time, in plan order. */
export function nextWork(tasks: Task[]): Task | null {
  const units = workUnits(tasks)
  if (units.some((u) => u.status === 'in_progress' || u.status === 'in_review')) return null
  const next = units.find((u) => u.status !== 'done')
  return next && next.status === 'planned' && !next.needsInput ? next : null
}

/** Status of a task derived from its subtasks. */
export function rollupStatus(subs: Task[]): TaskStatus {
  if (subs.every((s) => s.status === 'done')) return 'done'
  if (subs.some((s) => s.status === 'in_review')) return 'in_review'
  if (subs.some((s) => s.status === 'in_progress' || s.status === 'done')) return 'in_progress'
  return 'planned'
}

/** A plan task that no developer has touched yet, nor any of its subtasks. */
function notStarted(task: Task, tasks: Task[]): boolean {
  return task.status === 'planned' && !task.work && subtasksOf(task.id, tasks).every((s) => s.status === 'planned' && !s.work)
}

/** Whether a plan task can swap places with its neighbour: both must be not started, so nothing jumps above started work. */
export function canMoveInPlan(task: Task, tasks: Task[], dir: 'up' | 'down'): boolean {
  const queue = planQueue(tasks)
  const i = queue.findIndex((t) => t.id === task.id)
  const other = i < 0 ? undefined : queue[dir === 'up' ? i - 1 : i + 1]
  return !!other && notStarted(task, tasks) && notStarted(other, tasks)
}

/** A subtask a developer has picked up: running, in review or done. */
export function subtaskStarted(sub: Task): boolean {
  return !!sub.work || sub.status === 'in_progress' || sub.status === 'in_review' || sub.status === 'done'
}

/** Whether a subtask can swap places with its neighbour: neither may be started, so nothing jumps above started work. */
export function canMoveSubtask(sub: Task, tasks: Task[], dir: 'up' | 'down'): boolean {
  if (!sub.parentId) return false
  const subs = subtasksOf(sub.parentId, tasks)
  const i = subs.findIndex((t) => t.id === sub.id)
  const other = i < 0 ? undefined : subs[dir === 'up' ? i - 1 : i + 1]
  return !!other && !subtaskStarted(sub) && !subtaskStarted(other)
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  grooming: 'Grooming',
  groomed: 'Groomed',
  planned: 'Planned',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
}

/** Events a task update produces: status, input request and PR check failure. */
export function taskChangeEvents(prev: Task, next: Task): NewEvent[] {
  const base = { projectId: next.projectId, taskId: next.id, taskKey: next.key }
  const events: NewEvent[] = []
  if (prev.status !== next.status) {
    const pr = !!next.work?.prUrl
    const text =
      next.status === 'in_review' && pr ? 'PR opened' : next.status === 'done' && pr ? 'merged' : STATUS_LABELS[next.status]
    events.push({ ...base, kind: 'status', text })
  }
  if (next.needsInput && next.needsInput !== prev.needsInput) events.push({ ...base, kind: 'needs_input', text: next.needsInput })
  const checkError = next.work?.checkError
  if (checkError && checkError !== prev.work?.checkError) events.push({ ...base, kind: 'check_failed', text: checkError })
  return events
}

export type InboxKind = 'agent_failed' | 'check_failed' | 'question' | 'ready_to_merge' | 'groomed'

export interface InboxItem {
  task: Task
  kind: InboxKind
  text: string
}

const INBOX_ORDER: InboxKind[] = ['agent_failed', 'check_failed', 'question', 'ready_to_merge', 'groomed']

function inboxItem(task: Task, sessions: AgentSession[]): InboxItem | null {
  const last = sessions.filter((s) => s.taskId === task.id && (s.role === 'groomer' || s.role === 'developer')).at(-1)
  if (last?.status === 'error') return { task, kind: 'agent_failed', text: `${last.role === 'groomer' ? 'Groomer' : 'Developer'} failed` }
  if (task.work?.checkError) return { task, kind: 'check_failed', text: task.work.checkError }
  if (task.needsInput) return { task, kind: 'question', text: task.needsInput }
  if (task.status === 'in_review' && task.work?.prUrl) return { task, kind: 'ready_to_merge', text: 'PR is ready to merge' }
  if (!task.parentId && task.status === 'groomed') return { task, kind: 'groomed', text: 'Groomed, ready to add to the plan' }
  return null
}

/** What waits on the user: at most one item per task, most urgent kind first. Sessions are in creation order. */
export function inbox(tasks: Task[], sessions: AgentSession[]): InboxItem[] {
  return tasks
    .map((t) => inboxItem(t, sessions))
    .filter((i): i is InboxItem => !!i)
    .sort((a, b) => INBOX_ORDER.indexOf(a.kind) - INBOX_ORDER.indexOf(b.kind))
}

export type PipelineStage = Exclude<TaskStatus, 'done'> | 'done7d'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Top-level task counts per status; done only counts tasks finished in the last 7 days. */
export function pipelineCounts(tasks: Task[], now: number): Record<PipelineStage, number> {
  const counts: Record<PipelineStage, number> = { backlog: 0, grooming: 0, groomed: 0, planned: 0, in_progress: 0, in_review: 0, done7d: 0 }
  for (const t of tasks) {
    if (t.parentId) continue
    if (t.status !== 'done') counts[t.status]++
    else if (t.updatedAt >= now - WEEK_MS) counts.done7d++
  }
  return counts
}

/** The unit being worked on and the one after it, in nextWork order. */
export function queueHead(tasks: Task[]): { current: Task | null; next: Task | null } {
  const units = workUnits(tasks)
  const i = units.findIndex((u) => u.status === 'in_progress' || u.status === 'in_review')
  const current = i < 0 ? null : units[i]
  const next = units.slice(i + 1).find((u) => u.status !== 'done') ?? null
  return { current, next }
}

export const DEFAULT_TEMPLATES: Record<TaskType, string> = {
  dev: `# Problem
One or two sentences.

# Open questions
Only if any.

# Changes
## Infra
Only if runtimes, databases, queues or external services change.
## Models
## Clients
New or changed clients and their interfaces (in our terms).
## Services
New or changed service interfaces: method signatures and semantics. This is the core of the design.
## App layer
Hooks, components, pages, handlers, workers that change.

# Architecture
Mermaid diagram at the level where the change happens (infra, or app: services and clients).

# Plan
Short numbered steps.

# Assumptions
`,
  design: `# Problem

# Open questions

# Scope
Screens and states.

# Approach
`,
  spike: `# Question to answer

# Open questions

# Approach

# Findings
`,
  research: `# Question to answer

# Open questions

# Sources

# Findings
`,
}

export interface Canvas {
  id: string
  projectId: string
  taskId: string | null
  sessionId: string | null
  title: string
  html: string
  version: number
  updatedAt: number
}
