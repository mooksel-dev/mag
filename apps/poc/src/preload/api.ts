// Contract between the renderer and the main process. Types only.
import type { AgentInfo, AgentSession, Attachment, Canvas, Idea, Integration, LocalChoice, Project, ProjectEvent, SubtaskStatus, Task, TaskType, TicketRef, WorkState } from '@mag/core'
import type { CompareItem, Coverage, FileChange, Grounding, HunkRef } from '@mag/diff/types'

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
  /** Ideas of every project, in the order they were added (see projectIdeas). */
  ideas: Idea[]
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
  /** Works default to planning; subtasks are todo, in_progress or done. */
  status?: WorkState | SubtaskStatus
  /** Steps: wait for the user's Start (see Task.startManually). */
  startManually?: boolean
  /** Steps: the repositories it changes (see Task.repos). */
  repos?: string[]
  /** Top-level tasks: the tickets it is about (see Task.tickets). */
  tickets?: TicketRef[]
  /** Top-level tasks: the session that discussed and planned it (see Task.ownerSessionId). */
  ownerSessionId?: string
}

/** A kind of pop-out window; each kind remembers its own size and position. */
export type WindowKind = 'architecture' | 'canvas' | 'doc'

/** What a pop-out window shows. */
export type WindowTarget =
  | { kind: 'architecture'; projectId: string }
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'doc'; taskId: string }

/** A diagram a fact view names. */
export interface FactCanvas {
  id: string
  title: string
  version: number
}

/**
 * Plan ↔ fact of a step's PRs as Diff shows it (T-57.5, T-58): what `stepFact` found at `heads`: the files the PRs
 * change, plan ↔ fact of the diagrams, which changed code files the fact diagram shows and which of its lines do not
 * rest on the PR. A file carries its repository's name; `repos` gives the commits to open its hunks (stepHunk).
 */
export interface FactView {
  heads: Record<string, string>
  repos: { repo: string; name: string; baseSha: string; headSha: string }[]
  files: FileChange[]
  items: CompareItem[]
  blockers: string[]
  plans: FactCanvas[]
  /** The step's fact diagram; null before the review starts one. */
  fact: FactCanvas | null
  /** null without a fact diagram. */
  coverage: Coverage | null
  unverified: Grounding['unverified']
  at: number
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
  /** Cancel a task not done yet: its agent stops and its worktrees are removed; open PRs stay. */
  cancel(taskId: string, reason: string | null): Promise<void>
  /** Legacy tasks only: set a checklist subtask's status; starting one sends the task's other in-progress step back to todo. */
  setSubtaskStatus(subtaskId: string, status: SubtaskStatus): Promise<void>
  /** Set the order of a task's subtasks; `ids` lists each of them exactly once. */
  reorderSubtasks(parentId: string, ids: string[]): Promise<void>
  /**
   * Start a ready work, or restart the developer of the current step of a task in progress. `localRepos` (the Start
   * popup): repositories its steps work on in the main checkout instead of a worktree.
   */
  develop(taskId: string, localRepos?: string[]): Promise<void>
  /** The user's answer to a local check of a step (see LocalCheck); the step starts when none is left. */
  resolveLocal(stepId: string, repo: string, choice: LocalChoice): Promise<void>
  /** Start the next step of a task in progress that waits for the user's Start. */
  startStep(taskId: string): Promise<void>
  /** Runs the agent review of the current step's PRs again (after a failed one). */
  review(taskId: string): Promise<void>
  /**
   * A new work about the ticket a link names (any https link); a groomer plans it in the background and owns it.
   * Something that is not a link comes back as `error`.
   */
  workFromTicket(projectId: string, url: string): Promise<{ taskId: string } | { error: string }>
  /** Add a ticket to a top-level task by its link; something that is not a link comes back as `error`. */
  addTicket(taskId: string, url: string): Promise<{ ok: true } | { error: string }>
  /** Drop one of the task's tickets, by its URL. */
  removeTicket(taskId: string, url: string): Promise<void>
  /** Approve the plan of a work in planning: it is ready for the user's Start; it needs a step not done yet. */
  approve(taskId: string): Promise<void>
  /** Continue a done work: back to planning; its owner (else a new groomer) gets `what` and plans the steps for it. */
  reopen(taskId: string, what: string): Promise<void>
  addIdea(projectId: string, text: string): Promise<void>
  updateIdea(ideaId: string, text: string): Promise<void>
  deleteIdea(ideaId: string): Promise<void>
  /** The idea's own topic for its discussion, created the first time. Returns its session id. */
  discussIdea(ideaId: string): Promise<string>
  /**
   * Starts a work from the idea in its topic, or in a new one without a discussion (the idea leaves the list at once;
   * a discussed one when the work is created). Returns the topic's session id.
   */
  startIdea(ideaId: string): Promise<string>
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
  /**
   * Plan ↔ fact of a step from the code (T-57.5): its open PRs (else the heads its fact was recorded at) against its
   * plan diagrams; null when it has neither.
   */
  stepFact(stepId: string): Promise<FactView | null>
  /** The lines of one hunk of a step's PR (`+…`, `-…`), from `base`..`head` of one of its repositories. */
  stepHunk(stepId: string, repo: string, base: string, head: string, hunk: HunkRef): Promise<string[]>
  /** Save a renderer error as a crash report in the logs folder. */
  reportCrash(crash: RendererCrash): Promise<void>
  /** The newest crash from before this start that the user has not dismissed. */
  lastCrash(): Promise<CrashReport | null>
  dismissCrash(): Promise<void>
  openLogs(): Promise<void>
}
