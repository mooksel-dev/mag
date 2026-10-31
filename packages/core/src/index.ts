// Domain model shared by every mag app (PoC, desktop, web, backend).
// Keep it free of runtime dependencies.

import type { ArchDiagram } from './arch.ts'

export * from './arch.ts'

export type TaskType = 'dev' | 'design' | 'spike' | 'research'

/**
 * backlog → grooming → todo (ready to work) → in_progress → done; canceled from any status before done. An open PR is a
 * badge on an in_progress task, not a status. Subtasks use SubtaskStatus.
 */
export type TaskStatus = 'backlog' | 'grooming' | 'todo' | 'in_progress' | 'done' | 'canceled'

/**
 * A step of a task: its own developer session, branch and PR (T-28). Steps run in order, one at a time; the status
 * follows the step's lifecycle. Legacy tasks (see isLegacy) keep their subtasks as a checklist.
 */
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
  /** Tracker projects / teams tickets are imported from (T-10). Missing = none. */
  trackers?: TrackerScope[]
  createdAt: number
}

export const DEFAULT_AUTO_ARCHIVE_DAYS = 14

export type TrackerKind = 'jira' | 'linear'

/** A tracker project (Jira) or team (Linear) mag imports tickets from, read through a T-13 integration. */
export interface TrackerScope {
  /** The integration (Integration.id) the tracker agent reads through. */
  integrationId: string
  kind: TrackerKind
  /** Jira project key or Linear team key, e.g. "ABC": the prefix of its ticket keys. */
  scope: string
}

/** The ticket a top-level task was imported from. Read-only context: mag never writes to the tracker. */
export interface TrackerLink {
  integrationId: string
  kind: TrackerKind
  /** Ticket key, e.g. "ABC-12". */
  key: string
  /** null when imported by bare key until the tracker agent reports the link. */
  url: string | null
  /** When the tracker agent wrote the brief; null while the import runs or after it failed. */
  importedAt: number | null
}

const TICKET_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

/** The scope of a ticket key: the first one of `kind` (any kind if omitted) whose key is the ticket's prefix. */
function scopeOf(key: string, scopes: TrackerScope[], kind?: TrackerKind): TrackerScope | undefined {
  const prefix = key.slice(0, key.lastIndexOf('-')).toUpperCase()
  return scopes.find((s) => (!kind || s.kind === kind) && s.scope.trim().toUpperCase() === prefix)
}

/**
 * The ticket a pasted link or key names, within the project's tracker scopes: a Jira URL (…/browse/ABC-12 or
 * ?selectedIssue=ABC-12), a Linear URL (linear.app/<ws>/issue/ENG-12/…) or a bare key whose prefix is a scope.
 * The url is canonical; null for a bare key. null when nothing matches a scope.
 */
export function parseTrackerRef(text: string, scopes: TrackerScope[]): { scope: TrackerScope; key: string; url: string | null } | null {
  const ref = text.trim()
  if (TICKET_KEY.test(ref)) {
    const key = ref.toUpperCase()
    const scope = scopeOf(key, scopes)
    return scope ? { scope, key, url: null } : null
  }
  // Core has no URL global: origin, path and query by hand.
  const url = /^(https?:\/\/[^/?#\s]+)(\/[^?#\s]*)?(\?[^#\s]*)?(#\S*)?$/i.exec(ref)
  if (!url) return null
  const [, origin, path = '', query = ''] = url
  const found = (kind: TrackerKind, raw: string | undefined, link: (key: string) => string) => {
    if (!raw || !TICKET_KEY.test(raw)) return null
    const key = raw.toUpperCase()
    const scope = scopeOf(key, scopes, kind)
    return scope ? { scope, key, url: link(key) } : null
  }
  if (/^https?:\/\/linear\.app$/i.test(origin)) {
    const m = /^\/([^/]+)\/issue\/([^/]+)/.exec(path)
    return found('linear', m?.[2], (key) => `https://linear.app/${m![1]}/issue/${key}`)
  }
  const raw = /\/browse\/([^/]+)/.exec(path)?.[1] ?? /[?&]selectedIssue=([^&]+)/.exec(query)?.[1]
  return found('jira', raw, (key) => `${origin}/browse/${key}`)
}

/** The project's top-level task already linked to this ticket, if any. */
export function linkedTask(tasks: Task[], key: string): Task | null {
  const k = key.trim().toUpperCase()
  return tasks.find((t) => !t.parentId && t.tracker?.key.toUpperCase() === k) ?? null
}

/** Project colors, readable on light and dark backgrounds. */
export const PROJECT_COLORS: string[] = ['#e5484d', '#f76b15', '#d6a000', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#7d7d86']

/** The project's color: its own, or a stable one from PROJECT_COLORS by a hash of its id. */
export function projectColor(p: Pick<Project, 'id' | 'color'>): string {
  if (p.color) return p.color
  let h = 0
  for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PROJECT_COLORS[h % PROJECT_COLORS.length]
}

export interface ArchRun {
  status: 'running' | 'done' | 'error'
  startedAt: number
  /** Last thing the architect said or did, for the progress line. */
  note?: string
  costUsd?: number
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

/** Repos of a task that have a PR recorded: its own (legacy) and, with `tasks`, those of its steps in order. */
export function taskPrs(task: Pick<Task, 'id' | 'work'>, tasks: Task[] = []): RepoWork[] {
  return [task, ...subtasksOf(task.id, tasks)].flatMap((t) => t.work?.repos.filter((r) => r.prUrl) ?? [])
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

/** PRs of a task that are open: the "PR open" badge. With `tasks`, its steps' PRs count too. */
export function openPrs(task: Pick<Task, 'id' | 'work'>, tasks: Task[] = []): RepoWork[] {
  return taskPrs(task, tasks).filter((r) => r.prState === 'open')
}

/** A task started before T-28: it has work of its own and finishes the old way, its subtasks a checklist. */
export function isLegacy(task: Pick<Task, 'parentId' | 'work'>): boolean {
  return !task.parentId && !!task.work
}

/** The step a task is on: its first step that is not done. null when every step is done or it has none. */
export function currentStep(taskId: string, tasks: Task[]): Task | null {
  return subtasksOf(taskId, tasks).find((s) => s.status !== 'done') ?? null
}

/** Whether a task can go to todo: it needs at least one step. */
export function canMoveToTodo(task: Task, tasks: Task[]): { ok: boolean; reason?: string } {
  if (task.parentId) return { ok: false, reason: 'A step has no status of its own' }
  return subtasksOf(task.id, tasks).length ? { ok: true } : { ok: false, reason: 'Add at least one step' }
}

/** Branch of a step: T-41.3 → mag/t-41-3. */
export function stepBranch(stepKey: string): string {
  return `mag/${stepKey.toLowerCase().replace(/\./g, '-')}`
}

/** Directory of a step's worktrees: <worktrees>/<project>/T-41.3. */
export function stepDir(worktreesDir: string, projectId: string, stepKey: string): string {
  return [worktreesDir.replace(/[/\\]+$/, ''), projectId, stepKey].join('/')
}

/** prRollup of a step's work; null while it has none. */
export function stepRollup(step: Pick<Task, 'work'>, changed: string[]): ReturnType<typeof prRollup> {
  return step.work ? prRollup(step.work, changed) : null
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
  /** Steps: their worktrees, branch and PRs. Top-level tasks: legacy only (started before T-28); new ones keep null. */
  work: TaskWork | null
  /** Steps: the step waits for the user's Start instead of starting when the previous one is done (releases in parts). */
  startManually?: boolean
  /** Number of the next subtask key (T-12.<n>). Only grows, so a deleted subtask's number is never reused. */
  nextSubNo: number
  /** Set when a done or canceled task is archived; a flag, the status stays. */
  archivedAt: number | null
  /** Why the user canceled the task, if they said. */
  cancelReason?: string | null
  /** Top-level tasks imported from a tracker: the ticket (T-10). */
  tracker?: TrackerLink | null
  createdAt: number
  updatedAt: number
}

/** chat = project-level conversation, not tied to a task. tracker = reads a ticket into a task (import). */
export type AgentRole = 'groomer' | 'developer' | 'reviewer' | 'chat' | 'architect' | 'tracker'
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

/** Roles the user can configure; reviewer follows developer. tracker defaults to the provider's cheap model (see orchestrator). */
export const SETTABLE_ROLES: AgentRole[] = ['chat', 'groomer', 'developer', 'architect', 'tracker']

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
  /** Developer sessions: the step they implement; null for groomers, chats and legacy developers. */
  stepId?: string | null
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

/**
 * Whether a subtask can swap places with its neighbour. A legacy checklist is a plan: any step can move. Steps that
 * started (in progress or done) keep their place; only todo steps swap, with each other.
 */
export function canMoveSubtask(sub: Task, tasks: Task[], dir: 'up' | 'down'): boolean {
  if (!sub.parentId) return false
  const subs = subtasksOf(sub.parentId, tasks)
  const i = subs.findIndex((t) => t.id === sub.id)
  const other = i < 0 ? undefined : subs[dir === 'up' ? i - 1 : i + 1]
  if (!other) return false
  const parent = tasks.find((t) => t.id === sub.parentId)
  return (parent && isLegacy(parent)) || (sub.status === 'todo' && other.status === 'todo')
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
  // A step's status is plan progress, not activity; only a step merged is.
  if (prev.status !== next.status && next.parentId && next.status === 'done' && taskPrs(next).length) events.push({ ...base, kind: 'status', text: 'merged' })
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

/** What the current step of a task in progress waits on the user for: its Start, or the merge of its PRs. */
function stepWait(task: Task, tasks: Task[]): { kind: 'start' | 'merge'; step: Task; prs: RepoWork[] } | null {
  if (task.parentId || task.status !== 'in_progress' || isLegacy(task)) return null
  const step = currentStep(task.id, tasks)
  if (!step) return null
  if (step.status === 'todo' && step.startManually) return { kind: 'start', step, prs: [] }
  const prs = openPrs(step)
  return step.status === 'in_progress' && prs.length ? { kind: 'merge', step, prs } : null
}

/**
 * What the task's agent is doing. Waiting wins over working: a pending approval or a question blocks the agent. A
 * task in progress with no agent running waits for the user to merge its open PRs (the current step's, or a legacy
 * task's own) or to Start a step that starts manually.
 */
export function agentState(task: Task, sessions: AgentSession[], tasks: Task[]): AgentState {
  const mine = sessions.filter((s) => s.taskId === task.id)
  const approval = mine.flatMap((s) => s.items).find((i) => i.kind === 'approval' && i.status === 'pending')
  if (approval?.kind === 'approval') return { kind: 'waiting', reason: `Approval: ${approval.server} · ${approval.tool}` }
  if (task.needsInput) return { kind: 'waiting', reason: task.needsInput }
  const running = mine.filter((s) => s.status === 'running').at(-1)
  if (running) return { kind: 'working', role: running.role, since: running.runStartedAt ?? running.createdAt }
  const wait = stepWait(task, tasks)
  if (wait?.kind === 'start') return { kind: 'waiting', reason: `${wait.step.key} waits for Start` }
  if (wait) return { kind: 'waiting', reason: `${wait.step.key}: ${wait.prs.length > 1 ? `${wait.prs.length} PRs wait` : 'PR waits'} for merge` }
  // A legacy task's own PRs; new tasks have none.
  const prs = openPrs(task)
  if (task.status === 'in_progress' && prs.length) return { kind: 'waiting', reason: prs.length > 1 ? `${prs.length} PRs wait for merge` : 'PR waits for merge' }
  return null
}

export type InboxKind = 'approval' | 'agent_failed' | 'check_failed' | 'question' | 'ready_to_merge' | 'ready_to_start'

export interface InboxItem {
  /** null for an approval in a project chat. */
  task: Task | null
  kind: InboxKind
  text: string
  /** Session the item comes from: the approval's session, or the task's latest groomer/developer/tracker one. */
  session?: AgentSession
  /** Approval chat item id in `session`. */
  approvalId?: string
}

const INBOX_ORDER: InboxKind[] = ['approval', 'agent_failed', 'check_failed', 'question', 'ready_to_merge', 'ready_to_start']

/** One item for a top-level task; its steps' PRs and Start count for it. */
function inboxItem(task: Task, tasks: Task[], sessions: AgentSession[]): InboxItem | null {
  if (task.parentId || task.archivedAt || task.status === 'canceled') return null
  const last = sessions.filter((s) => s.taskId === task.id && (s.role === 'groomer' || s.role === 'developer' || s.role === 'tracker')).at(-1)
  const base = { task, session: last }
  if (last?.status === 'error')
    return { ...base, kind: 'agent_failed', text: last.role === 'tracker' ? 'Import failed' : `${last.role === 'groomer' ? 'Groomer' : 'Developer'} failed` }
  const step = isLegacy(task) ? null : currentStep(task.id, tasks)
  const checkError = workCheckError(task.work) ?? workCheckError(step?.work ?? null)
  if (checkError) return { ...base, kind: 'check_failed', text: checkError }
  if (task.needsInput) return { ...base, kind: 'question', text: task.needsInput }
  if (last?.status === 'running') return null
  const wait = stepWait(task, tasks)
  if (wait?.kind === 'start') return { ...base, kind: 'ready_to_start', text: `${wait.step.key} waits for Start` }
  const prs = wait ? wait.prs : openPrs(task)
  const ready = prs.length > 1 ? `${prs.length} PRs are ready to merge` : 'PR is ready to merge'
  if (task.status === 'in_progress' && prs.length) return { ...base, kind: 'ready_to_merge', text: wait ? `${wait.step.key}: ${ready}` : ready }
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
    ...tasks.map((t) => inboxItem(t, tasks, sessions)).filter((i): i is InboxItem => !!i),
  ].sort((a, b) => INBOX_ORDER.indexOf(a.kind) - INBOX_ORDER.indexOf(b.kind))
}

export type ProjectState = 'waiting' | 'in_review' | 'idle'

/** Waiting if something in the project's inbox waits on the user, else in review if a task has an open PR, else idle. */
export function projectState(projectId: string, tasks: Task[], sessions: AgentSession[]): ProjectState {
  const mine = tasks.filter((t) => t.projectId === projectId)
  if (inbox(projectId, mine, sessions).length) return 'waiting'
  if (mine.some((t) => !t.parentId && t.status === 'in_progress' && openPrs(t, mine).length)) return 'in_review'
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
