// Contract between the renderer and the main process. Types only.
import type { AgentInfo, AgentSession, ChatItem, ModelChoice, SearchHit, SessionHeader, SessionItemEvent, Attachment, Canvas, ChatRef, ChildRole, RewindMode, RewindScope, ComponentDiagram, DirectionChoice, Integration, LocalChoice, PrVerdict, Project, ProjectEvent, Workspace, ItemLabel, ItemRef, Label, LabelGroup, LabelGroupInput, LabelInput, ReviewFormat, ReviewPage, SubtaskStatus, Task, TaskType, TicketRef, WorkState } from '@mag/core'
import type { Deliverable, DeliverableKind } from '../main/core/services/deliverables/types.ts'
import type { MeetingPerson, OverrideInput, PeopleList, PeopleSystem, SyncReport } from '../main/core/services/people/types.ts'
import type { Meeting, MeetingContent, MeetingHit, MeetingLink, Recording, SearchFilters } from '../main/core/services/meetings/types.ts'
import type { InboxEntry } from '../main/core/services/inbox/index.ts'
import type { FollowUp, FollowUpInput, Routine, RoutineInput, RoutineRun } from '../main/core/services/routines/types.ts'
import type { Hit, SearchKind } from '../main/core/services/search/types.ts'
import type { Addition, CompareItem, FileChange, HunkBlock, HunkRef, InventoryCheck, PlanDeviation, PlanOverlay } from '@mag/diff/types'

export interface AppState {
  workspaces: Workspace[]
  labelGroups: LabelGroup[]
  labels: Label[]
  itemLabels: ItemLabel[]
  projects: Project[]
  tasks: Task[]
  /** Without items: a window loads the items of a session it shows (sessionItems) and follows onSessionItem. */
  sessions: SessionHeader[]
  /** Agent-written markdown document per task id. */
  docs: Record<string, string>
  /** Canvas metadata and diagram data; fetch the HTML with getCanvas. */
  canvases: Omit<Canvas, 'html'>[]
  /** Project activity log, oldest first. */
  events: ProjectEvent[]
  /** MCP servers agents reported (claude.ai connectors and others); modes are per project in Project.integrations. */
  integrations: Integration[]
  /** What waits on the user across all projects, without the snoozed and done items (inbox-what-waits-on-me.1). */
  inbox: InboxEntry[]
  /** Deliverables with their versions; read a version's text with readDeliverable. */
  deliverables: Deliverable[]
  /** Routines (a trigger and a prompt) and their runs (routines-scheduled-drafts-and-a.1, .2). */
  routines: Routine[]
  routineRuns: RoutineRun[]
  /** Follow-ups (who, what, due); done ones too (routines-scheduled-drafts-and-a.3). */
  followUps: FollowUp[]
  claudeBin: string | null
  appVersion: string
  /** Projects that have a window filtered to them. */
  openProjects: string[]
  /** Workspaces that have a window of their own (not filtered to a project). */
  openWorkspaces: string[]
}

/** What a Library row is: a deliverable's kind, a decision (a work's or a meeting's) or a merged change (a done work). */
export type LibraryKind = DeliverableKind | 'change'

/** One row of the Library (deliverables-library-claims-review-and.4): a view over final work, never a store of its own. */
export interface LibraryRow {
  /** Unique in the list: `dlv:<id>`, `dec:<taskId>#<n>`, `mtg:<id>#<n>`, `work:<id>`. */
  key: string
  kind: LibraryKind
  /** Where it comes from. */
  source: 'deliverable' | 'doc' | 'meeting' | 'work'
  title: string
  /** A decision's line; a deliverable's version and state; a change's key. */
  text: string
  /** ms. */
  at: number
  /** The projects it belongs to (Project filter); a meeting has those of its links. */
  projectIds: string[]
  /** Workspace label ids, Project labels included. */
  labelIds: string[]
  /** A deliverable's own labels that no workspace label is named after. */
  tags: string[]
  /** About a person (an assessment): listed only when the filter asks for it. */
  people: boolean
  /** What a click opens; `reveal`: a deliverable without a topic or work, shown in Finder. */
  open: { kind: 'topic'; id: string; deliverableId?: string } | { kind: 'work'; id: string } | { kind: 'meeting'; id: string } | { kind: 'reveal'; deliverableId: string }
}

/** Library filters; missing: any. `projectId` null: rows without a project. `people`: include people-sensitive rows. */
export interface LibraryFilter {
  kind?: LibraryKind
  projectId?: string | null
  labelId?: string
  people?: boolean
}

export interface LibraryList {
  rows: LibraryRow[]
  /** People-sensitive rows the filter left out because it did not ask for them. */
  hiddenPeople: number
}

/**
 * What a main window shows (slack-like-shell-rail-resizable.2): a workspace, its column filtered to one project when
 * `projectId` is set. Its URL hash is `workspace=<id>[&project=<id>]`; `project=<id>` alone (an old window) has no
 * workspace yet: the window takes its project's.
 */
export interface WindowView {
  workspaceId: string | null
  projectId: string | null
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
export type WindowKind = 'architecture' | 'canvas' | 'doc' | 'review'

/** What a pop-out window shows. */
export type WindowTarget =
  | { kind: 'architecture'; projectId: string }
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'doc'; taskId: string }
  /** The review window (review-v2-part-2-v1-2.2): a review of a PR, or a step's review with its plan ↔ fact. */
  | { kind: 'review'; taskId: string }

/** One CI check of a PR; bucket: pass, fail, pending, skipping or cancel. */
export interface PrCheck {
  name: string
  bucket: string
  link: string | null
}

/** A diagram a fact view names. */
export interface FactCanvas {
  id: string
  title: string
  version: number
}

/**
 * Plan ↔ fact of a step's PRs as Diff shows it (T-57.5, T-58): what `stepFact` found at `heads`: the files the PRs
 * change, plan ↔ fact of the diagrams, and the change inventory against the hunks (diff-iak-inventar-zmin-ai.1). A
 * file carries its repository's name; `repos` gives the commits to open its hunks (stepHunk).
 */
export interface FactView {
  heads: Record<string, string>
  repos: { repo: string; name: string; baseSha: string; headSha: string }[]
  files: FileChange[]
  /** Plan ↔ fact at plan level, each item with its deviation in words (phrase). */
  items: (CompareItem & { phrase: string })[]
  /** Changes inside the planned modules and entities, each module's in a line ('+12 helpers in core-pr-review'). */
  additions: (Addition & { line: string })[]
  /** Changes inside existing modules the plan does not touch, and their line ('Also changed outside the plan: …'). */
  outsidePlan: { modules: Addition[]; line: string }
  /** What keeps the review from merge: the inventory's gaps. */
  blockers: string[]
  /** The deviations from the plan, never blockers; each backed by the doc or not. */
  deviations: PlanDeviation[]
  plans: FactCanvas[]
  /** The plan's Component diagram (its root, else the first) and the comparison over it; null without one. */
  planDiagram: (FactCanvas & { diagram: ComponentDiagram; overlay: PlanOverlay }) | null
  /** The root of the fact set; null before the review starts one. */
  fact: FactCanvas | null
  /** Every diagram of the fact set, the root among them (povnyi-diff-nabir-pov-iazanykh.1). */
  set: FactCanvas[]
  /** The fact's inventory in short; null before the review writes one (or for a set drawn before inventories). */
  inventory: { units: number; summary: string[] } | null
  /** The inventory against the hunks, its blocks without their lines; null without an inventory. */
  check: (Omit<InventoryCheck, 'unaccounted'> & { unaccounted: Omit<HunkBlock, 'lines'>[] }) | null
  /** Where the fact set does not hang together: root, links, orphans. */
  warnings: string[]
  /** Read without the project's architecture (a PR outside the project): modules are folders. */
  outside: boolean
  at: number
}

/** Meetings (meetings-local-recording-transcript-and.1): the call being recorded, workspace-wide. */
export interface MeetingStatus {
  recording: Recording | null
  /** The meeting saved last in this run and its folder. */
  last: { meeting: Meeting; dir: string } | null
  /** Where meetings are kept. */
  root: string
  /** The global Record / Stop hotkey (Electron accelerator); null when another app holds it. */
  hotkey: string | null
  /** Why the last Record did not start. */
  error?: string
  /** Ids of meetings being summarized. */
  summarizing: string[]
}

export interface MagApi {
  getState(): Promise<AppState>
  onState(cb: (s: AppState) => void): () => void
  /** A session's items from index `from`. */
  sessionItems(sessionId: string, from?: number): Promise<ChatItem[]>
  /** Every change of any session's items. */
  onSessionItem(cb: (e: SessionItemEvent) => void): () => void
  /** searchAll over the project's chats and works, run where the messages are. */
  search(projectId: string, query: string): Promise<SearchHit[]>
  /** The ⌘K palette over the search index (unified-search-across-the-workspace.2). */
  searchWorkspace(query: string, opts: PaletteQuery): Promise<PaletteResult>
  /** A hit of another workspace: a window of that workspace opens it. */
  openHit(workspaceId: string, ref: string, title: string): Promise<void>
  /** This window: open a hit (another window's palette sent it here). */
  onSearchOpen(cb: (ref: string, title: string) => void): () => void
  pickDir(): Promise<string | null>
  createProject(name: string): Promise<Project>
  updateProject(id: string, patch: Partial<Project>): Promise<void>
  /** Name, profile, notes, repos...; a repo of one of its projects can't be removed (rejects). */
  updateWorkspace(id: string, patch: Partial<Omit<Workspace, 'id' | 'createdAt'>>): Promise<void>
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
   * A new topic with the ticket link (any https link) as its first message; its agent asks what to do.
   * Something that is not a link comes back as `error`.
   */
  workFromTicket(projectId: string, url: string): Promise<{ topicId: string } | { error: string }>
  /** Add a ticket to a top-level task by its link; something that is not a link comes back as `error`. */
  addTicket(taskId: string, url: string): Promise<{ ok: true } | { error: string }>
  /** Drop one of the task's tickets, by its URL. */
  removeTicket(taskId: string, url: string): Promise<void>
  /** Approve the plan of a work in planning: it is ready for the user's Start; it needs a step not done yet. */
  approve(taskId: string): Promise<void>
  /** Approve & Start: approve the plan, then Start it as develop does (`localRepos` as there). */
  approveAndStart(taskId: string, localRepos?: string[]): Promise<void>
  /** Continue a done work: back to planning; its owner (else a new groomer) gets `what` and plans the steps for it. */
  reopen(taskId: string, what: string): Promise<void>
  /** "+ Idea": parks a new topic titled after `text`, its brief (see parkedTopics). Returns the topic's session id. */
  addIdea(projectId: string, text: string): Promise<string>
  /** Check open PRs for merges and new comments right away. */
  checkPrs(): Promise<void>
  /** Open a URL in the browser or a path in Finder. */
  open(target: string): Promise<void>
  /** Start the architect agent; the result lands in project.architecture. */
  runArchitect(projectId: string): Promise<void>
  /** Agent providers with detection state and their models. */
  listAgents(): Promise<AgentInfo[]>
  /** The session's own agent, model and effort; null = its role's default. Applies from its next turn. */
  setSessionChoice(sessionId: string, choice: ModelChoice | null): Promise<void>
  repoInfo(path: string): Promise<{ git: boolean; origin: string | null }>
  /** refs: chats the message references ("@"); the agent gets their summaries with it. */
  send(sessionId: string, text: string, attachments?: Attachment[], refs?: ChatRef[]): Promise<void>
  /** New project chat; returns its session id. */
  /** A topic of the project; with projectId null, one without a project in workspace `workspaceId`. */
  newChat(projectId: string | null, workspaceId?: string): Promise<string>
  /** Puts a label on an item (by the user); in an exclusive group it replaces the other. A Project label moves a topic. */
  setLabel(ref: ItemRef, labelId: string): Promise<void>
  /** Takes a label off; the Project label leaves the topic without a project. */
  removeLabel(ref: ItemRef, labelId: string): Promise<void>
  upsertLabelGroup(group: LabelGroupInput): Promise<LabelGroup>
  deleteLabelGroup(groupId: string): Promise<void>
  upsertLabel(label: LabelInput): Promise<Label>
  deleteLabel(labelId: string): Promise<void>
  /**
   * A child session of a topic or of a session under it (topics-a-tree-of-agent.2): `brief` its first message, the
   * user's (empty: it waits for one); `role` a preset or null; `fork` starts it with all of the parent's conversation
   * (the topic's Branch). Returns the child.
   */
  startChild(parentId: string, brief: string, role: ChildRole | null, fork?: boolean): Promise<AgentSession>
  /**
   * A message action on item `n` (chat-message-actions-rewind-edit.1): rewind to a reply, edit a message (its text comes
   * back for the composer) or retry a reply. Refused while the agent works. `scope` (rewind and edit): the conversation
   * (default), Claude's file edits, or both (chat-message-actions-rewind-edit.2).
   */
  rewind(sessionId: string, n: number, mode: RewindMode, scope?: RewindScope): Promise<{ text?: string }>
  /** Undoes the last rewind, until the next send. */
  undoRewind(sessionId: string): Promise<void>
  /** A subtopic with the conversation up to the end of reply `n`'s turn; returns it. */
  branchFrom(sessionId: string, n: number): Promise<AgentSession>
  /** The user's title for a project chat (topic); the generated title no longer replaces it. */
  renameChat(sessionId: string, title: string): Promise<void>
  /** Deletes a project chat (topic) with its history; its agent stops first. */
  deleteChat(sessionId: string): Promise<void>
  /** Closes a project chat (topic): its agent stops, it goes to Done with its history; writing to it reopens it. */
  closeChat(sessionId: string): Promise<void>
  /** Deletes a work for good (a review as deleteReview): steps, sessions, docs, diagrams; refused while its agents run. */
  deleteWork(taskId: string): Promise<void>
  /** Closes a done work (a review as closeReview): it stays done and goes to Closed. */
  closeWork(taskId: string): Promise<void>
  /** Restore of a closed work, review or topic: back where it was in the list; a canceled work cannot be. */
  restore(kind: 'work' | 'topic', id: string): Promise<void>
  /** A canvas's content: the HTML page or the diagram. */
  getCanvas(id: string): Promise<Pick<Canvas, 'kind' | 'html' | 'diagram'> | null>
  /** Deletes a canvas for good; links to it show as its title. */
  deleteCanvas(id: string): Promise<void>
  /** Copy a pasted blob (bytes) or a dropped file (path) into the app's attachments. */
  saveAttachment(f: { name: string; bytes?: Uint8Array; path?: string }): Promise<Attachment>
  /** Absolute path of a dropped File, if it has one. */
  pathForFile(file: File): string
  stop(sessionId: string): Promise<void>
  /** Stop one background task (Monitor, background Bash…) of a live session; the agent is not woken. */
  stopBackground(sessionId: string, taskId: string): Promise<void>
  /** Allow or deny a pending tool call (an approval chat item): an integration's, or a GitHub write. */
  /** `note`: the user's words on a deny, which the agent gets. */
  decideApproval(sessionId: string, approvalId: string, allow: boolean, note?: string): Promise<void>
  /** An integration card's Enable: Ask / Auto: the project's mode for the card's role; the agent repeats its last step. */
  enableIntegration(sessionId: string, itemId: string, mode: 'ask' | 'reads' | 'auto'): Promise<void>
  /** A propose_rule card's Accept (appends the rule to its pack's rules.md) or Reject (writes nothing). */
  answerRule(sessionId: string, itemId: string, accept: boolean): Promise<void>
  /** Open an artifact in its own window, or focus that window if it is already open. */
  openWindow(target: WindowTarget): Promise<void>
  /** What this main window shows (its workspace, filtered to a project or not); null in Welcome and pop-outs. */
  windowView(): WindowView | null
  /** Focus the window filtered to the project, or open one. */
  openProject(projectId: string): Promise<void>
  /** A new window of the workspace (no id: of this window's); the Welcome window closes after it. */
  openWorkspace(workspaceId?: string): Promise<void>
  /** This window shows workspace `workspaceId` whole from now on; it reloads. */
  switchWorkspace(workspaceId: string): Promise<void>
  /** The main process asks to show the project picker (⌘O, File menu, dock menu). */
  onOpenPicker(cb: (mode: PickerMode) => void): () => void
  /** Focus the task's project window (opening it if closed) and show this task there. */
  openTask(taskId: string): Promise<void>
  /** Project window: show this task (a task key clicked in a pop-out, a notification clicked). */
  onOpenTask(cb: (projectId: string, taskId: string) => void): () => void
  /**
   * Plan ↔ fact of a step from the code (T-57.5): its open PRs (else the heads its fact was recorded at) against its
   * plan diagrams; null when it has neither. A review of a teammate's PR: the fact of its PR, without a plan.
   */
  stepFact(stepId: string): Promise<FactView | null>
  /** The lines of one hunk of a step's PR (`+…`, `-…`), from `base`..`head` of one of its repositories. A review's too. */
  stepHunk(stepId: string, repo: string, base: string, head: string, hunk: HunkRef): Promise<string[]>
  /**
   * Review a teammate's PR of a project repository: its review (new, or the PR's own again) and the topic that does it.
   * `format`: the result it runs, the project's default without one. A link that is not one, or a closed PR, comes
   * back as `error`.
   */
  startReview(projectId: string, url: string, format?: ReviewFormat): Promise<{ taskId: string; sessionId: string } | { error: string }>
  /** Run v1 / Run v2: that format's review of the PR at its head, in its own topic; the other result stays. */
  runReviewFormat(taskId: string, format: ReviewFormat): Promise<void>
  /** The v1 | v2 switch: the review's page, lists and conversation show that format's result. */
  showReviewResult(taskId: string, format: ReviewFormat): Promise<void>
  /** The review's PR as it is now gets another look by its topic (a new one if it is gone); returns the topic. */
  reviewAgain(taskId: string): Promise<string>
  /** Close a review: done; reviewAgain brings it back. */
  closeReview(taskId: string): Promise<void>
  /**
   * The user's call on the direction of a review's PR: recorded on its report and in the project's decisions and notes;
   * prefer and discuss draft a comment to the author. Nothing goes to GitHub.
   */
  decideDirection(taskId: string, decision: { choice: DirectionChoice; option?: string; principle?: string }): Promise<void>
  /** Discuss with agent: the review's topic gets the direction card and argues the options with the user; returns the topic. */
  discussDirection(taskId: string): Promise<string>
  /** Delete a review for good: it, its doc and diagrams, and the topic mag created for it. Nothing changes on GitHub. */
  deleteReview(taskId: string): Promise<void>
  /** The CI checks of a review's PR, from GitHub. */
  prChecks(taskId: string): Promise<PrCheck[]>
  /**
   * Publish a review to its PR on GitHub as the user: `verdict` and only the findings at `picks` (indexes into its
   * findings). The user's button only; returns the review's link, or what GitHub refused.
   */
  publishReview(taskId: string, verdict: PrVerdict, picks: number[]): Promise<{ url: string } | { error: string }>
  /**
   * A review of a PR outside the project: the user picks a checkout of its repository, which joins the project, and the
   * review looks again; returns its topic. null when the user cancels.
   */
  connectReviewRepo(taskId: string): Promise<{ sessionId: string } | { error: string } | null>
  /**
   * The user's Export review (review-v2-part-2-v1-2.3): a save dialog, then one .zip of the review; its path, null when
   * the user cancels.
   */
  exportReview(taskId: string): Promise<string | null>
  /**
   * The user's Import review: the .zip at `zipPath` (dropped), else one picked in a dialog, becomes a read-only review
   * work of the project; null when the user cancels.
   */
  importReview(projectId: string, zipPath?: string): Promise<{ taskId: string } | { error: string } | null>
  /** Main asks this window for a review's static page and diagram SVGs, for its archive; `fn` renders them. */
  onRenderReviewExport(fn: (taskId: string) => Promise<ReviewPage>): () => void
  /** Save a renderer error as a crash report in the logs folder. */
  reportCrash(crash: RendererCrash): Promise<void>
  /** The newest crash from before this start that the user has not dismissed. */
  lastCrash(): Promise<CrashReport | null>
  dismissCrash(): Promise<void>
  openLogs(): Promise<void>
  /** Hides an inbox item until `until` (ms) or new activity of its source; 'activity': until new activity only. */
  snoozeInbox(key: string, until: number | 'activity'): Promise<void>
  /** Hides an inbox item until its source has new activity. */
  doneInbox(key: string): Promise<void>
  /** Creates or edits a routine; throws with what is wrong (a bad schedule, no prompt). */
  saveRoutine(input: RoutineInput): Promise<Routine>
  removeRoutine(id: string): Promise<void>
  /** Runs it now, outside its schedule; resolves once the run started. Throws while one runs. */
  runRoutine(id: string): Promise<RoutineRun>
  /** Adds a follow-up; `fromKey`: the Inbox item it was made from, marked Done (the follow-up brings it back when due). */
  addFollowUp(input: FollowUpInput & { fromKey?: string }): Promise<FollowUp>
  meetingStatus(): Promise<MeetingStatus>
  onMeetingStatus(cb: (s: MeetingStatus) => void): () => void
  /** Starts recording the call; the first time macOS asks for the microphone and system audio. */
  startRecording(title?: string): Promise<{ ok: true } | { error: string }>
  /** Stops and saves the transcript; resolves once the last chunk is transcribed. */
  stopRecording(): Promise<void>
  /** Every meeting under the storage root, newest first. */
  listMeetings(): Promise<Meeting[]>
  readMeeting(id: string): Promise<MeetingContent>
  /** Deletes the meeting's folder. */
  removeMeeting(id: string): Promise<void>
  renameMeeting(id: string, title: string): Promise<Meeting>
  linkMeeting(id: string, ref: MeetingLink): Promise<Meeting>
  unlinkMeeting(id: string, ref: MeetingLink): Promise<Meeting>
  /** Ranked lines of meetings matching every word of `q`. */
  searchMeetings(q: string, filters?: SearchFilters): Promise<MeetingHit[]>
  /** Writes summary.md again. */
  summarizeMeeting(id: string): Promise<void>
  /** The meeting's folder in Finder; without an id, the storage root. */
  revealMeeting(id?: string): Promise<void>
  /** A folder dialog; the new root, or null when canceled. */
  chooseMeetingsRoot(): Promise<string | null>
  /** Called when meetings were saved, summarized, renamed, linked or deleted. */
  onMeetingsChanged(cb: () => void): () => void
  /** A deliverable's version text; without `n`, its final version when final, else the latest. Rejects when its folder is gone. */
  readDeliverable(id: string, n?: number): Promise<string>
  /** The user's Mark final of version `n`. */
  markDeliverableFinal(id: string, n: number): Promise<void>
  /** The deliverable's current version in Finder. */
  revealDeliverable(id: string): Promise<void>
  /** Asks its topic to post the final version; the Publish card's Allow marks it published. */
  publishDeliverable(id: string): Promise<void>
  /** The Library of a workspace (deliverables-library-claims-review-and.4): final deliverables, decisions and merged works, newest first. */
  listLibrary(workspaceId: string, filter: LibraryFilter): Promise<LibraryList>
  /** People of a workspace (who-is-who-people-from.1): persons with handles, open suggestions, unmatched handles. */
  listPeople(workspaceId: string): Promise<PeopleList>
  /** Pulls the workspace's directories now. */
  syncPeople(workspaceId: string): Promise<SyncReport>
  /** The user's correction: the handle is this person (null: not a person); kept across syncs. */
  overridePerson(o: OverrideInput): Promise<void>
  /** The user's Reject of a suggestion. */
  rejectPerson(workspaceId: string, system: PeopleSystem, handle: string, personId: string): Promise<void>
  /** The user's Not a person on a person: a bot. */
  notPerson(workspaceId: string, personId: string): Promise<void>
  /** The meeting's participants as persons of `workspaceId` (who-is-who-people-from.2): chips, with suggestions. */
  meetingPeople(id: string, workspaceId: string): Promise<MeetingPerson[]>
  /** Called when people were synced or corrected. */
  onPeopleChanged(cb: () => void): () => void
  /** ▶ Run of a command block: runs it in the user's shell in the project's first repository; `onOutput` streams. */
  runCommand(runId: string, sessionId: string, command: string, onOutput: (chunk: string) => void): Promise<{ code: number | null; cwd: string }>
  stopCommand(runId: string): Promise<void>
}

/** What the palette asks: the window's workspace, or every one; label ids, every group matched; person rows too. */
export interface PaletteQuery {
  workspaceId: string
  scope?: 'all'
  labels?: string[][]
  people?: boolean
}

/** The palette's hits: the best across kinds, and the best of each kind (its tab). */
export interface PaletteResult {
  all: Hit[]
  byKind: Record<SearchKind, Hit[]>
  /** Most hits of each; a tab this full may have more. */
  limit: number
}
