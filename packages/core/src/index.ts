// Domain model shared by every mag app (PoC, desktop, web, backend).
// Keep it free of runtime dependencies.

export type LeafTaskType = 'dev' | 'design' | 'spike' | 'research'
export type TaskType = 'story' | LeafTaskType

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
  /** How many developer agents may work in parallel. */
  devPoolSize: number
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
  /** Human key, e.g. T-12. */
  key: string
  parentId: string | null
  title: string
  type: TaskType
  status: TaskStatus
  /** What the user wrote. The agent-owned document lives separately. */
  description: string
  /** null = not decided yet, [] = explicitly no dependencies. */
  dependsOn: string[] | null
  /** Set by an agent when it needs the user; one line shown in "Needs you". */
  needsInput: string | null
  work: TaskWork | null
  createdAt: number
  updatedAt: number
}

/** chat = project-level conversation, not tied to a task. */
export type AgentRole = 'groomer' | 'developer' | 'reviewer' | 'chat' | 'architect'
export type AgentKind = 'claude-code'

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
  status: 'running' | 'idle' | 'error'
  items: ChatItem[]
  createdAt: number
}

/** Normalized events every agent adapter emits. */
export type AgentEvent =
  | { type: 'session.started'; nativeSessionId: string; model?: string }
  | { type: 'message'; text: string }
  | { type: 'tool.call'; id: string; name: string; input: unknown }
  | { type: 'tool.result'; id: string; ok: boolean }
  | { type: 'turn.done'; ok: boolean; costUsd?: number; nativeSessionId?: string }
  | { type: 'error'; message: string }
  | { type: 'raw'; payload: unknown }

export const PLAN_STATUSES: TaskStatus[] = ['planned', 'in_progress', 'in_review', 'done']
export const BACKLOG_STATUSES: TaskStatus[] = ['backlog', 'grooming', 'groomed']

/** A planned leaf task whose dependencies are all done can be picked by a developer. */
export function isReady(task: Task, all: Task[]): boolean {
  if (task.status !== 'planned' || task.type === 'story') return false
  return (task.dependsOn ?? []).every((id) => all.find((t) => t.id === id)?.status === 'done')
}

/** Why a task cannot enter the plan yet; empty array = it can. */
export function planBlockers(task: Task): string[] {
  const reasons: string[] = []
  if (task.status !== 'groomed') reasons.push('not groomed yet')
  if (task.needsInput) reasons.push('agent is waiting for input')
  if (task.dependsOn === null) reasons.push('dependencies not set')
  return reasons
}

export const DEFAULT_TEMPLATES: Record<TaskType, string> = {
  story: `# Problem
One or two sentences.

# Open questions
Only if any.

# Decomposition
Subtasks, each one PR or one deliverable. Create them with the create_subtask tool.

# Architecture
Mermaid diagram at the level where the change happens.
`,
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
