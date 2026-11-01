// Contract between the renderer and the main process. Types only.
import type { AgentInfo, AgentSession, Attachment, Canvas, Integration, Project, ProjectEvent, SubtaskStatus, Task, TaskStatus, TaskType, TrackerLink } from '@mag/core'

export interface AppState {
  projects: Project[]
  tasks: Task[]
  sessions: AgentSession[]
  /** Agent-written markdown document per task id. */
  docs: Record<string, string>
  /** Canvas metadata and diagram data; fetch the HTML with getCanvas. */
  canvases: Omit<Canvas, 'html'>[]
  /** Project activity log, oldest first. */
  events: ProjectEvent[]
  /** MCP servers agents reported (claude.ai connectors and others); modes are per project in Project.integrations. */
  integrations: Integration[]
  claudeBin: string | null
  appVersion: string
  /** Projects that have a window open. */
  openProjects: string[]
}

/** What the main process asks a window to show: the project picker or the new-project form. */
export type PickerMode = 'open' | 'new'

/** What failed: a main-process hook, a child process, a React render (`renderer`) or a native crash found on start. */
export type CrashKind = 'uncaughtException' | 'unhandledRejection' | 'render-process-gone' | 'child-process-gone' | 'renderer' | 'native'

/** One file in `logs/crashes/`. */
export interface CrashReport {
  kind: CrashKind
  message: string
  stack?: string
  /** React component stack of a render error. */
  componentStack?: string
  /** Screen the renderer was showing. */
  screen?: string
  time: number
  appVersion: string
  /** Last main-process log lines (JSON) before the crash. */
  log: string[]
}

/** A renderer error the main process saves as a crash report. */
export type RendererCrash = Pick<CrashReport, 'message' | 'stack' | 'componentStack' | 'screen'>

export interface NewTask {
  projectId: string
  title: string
  type: TaskType
  description: string
  parentId?: string | null
  /** Defaults to backlog; subtasks are todo, in_progress or done. */
  status?: TaskStatus
  /** Steps: wait for the user's Start (see Task.startManually). */
  startManually?: boolean
  /** Top-level tasks: the ticket it is imported from. */
  tracker?: TrackerLink
}

/** A kind of pop-out window; each kind remembers its own size and position. */
export type WindowKind = 'architecture' | 'canvas' | 'doc'

/** What a pop-out window shows. */
export type WindowTarget =
  | { kind: 'architecture'; projectId: string }
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'doc'; taskId: string }

export interface MagApi {
  getState(): Promise<AppState>
  onState(cb: (s: AppState) => void): () => void
  pickDir(): Promise<string | null>
  createProject(name: string): Promise<Project>
  updateProject(id: string, patch: Partial<Project>): Promise<void>
  createTask(t: NewTask): Promise<Task>
  updateTask(id: string, patch: Partial<Task>): Promise<void>
  groom(taskId: string): Promise<void>
  /** Cancel a task not done yet: its agent stops and its worktrees are removed; open PRs stay. */
  cancel(taskId: string, reason: string | null): Promise<void>
  /** Archive done or canceled tasks; they keep their status. */
  archive(taskIds: string[]): Promise<void>
  /** Bring an archived task back. */
  restore(taskId: string): Promise<void>
  /** Swap a todo task with its neighbour in the queue. */
  move(taskId: string, dir: 'up' | 'down'): Promise<void>
  /** Legacy tasks only: set a checklist subtask's status; starting one sends the task's other in-progress step back to todo. */
  setSubtaskStatus(subtaskId: string, status: SubtaskStatus): Promise<void>
  /** Set the order of a task's subtasks; `ids` lists each of them exactly once. */
  reorderSubtasks(parentId: string, ids: string[]): Promise<void>
  /** Start a todo task, or restart the developer of the current step of a task in progress. */
  develop(taskId: string): Promise<void>
  /** Start the next step of a task in progress that waits for the user's Start. */
  startStep(taskId: string): Promise<void>
  /**
   * Import a tracker ticket by URL or key into a new backlog task; the tracker agent writes its brief in the background.
   * An unknown ref or a ticket already imported comes back as `error`.
   */
  importTicket(projectId: string, ref: string): Promise<{ taskId: string } | { error: string }>
  /** Run the tracker agent's import again on a linked task (no agent running), e.g. after it failed. */
  retryImport(taskId: string): Promise<void>
  /**
   * Link a top-level task to the Jira or Linear ticket a URL names (replacing its link), no import and no settings.
   * A URL that names no ticket, or a ticket linked to another task, comes back as `error`.
   */
  linkTicket(taskId: string, url: string): Promise<{ ok: true } | { error: string }>
  /** Drop the task's ticket link. */
  unlinkTicket(taskId: string): Promise<void>
  /** Move a backlog or grooming task to todo; it needs at least one step. */
  moveToTodo(taskId: string): Promise<void>
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
  /** The user's title for a project chat (topic); the generated title no longer replaces it. */
  renameChat(sessionId: string, title: string): Promise<void>
  /** Deletes a project chat (topic) with its history; its agent stops first. */
  deleteChat(sessionId: string): Promise<void>
  /** A canvas's content: the HTML page or the diagram. */
  getCanvas(id: string): Promise<Pick<Canvas, 'kind' | 'html' | 'diagram'> | null>
  /** Copy a pasted blob (bytes) or a dropped file (path) into the app's attachments. */
  saveAttachment(f: { name: string; bytes?: Uint8Array; path?: string }): Promise<Attachment>
  /** Absolute path of a dropped File, if it has one. */
  pathForFile(file: File): string
  stop(sessionId: string): Promise<void>
  /** Stop one background task (Monitor, background Bash…) of a live session; the agent is not woken. */
  stopBackground(sessionId: string, taskId: string): Promise<void>
  /** Allow or deny a pending integration call (an approval chat item). */
  decideApproval(sessionId: string, approvalId: string, allow: boolean): Promise<void>
  /** Open an artifact in its own window, or focus that window if it is already open. */
  openWindow(target: WindowTarget): Promise<void>
  /** Project this window shows; null in the Welcome window. */
  windowProjectId(): string | null
  /** Focus the project's window, or open one. */
  openProject(projectId: string): Promise<void>
  /** The main process asks to show the project picker (⌘O, File menu, dock menu). */
  onOpenPicker(cb: (mode: PickerMode) => void): () => void
  /** Focus the task's project window (opening it if closed) and show this task there. */
  openTask(taskId: string): Promise<void>
  /** Project window: show this task (a task key clicked in a pop-out, a notification clicked). */
  onOpenTask(cb: (projectId: string, taskId: string) => void): () => void
  /** Save a renderer error as a crash report in the logs folder. */
  reportCrash(crash: RendererCrash): Promise<void>
  /** The newest crash from before this start that the user has not dismissed. */
  lastCrash(): Promise<CrashReport | null>
  dismissCrash(): Promise<void>
  openLogs(): Promise<void>
}
