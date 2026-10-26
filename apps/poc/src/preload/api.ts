// Contract between the renderer and the main process. Types only.
import type { AgentInfo, AgentSession, Attachment, Canvas, Integration, Project, ProjectEvent, Task, TaskStatus, TaskType } from '@mag/core'

export interface AppState {
  projects: Project[]
  tasks: Task[]
  sessions: AgentSession[]
  /** Agent-written markdown document per task id. */
  docs: Record<string, string>
  /** Canvas metadata; fetch the HTML with getCanvas. */
  canvases: Omit<Canvas, 'html'>[]
  /** Project activity log, oldest first. */
  events: ProjectEvent[]
  /** MCP servers agents reported (claude.ai connectors and others); modes are per project in Project.integrations. */
  integrations: Integration[]
  claudeBin: string | null
}

export interface NewTask {
  projectId: string
  title: string
  type: TaskType
  description: string
  parentId?: string | null
  /** Defaults to backlog; subtasks start as groomed. */
  status?: TaskStatus
}

export interface MagApi {
  getState(): Promise<AppState>
  onState(cb: (s: AppState) => void): () => void
  pickDir(): Promise<string | null>
  createProject(name: string): Promise<Project>
  updateProject(id: string, patch: Partial<Project>): Promise<void>
  createTask(t: NewTask): Promise<Task>
  updateTask(id: string, patch: Partial<Task>): Promise<void>
  groom(taskId: string): Promise<void>
  addToPlan(taskId: string): Promise<{ ok: boolean; reasons: string[] }>
  /** Swap a plan task with its neighbour in the queue. */
  move(taskId: string, dir: 'up' | 'down'): Promise<void>
  /** Set the order of a task's subtasks; `ids` lists each of them exactly once. */
  reorderSubtasks(parentId: string, ids: string[]): Promise<void>
  /** Start or restart the developer agent on a planned/in-progress task. */
  develop(taskId: string): Promise<void>
  /** Check open PRs for merges and new comments right away. */
  checkPrs(): Promise<void>
  /** Open a URL in the browser or a path in Finder. */
  open(target: string): Promise<void>
  /** Start the architect agent; the result lands in project.architecture. */
  runArchitect(projectId: string): Promise<void>
  /** Agent providers with detection state and their models. */
  listAgents(): Promise<AgentInfo[]>
  repoInfo(path: string): Promise<{ git: boolean; origin: string | null }>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** New project chat; returns its session id. */
  newChat(projectId: string): Promise<string>
  getCanvas(id: string): Promise<string | null>
  /** Copy a pasted blob (bytes) or a dropped file (path) into the app's attachments. */
  saveAttachment(f: { name: string; bytes?: Uint8Array; path?: string }): Promise<Attachment>
  /** Absolute path of a dropped File, if it has one. */
  pathForFile(file: File): string
  stop(sessionId: string): Promise<void>
  /** Allow or deny a pending integration call (an approval chat item). */
  decideApproval(sessionId: string, approvalId: string, allow: boolean): Promise<void>
}
