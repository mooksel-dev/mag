// Domain model shared by every mag app (PoC, desktop, web, backend).
// Keep it free of runtime dependencies.

export type TaskType = 'dev' | 'design' | 'spike' | 'research'

/**
 * backlog → grooming → todo (ready to work) → in_progress → done; canceled from any status before done. An open PR is a
 * badge on an in_progress task, not a status. Subtasks use SubtaskStatus.
 */
export type TaskStatus = 'backlog' | 'grooming' | 'todo' | 'in_progress' | 'done' | 'canceled'

/** A plan step: a live view of the developer's progress. At most one per task is in_progress. */
export type SubtaskStatus = 'todo' | 'in_progress' | 'done'

export const SUBTASK_STATUSES: SubtaskStatus[] = ['todo', 'in_progress', 'done']

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
  /** Mode per role and integration id; missing = off (see integrationMode). */
  integrations: Partial<Record<AgentRole, Record<string, IntegrationMode>>>
  /** Hex color from PROJECT_COLORS; missing or null = picked from the id (see projectColor). */
  color?: string | null
  /** Done and canceled tasks are archived this many days after they finished; 0 = never. Missing = DEFAULT_AUTO_ARCHIVE_DAYS. */
  autoArchiveDays?: number
  createdAt: number
}

export const DEFAULT_AUTO_ARCHIVE_DAYS = 14

/** Project colors, readable on light and dark backgrounds. */
export const PROJECT_COLORS: string[] = ['#e5484d', '#f76b15', '#d6a000', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#7d7d86']

/** The project's color: its own, or a stable one from PROJECT_COLORS by a hash of its id. */
export function projectColor(p: Pick<Project, 'id' | 'color'>): string {
  if (p.color) return p.color
  let h = 0
  for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PROJECT_COLORS[h % PROJECT_COLORS.length]
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

export type PrState = 'open' | 'merged' | 'closed'

/** One project repository in a task's workspace: its worktree, branch and PR. */
export interface RepoWork {
  /** The project repository (main checkout). */
  repo: string
  branch: string
  worktree: string
  prUrl: string | null
  /** null until the PR has been recorded or checked. */
  prState: PrState | null
  /** Last PR check problem, shown on the task; null when the last check worked. */
  checkError?: string | null
}

/** Execution state of a task once a developer agent picks it up. */
export interface TaskWork {
  /** One worktree per project repository, side by side in `dir`. */
  repos: RepoWork[]
  /** Task directory: the developer's cwd. */
  dir: string
  /** PR feedback newer than this triggers a follow-up run. */
  feedbackSeenAt: number
}

/** Last path segment. */
const baseName = (path: string) => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path

/** Worktree folder name per repository: its base name, made unique within the task ("app", "app-2"). */
export function repoDirNames(repos: string[]): string[] {
  const used = new Set<string>()
  return repos.map((r) => {
    const base = baseName(r)
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`
    used.add(name)
    return name
  })
}

/** Short name of a repo in a task: its worktree folder, or the repository's own name for a pre-T-22 single worktree. */
export function repoWorkName(work: TaskWork, r: RepoWork): string {
  return baseName(r.worktree === work.dir ? r.repo : r.worktree)
}

/** The repo work a developer means by `ref`: its short name (see repoWorkName), the repository path or the worktree path. */
export function findRepoWork(work: TaskWork, ref: string): RepoWork | undefined {
  const r = ref.trim().replace(/[/\\]+$/, '')
  return work.repos.find((w) => w.repo === r || w.worktree === r || repoWorkName(work, w) === r)
}

/** Repos of a task that have a PR recorded. */
export function taskPrs(task: Pick<Task, 'work'>): RepoWork[] {
  return task.work?.repos.filter((r) => r.prUrl) ?? []
}

/** The first PR check problem of a task, if any. */
export function workCheckError(work: TaskWork | null): string | null {
  return work?.repos.find((r) => r.checkError)?.checkError ?? null
}

/**
 * What a task's PRs say about it, or null when they don't decide it. `changed` = repos (by RepoWork.repo) with commits
 * of their own. Every PR merged → done; a PR closed without merge → closed; every changed repo with a live PR →
 * review (the user merges).
 */
export function prRollup(work: TaskWork, changed: string[]): 'done' | 'review' | 'closed' | null {
  const prs = work.repos.filter((r) => r.prUrl)
  if (!prs.length) return null
  if (prs.some((r) => r.prState === 'closed')) return 'closed'
  if (prs.every((r) => r.prState === 'merged')) return 'done'
  const live = new Set(prs.map((r) => r.repo))
  return changed.every((c) => live.has(c)) ? 'review' : null
}

/** PRs of a task that are open: the "PR open" badge. */
export function openPrs(task: Pick<Task, 'work'>): RepoWork[] {
  return taskPrs(task).filter((r) => r.prState === 'open')
}

export interface Task {
  id: string
  projectId: string
  /** Human key: T-12 for tasks, T-12.3 for subtasks. Assigned at creation, never changes. */
  key: string
  parentId: string | null
  title: string
  type: TaskType
  /** Subtasks: one of SubtaskStatus. */
  status: TaskStatus
  /** What the user wrote. The agent-owned document lives separately. Subtasks: the optional one-line note. */
  description: string
  /** Order: top-level tasks by position in the plan, subtasks by position within the parent. */
  rank: number
  /** Set by an agent when it needs the user; one line shown in "Needs you". */
  needsInput: string | null
  /** Top-level tasks only; subtasks are plan steps without work of their own. */
  work: TaskWork | null
  /** Number of the next subtask key (T-12.<n>). Only grows, so a deleted subtask's number is never reused. */
  nextSubNo: number
  /** Set when a done or canceled task is archived; a flag, the status stays. */
  archivedAt: number | null
  /** Why the user canceled the task, if they said. */
  cancelReason?: string | null
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

/** off = hidden from the agent, ask = each call waits for the user, auto = allowed. */
export type IntegrationMode = 'off' | 'ask' | 'auto'

/** An MCP server the agent CLI brings along (e.g. a claude.ai connector). */
export interface Integration {
  /** Tool prefix as the CLI sees it: tools are mcp__<id>__<tool>. */
  id: string
  /** Server name the CLI reported, e.g. "claude.ai Cloudflare Developer Platform". */
  name: string
}

/** mag's own MCP server; always allowed, never an integration. */
export const MAG_MCP_ID = 'mag'

export function integrationMode(project: Pick<Project, 'integrations'>, role: AgentRole, id: string): IntegrationMode {
  const all = project.integrations ?? {}
  return (all[role] ?? (role === 'reviewer' ? all.developer : undefined))?.[id] ?? 'off'
}

/** CLI permission rules for the known integrations: server-level `mcp__<id>` per mode. */
export function integrationRules(
  project: Pick<Project, 'integrations'>,
  role: AgentRole,
  known: Integration[],
): { allowed: string[]; disallowed: string[]; ask: string[] } {
  const rules = { allowed: [] as string[], disallowed: [] as string[], ask: [] as string[] }
  for (const i of known) {
    if (i.id === MAG_MCP_ID) continue
    const mode = integrationMode(project, role, i.id)
    rules[mode === 'auto' ? 'allowed' : mode === 'ask' ? 'ask' : 'disallowed'].push(`mcp__${i.id}`)
  }
  return rules
}

/** The integration a tool name (mcp__<id>__<tool>) belongs to, with the bare tool name. */
export function integrationOf(toolName: string, known: Integration[]): { integration: Integration; tool: string } | null {
  // Longest id first, so "a_b" wins over "a" for mcp__a_b__x.
  const sorted = [...known].sort((a, b) => b.id.length - a.id.length)
  const integration = sorted.find((i) => toolName.startsWith(`mcp__${i.id}__`))
  return integration ? { integration, tool: toolName.slice(`mcp__${integration.id}__`.length) } : null
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
  /** An integration call in ask mode waiting for (or answered by) the user. id = the CLI's tool_use_id. */
  | { kind: 'approval'; id: string; tool: string; server: string; input: unknown; status: ApprovalStatus; at: number }

/** expired = the run ended before the user answered. */
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired'

export interface AgentSession {
  id: string
  projectId: string
  /** null for project chats. */
  taskId: string | null
  /** Project chats: the first message until a title is generated after the first turn. */
  title?: string
  /** A title generation has run for this chat (whatever its outcome); it runs once. */
  titleGenerated?: boolean
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

export type EventKind = 'status' | 'needs_input' | 'check_failed' | 'agent_started' | 'agent_failed' | 'architecture' | 'approval'

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
  | { type: 'session.started'; nativeSessionId: string; model?: string; commands?: string[]; integrations?: Integration[] }
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

/** Prompt for a one-off, tool-less run that names a chat from its first exchange. */
export function titlePrompt(firstMessage: string, reply: string): string {
  const excerpt = `User: ${firstMessage}\n\nAssistant: ${reply}`.slice(0, 2000)
  return `Name this conversation in 3-6 words, in the user's language. Reply with the title only: no quotes, no trailing period.\n\n<conversation>\n${excerpt}\n</conversation>`
}

/** The title from a title run's reply, or null if it doesn't look like one. */
export function cleanTitle(raw: string): string | null {
  const line = raw.trim().split('\n')[0] ?? ''
  const title = line
    .replace(/^(title|назва)\s*:\s*/i, '')
    .replace(/^[\s"'«»“”*#`]+|[\s"'«»“”*`.]+$/g, '')
    .replace(/\s+/g, ' ')
  return title && title.length <= 80 ? title : null
}

/** "opus · $0.48 · 38s" under a turn's last reply; missing parts are left out. */
export function turnMeta(items: ChatItem[], resultIndex: number, model?: string): string {
  const result = items[resultIndex]
  if (result?.kind !== 'result') return ''
  let start: number | undefined
  for (let n = resultIndex - 1; n >= 0 && start === undefined; n--) {
    const i = items[n]
    if (i.kind === 'result') break
    if (i.kind === 'user') start = i.at
  }
  const secs = start === undefined ? undefined : Math.max(0, Math.round((result.at - start) / 1000))
  const time = secs === undefined ? null : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  return [model, result.costUsd != null ? `$${result.costUsd.toFixed(2)}` : null, time].filter(Boolean).join(' · ')
}

/** Top-level statuses of the plan: ready (todo) and started (in progress) work, in rank order. */
export const QUEUE_STATUSES: TaskStatus[] = ['todo', 'in_progress']
/** Finished statuses: only these can be archived. */
export const FINISHED_STATUSES: TaskStatus[] = ['done', 'canceled']

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

/** Top-level todo and in-progress tasks, in rank order. */
export function planQueue(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.parentId && QUEUE_STATUSES.includes(t.status)).sort((a, b) => a.rank - b.rank)
}

/**
 * Top-level todo tasks: ready to work, in priority order (by rank). Nothing starts them on its own; the user does, and
 * any number of tasks can be in progress at once.
 */
export function todoTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.parentId && t.status === 'todo').sort((a, b) => a.rank - b.rank)
}

/** Rank that puts a task at the end of the todo list: the lowest priority. */
export function nextPlanRank(tasks: Task[]): number {
  return Math.max(0, ...planQueue(tasks).map((t) => t.rank)) + 1
}

/** Done and total subtasks of a task: the progress of its plan. */
export function subtaskProgress(id: string, tasks: Task[]): { done: number; total: number } {
  const subs = subtasksOf(id, tasks)
  return { done: subs.filter((s) => s.status === 'done').length, total: subs.length }
}

/**
 * Status changes that set `sub` to `status`: only one step of a task is in progress at a time, so starting one sends
 * the task's other in-progress step back to todo.
 */
export function subtaskStatusChanges(sub: Task, status: SubtaskStatus, tasks: Task[]): { id: string; status: SubtaskStatus }[] {
  const others = sub.parentId && status === 'in_progress'
    ? subtasksOf(sub.parentId, tasks).filter((s) => s.id !== sub.id && s.status === 'in_progress')
    : []
  return [...others.map((s) => ({ id: s.id, status: 'todo' as const })), { id: sub.id, status }]
}

/** Whether a todo task can swap priority with its todo neighbour; both must be not started. In-progress tasks don't count. */
export function canMoveInPlan(task: Task, tasks: Task[], dir: 'up' | 'down'): boolean {
  const todo = todoTasks(tasks)
  const i = todo.findIndex((t) => t.id === task.id)
  const other = i < 0 ? undefined : todo[dir === 'up' ? i - 1 : i + 1]
  const notStarted = (t: Task) => t.status === 'todo' && !t.work
  return !!other && notStarted(task) && notStarted(other)
}

/** Whether a subtask can swap places with its neighbour. The checklist is a plan: any step can move. */
export function canMoveSubtask(sub: Task, tasks: Task[], dir: 'up' | 'down'): boolean {
  if (!sub.parentId) return false
  const subs = subtasksOf(sub.parentId, tasks)
  const i = subs.findIndex((t) => t.id === sub.id)
  return i >= 0 && !!subs[dir === 'up' ? i - 1 : i + 1]
}

/** A top-level task that is not done or canceled yet can be canceled. */
export function canCancel(task: Task): boolean {
  return !task.parentId && !FINISHED_STATUSES.includes(task.status)
}

/** Only done and canceled tasks can be archived. */
export function canArchive(task: Task): boolean {
  return !task.parentId && !task.archivedAt && FINISHED_STATUSES.includes(task.status)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Finished, unarchived tasks that finished at least `days` days ago (by updatedAt); none when days is 0. */
export function autoArchiveDue(tasks: Task[], days: number, now: number): Task[] {
  if (!(days > 0)) return []
  return tasks.filter((t) => canArchive(t) && t.updatedAt <= now - days * DAY_MS)
}

/** The Tasks tab views. */
export type TasksView = 'active' | 'backlog' | 'archive'

/** Which view of the Tasks tab a top-level task is in. */
export function taskView(task: Task): TasksView {
  if (task.archivedAt) return 'archive'
  return task.status === 'backlog' ? 'backlog' : 'active'
}

/** Sections of the Active view, each in display order. */
export interface ActiveSections {
  inProgress: Task[]
  /** Ready to start, in priority order. */
  todo: Task[]
  grooming: Task[]
  /** Done and canceled, not archived, newest first. */
  finished: Task[]
}

export function activeSections(tasks: Task[]): ActiveSections {
  const active = tasks.filter((t) => !t.parentId && taskView(t) === 'active')
  return {
    inProgress: planQueue(active).filter((t) => t.status === 'in_progress'),
    todo: todoTasks(active),
    grooming: active.filter((t) => t.status === 'grooming').sort((a, b) => a.createdAt - b.createdAt),
    finished: active.filter((t) => FINISHED_STATUSES.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt),
  }
}

/** Backlog view: raw ideas, oldest first. */
export function backlogTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.parentId && taskView(t) === 'backlog').sort((a, b) => a.createdAt - b.createdAt)
}

export type ArchiveFilter = 'all' | 'done' | 'canceled'

/** Archive view: archived tasks matching the filter and a key or title search, most recently archived first. */
export function archivedTasks(tasks: Task[], filter: ArchiveFilter = 'all', query = ''): Task[] {
  const q = query.trim().toLowerCase()
  return tasks
    .filter((t) => !t.parentId && t.archivedAt && (filter === 'all' || t.status === filter))
    .filter((t) => !q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
    .sort((a, b) => b.archivedAt! - a.archivedAt!)
}

/** Top-level task count per Tasks view. */
export function viewCounts(tasks: Task[]): Record<TasksView, number> {
  const counts: Record<TasksView, number> = { active: 0, backlog: 0, archive: 0 }
  for (const t of tasks) if (!t.parentId) counts[taskView(t)]++
  return counts
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  grooming: 'Grooming',
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
  canceled: 'Canceled',
}

/** Events a task update produces: status, PR opened, input request and PR check failure. */
export function taskChangeEvents(prev: Task, next: Task): NewEvent[] {
  const base = { projectId: next.projectId, taskId: next.id, taskKey: next.key }
  const events: NewEvent[] = []
  // A subtask's status is plan progress, not activity.
  if (prev.status !== next.status && !next.parentId) {
    const text =
      next.status === 'done' && taskPrs(next).length ? 'merged'
      : next.status === 'canceled' && next.cancelReason ? `Canceled: ${next.cancelReason}`
      : STATUS_LABELS[next.status]
    events.push({ ...base, kind: 'status', text })
  }
  const before = new Set(taskPrs(prev).map((r) => r.prUrl))
  for (const r of openPrs(next)) if (!before.has(r.prUrl)) events.push({ ...base, kind: 'status', text: 'PR opened' })
  if (next.needsInput && next.needsInput !== prev.needsInput) events.push({ ...base, kind: 'needs_input', text: next.needsInput })
  const checkError = workCheckError(next.work)
  if (checkError && checkError !== workCheckError(prev.work)) events.push({ ...base, kind: 'check_failed', text: checkError })
  return events
}

/** The agent indicator of a task: green while an agent runs, yellow while something waits on the user. */
export type AgentState =
  | { kind: 'working'; role: AgentRole; since: number }
  | { kind: 'waiting'; reason: string }
  | null

/**
 * What the task's agent is doing. Waiting wins over working: a pending approval or a question blocks the agent. A
 * task in progress whose PRs are open and with no agent running waits for the user to merge.
 */
export function agentState(task: Task, sessions: AgentSession[]): AgentState {
  const mine = sessions.filter((s) => s.taskId === task.id)
  const approval = mine.flatMap((s) => s.items).find((i) => i.kind === 'approval' && i.status === 'pending')
  if (approval?.kind === 'approval') return { kind: 'waiting', reason: `Approval: ${approval.server} · ${approval.tool}` }
  if (task.needsInput) return { kind: 'waiting', reason: task.needsInput }
  const running = mine.filter((s) => s.status === 'running').at(-1)
  if (running) return { kind: 'working', role: running.role, since: running.runStartedAt ?? running.createdAt }
  const prs = openPrs(task)
  if (task.status === 'in_progress' && prs.length) return { kind: 'waiting', reason: prs.length > 1 ? `${prs.length} PRs wait for merge` : 'PR waits for merge' }
  return null
}

export type InboxKind = 'approval' | 'agent_failed' | 'check_failed' | 'question' | 'ready_to_merge'

export interface InboxItem {
  /** null for an approval in a project chat. */
  task: Task | null
  kind: InboxKind
  text: string
  /** Session the item comes from: the approval's session, or the task's latest groomer/developer one. */
  session?: AgentSession
  /** Approval chat item id in `session`. */
  approvalId?: string
}

const INBOX_ORDER: InboxKind[] = ['approval', 'agent_failed', 'check_failed', 'question', 'ready_to_merge']

function inboxItem(task: Task, sessions: AgentSession[]): InboxItem | null {
  if (task.archivedAt || task.status === 'canceled') return null
  const last = sessions.filter((s) => s.taskId === task.id && (s.role === 'groomer' || s.role === 'developer')).at(-1)
  const base = { task, session: last }
  if (last?.status === 'error') return { ...base, kind: 'agent_failed', text: `${last.role === 'groomer' ? 'Groomer' : 'Developer'} failed` }
  const checkError = workCheckError(task.work)
  if (checkError) return { ...base, kind: 'check_failed', text: checkError }
  if (task.needsInput) return { ...base, kind: 'question', text: task.needsInput }
  const prs = openPrs(task)
  if (task.status === 'in_progress' && prs.length && last?.status !== 'running')
    return { ...base, kind: 'ready_to_merge', text: prs.length > 1 ? `${prs.length} PRs are ready to merge` : 'PR is ready to merge' }
  return null
}

/** One item per pending approval in the project's sessions, task sessions and chats alike. */
function approvalItems(projectId: string, tasks: Task[], sessions: AgentSession[]): InboxItem[] {
  return sessions
    .filter((s) => s.projectId === projectId)
    .flatMap((s) =>
      s.items.flatMap((i): InboxItem[] =>
        i.kind === 'approval' && i.status === 'pending'
          ? [{ task: tasks.find((t) => t.id === s.taskId) ?? null, kind: 'approval', text: `wants ${i.server} · ${i.tool}`, session: s, approvalId: i.id }]
          : [],
      ),
    )
}

/**
 * What waits on the user in a project, most urgent kind first: every pending approval, plus at most one item per
 * task. `tasks` are the project's; sessions may span projects and are in creation order.
 */
export function inbox(projectId: string, tasks: Task[], sessions: AgentSession[]): InboxItem[] {
  return [
    ...approvalItems(projectId, tasks, sessions),
    ...tasks.map((t) => inboxItem(t, sessions)).filter((i): i is InboxItem => !!i),
  ].sort((a, b) => INBOX_ORDER.indexOf(a.kind) - INBOX_ORDER.indexOf(b.kind))
}

export type ProjectState = 'waiting' | 'in_review' | 'idle'

/** Waiting if something in the project's inbox waits on the user, else in review if a task has an open PR, else idle. */
export function projectState(projectId: string, tasks: Task[], sessions: AgentSession[]): ProjectState {
  const mine = tasks.filter((t) => t.projectId === projectId)
  if (inbox(projectId, mine, sessions).length) return 'waiting'
  if (mine.some((t) => !t.parentId && t.status === 'in_progress' && openPrs(t).length)) return 'in_review'
  return 'idle'
}

/** Inbox items across all projects: the dock badge. */
export function waitingTotal(projects: Pick<Project, 'id'>[], tasks: Task[], sessions: AgentSession[]): number {
  return projects.reduce((n, p) => n + inbox(p.id, tasks.filter((t) => t.projectId === p.id), sessions).length, 0)
}

export type PipelineStage = 'backlog' | 'grooming' | 'todo' | 'in_progress' | 'done7d'

const WEEK_MS = 7 * DAY_MS

/** Top-level task counts per status; done only counts tasks finished in the last 7 days; canceled is not counted. */
export function pipelineCounts(tasks: Task[], now: number): Record<PipelineStage, number> {
  const counts: Record<PipelineStage, number> = { backlog: 0, grooming: 0, todo: 0, in_progress: 0, done7d: 0 }
  for (const t of tasks) {
    if (t.parentId || t.status === 'canceled') continue
    if (t.status !== 'done') counts[t.status]++
    else if (t.updatedAt >= now - WEEK_MS) counts.done7d++
  }
  return counts
}

/** Agent sessions running now, any role, any project: no limit on how many. */
export function runningAgents(sessions: AgentSession[]): AgentSession[] {
  return sessions.filter((s) => s.status === 'running')
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
