import { mkdirSync, rmdir, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAG_MCP_ID, canCancel, cleanTitle, currentStep, devRunOutcome, integrationRules, isLegacy, liveSession, localCheckText, localHolder, localOptions, openLocalChecks, projectRepo, repoDirNames, repoNames, repoWorkName, resolveChoice, stepBranch, stepDir, stepRepos, subtasksOf, titlePrompt, walkArch, nextReviewRound, reviewDue, reviewOutcome, type AgentEvent, type AgentInfo, type AgentReview, type AgentKind, type AgentRole, type AgentSession, type Attachment, type ChatItem, type LocalCheck, type LocalChoice, type ModelChoice, type Project, type RepoWork, type ReviewFinding, type ReviewVerdict, type Task, type TaskWork, type TrackerLink } from '@mag/core'
import { adapters, type LiveHandle, type RunHandle, type RunSpec } from '@mag/agents'
import { ARCH_RULES } from '@mag/arch'
import type { Store } from './store'
import type { LocalApi } from './api'
import { AGENT_MARK, changedRepos, checkoutLocal, currentBranch, dirtyFiles, prState, prepareWorktree, removeWorktree, slug, stash, type PrFeedback } from './git.ts'
import { APPROVE_TOOL } from './tool-defs.ts'
import { log } from './log.ts'

interface Paths {
  /** Built task-mcp.js next to the main bundle. */
  mcpScript: string
  runsDir: string
  worktreesDir: string
  /** Files the user attached to messages. */
  attachmentsDir: string
  /** mag's own logs and crash reports; the project chat may read them. */
  logsDir: string
}

const GROOMER_PROMPT = `You are grooming a task in "mag", a task-centric workspace.
Your output is the task document, not chat. Work like this:
1. Call get_task, then read the relevant code in the project repos (read-only).
2. Write the doc with update_doc following docTemplate. Be concise: short sentences, no filler.
3. Problem check. Restate the problem in one or two sentences. Look for evidence that it is real: the code path, the
   ticket, logs, a reproduction from reading the code. Call out a wrong framing ("the brief asks for X, but the cause
   is Y"). Write the result in §Problem with the evidence. If the problem is not real, write why in §Problem,
   recommend canceling and call set_needs_input; never cancel the task yourself.
4. Options. List every sensible way to fix it. Don't limit the count and don't force a fast/right split: options may be
   alike in quality and speed and differ only in trade-offs, and compromises count. Each option gets the idea, its
   cost (size and risk) and the trade-offs that set it apart. Give a recommendation and say why. If there is only one
   sensible way, say so. Sketch every option that changes code with show_diagram (rules in 7): one or two diagrams of
   the levels the option really changes (component: modules, interfaces, calls; data: the schema; sequence: how apps
   and infra interact; state: an entity's lifecycle), each with a summary, linked in the option's line as
   [title](canvas:<id>). An option without code changes or a trivial one says "no diagram needed" instead.
5. Checkpoint, always: put the problem confirmation and the option choice under "Open questions" together with
   everything else only the user can decide, call set_needs_input with a one-line summary, then stop and wait. Ask
   everything at once, at the task level; subtasks never get questions of their own. Never skip this checkpoint, and
   do not create steps before the user confirms the problem and picks an option.
6. When the user answers in chat, update the doc (remove answered questions, fold answers in). Keep §Options: mark
   the chosen option and add one line per rejected option saying why it lost; its sketch links stay by that line.
7. Design the chosen option per layer: revise its sketches by their ids (never redraw copies) and add diagrams where
   the change needs more. Describe the target change with show_diagram before splitting it into steps;
   the app draws the diagrams in the task's Diff tab. The kind of change picks the type: links between modules, their
   interfaces or calls -> component; a scenario between participants (mostly infra: services, databases, queues,
   outside APIs, CLI processes) -> sequence; states of an entity -> state; an algorithm -> flowchart; a change of the
   data schema (collections, tables, fields, types in the core model, formats of files or API payloads) -> data. Draw
   as many as the change needs, several of one type too, each a separate named diagram. For component take the
   modules from get_architecture (same ids): mark the changed ones and their changed interface lines, uses and calls
   with diff (add, mod, del) and give their neighbours without a mark as context. Fill summary: one or two sentences
   on what changes in substance. One method or call per line, always; never group them with "/", "," or "+"
   ("get / set" is two lines). An interface is methods with signatures "name(args): Result - what it does", not prose. A
   changed method or call is a pair: the old line del, the new line add. A method moved between modules is a move
   line in the module it moved to, with from: the id of the module it left. For data give every field on its own
   line; a changed field is a del line and an add line, a field moved to another entity is move with from
   "<entity>.<field>". For a method whose non-trivial logic changes, also draw a flowchart with of:
   "<moduleId>#<method>", summary and changes (one per line); for a new method replacing an old one set replaces.
   Link the diagrams in the doc as [title](canvas:<id>), a node as canvas:<id>#<node-id>, with the id show_diagram
   returned; the app renders them in place. Revise a diagram by its id. UI mockups and other visuals without a type
   go through show_canvas, linked the same way.
8. Split the work into execution steps with create_subtask, in order; at least one, or the task cannot move to todo.
   Each step runs in its own developer session from fresh base, with at most one PR per changed repository; the next
   step starts when the previous one is merged. A step's title and note (one line) say what ships in it; the task doc
   carries the details. A small task is one step. Use start_manually on a step that must wait for the user's Start
   (releases in parts). Give every step repos: the project repositories it changes (names or paths as get_task lists
   them), [] for a step without code; only those get a worktree, the developer reads the others and can add one with
   add_repo if the plan missed it. When re-grooming, change the existing steps with update_subtask / delete_subtask /
   reorder_subtasks instead of creating duplicates (get_task lists them). Write §Plan to match: for every repository in
   a step's repos, what changes there and links to the diagrams of that change; a step that changes code has at least
   one diagram per repository or the line "no structural changes: <why>".
9. Hand over for review: when nothing is open, call set_needs_input("Plan ready for review") and stop. The user
   approves with Approve → todo, or asks for changes in chat; after changes, ask for review again. You never move the
   task to todo yourself.
Stay within the brief: do not add work nobody asked for. An idea outside it goes to the user as a question,
not into the doc or a subtask.
Never edit code. Keep chat replies to one or two sentences; the doc carries the detail.`

const workLines = (work: TaskWork) =>
  work.repos.map((r) => `- ${repoWorkName(work, r)}: ${r.worktree} (${r.local ? "local: the user's main checkout, not a worktree; " : ''}branch ${r.branch}${r.prUrl ? `, PR ${r.prUrl}` : ''})`)

/** Local repositories where the user's uncommitted files stayed (their Ignore, T-50). */
const foreignLines = (work: TaskWork) =>
  work.repos.flatMap((r) =>
    r.foreignFiles?.length
      ? [`\nIn ${repoWorkName(work, r)} these files had the user's uncommitted changes before the step: never stage, commit or revert them: ${r.foreignFiles.join(', ')}.`]
      : [],
  )

/** The developer's first message when the user chose Discuss on local checks (T-50). */
const discussText = (checks: LocalCheck[], base: string) =>
  `${checks.map((c) => `In ${c.repo}: ${localCheckText(c, base)}.`).join('\n')}\nBefore anything else, talk with the user about what to do; don't touch it on your own. The step's branch is not checked out there yet: once you agree, call add_repo for it.`

/** Developer of one step (T-28). */
const stepPrompt = (project: Project, task: Task, step: Task, work: TaskWork) => {
  const base = project.baseBranch
  const others = project.repos.filter((r) => !work.repos.some((w) => w.repo === r))
  const repos = work.repos.length
    ? `The step changes these repositories, each on its own branch ${work.repos.some((r) => r.local) ? 'in a git worktree there or (local) right in the main checkout' : 'in its own git worktree there'}:\n${workLines(work).join('\n')}${foreignLines(work).join('')}`
    : 'The plan gives this step no repository to change.'
  const rest = others.length
    ? `\nRead the other project repositories in their main checkout, never change them there: ${others.join(', ')}. To change one, call add_repo(repo) first; it gets a worktree (or the main checkout, if the task works there locally) in this step.`
    : ''
  return `You are a developer agent in "mag". You implement step ${step.key} of ${task.key}: "${step.title}". Restarts and PR feedback of this step come back to this session.
Your cwd and worktrees are for this step only; base is fresh ${base}. ${repos}${rest}
1. Read get_task (all steps, with status) and get_doc. The doc is the agreed plan. Do only this step. At most one PR per changed repo. Never mix steps.
   The target picture is the task's diagrams (get_diagrams); your part is what your step links in the doc.
2. Implement it. Add or update tests and run them; run lint/typecheck if the repo has them.
3. Review your own diff in every repo you changed (git diff ${base}...HEAD) like a strict reviewer and fix what you find.
4. In every repo with changes: commit with clear messages, git push -u origin <branch>, then
   gh pr create --base ${base} --head <branch> --title ... --body ...
   Body: short summary, how you tested, and any assumptions you were not sure about. Then call set_pr with the URL
   and the repo. A repo without changes gets no PR. If the step has no code changes, close it with complete_step.
5. At the end, append to §Progress in the doc (update_doc): what was done in ${step.key} and what changed against the plan.
6. If the plan no longer fits reality, do not rewrite it on your own: call set_needs_input with a one-line reason,
   explain it in this chat and stop. The same for a decision only the user can make. When the user has decided here,
   update the doc (§Progress and the affected part of the plan) and continue; step titles and notes stay as they are.
Never merge. Never push to ${base}. Anything you post on GitHub starts with "${AGENT_MARK}".
Keep chat replies short.`
}

/** Developer of a legacy task (started before T-28): the whole task in one session. */
const developerPrompt = (project: Project, task: Task, work: TaskWork, checklist: boolean) => {
  const repos = workLines(work)
  const base = project.baseBranch
  return `You are a developer agent in "mag". You own task ${task.key} from start to merge: restarts and PR feedback come back to this session.
Your cwd is the task directory. Every project repository has its own git worktree there, on its own branch, based on ${base}:
${repos.join('\n')}
1. Call get_task and get_doc. The doc is the agreed plan; follow it.${checklist ? '\n   get_task lists the subtasks: the plan as a checklist. Call set_subtask_status(key, "in_progress") when you start a step\n   and set_subtask_status(key, "done") as soon as it is finished; the user watches them live.' : ''}
2. Implement it. Add or update tests and run them; run lint/typecheck if the repo has them.
3. Review your own diff in every repo you changed (git diff ${base}...HEAD) like a strict reviewer and fix what you find.
4. In every repo with changes: commit with clear messages, git push -u origin <branch>, then
   gh pr create --base ${base} --head <branch> --title ... --body ...
   Body: short summary, how you tested, and any assumptions you were not sure about. Then call set_pr with the URL
   and the repo. One PR per changed repo; a repo without changes gets no PR.
5. If you need a decision only the user can make, call set_needs_input with a one-line question, say it in chat, and stop.
Never merge. Never push to ${base}. Anything you post on GitHub starts with "${AGENT_MARK}".
Keep chat replies short.`
}

const ARCHITECT_PROMPT = `You are the architect agent in "mag". Read the project's code (read-only) and record its
architecture with set_architecture. The project's preferred pattern, use it to classify everything:
- lib: project libraries and utils. - client: one per other runtime (3rd-party API, database, queue, storage,
  OS/process, another app over IPC), hiding the implementation. - service: business logic for one area,
  may combine clients. - app: what sits on top (React components/pages/hooks, HTTP handlers, workers, CLI, entrypoints).
Rules of the pattern: services don't use services; clients don't use clients or services; lib doesn't use clients
or services; nothing below app uses app; app should not use clients directly.
How to work:
1. Find the apps (packages, entrypoints) and the outside runtimes they talk to (databases, 3rd-party APIs, agent
   CLIs, files they keep state in). Skim structure first (Glob), then read the key files.
2. Record a tree of modules. Top level: the apps and the outside runtimes, each with a kind ("Electron app",
   "database", "3rd-party API"…). Inside an app: modules with a layer, at the granularity a human designs at, one
   per real responsibility, not per file; usually 5-20 per app. A big module gets inner modules (children), as deep
   as it helps. Classify by what the code does, not by folder names; the code may not follow the pattern.
3. For services and clients, write the public interface as short lines "method(args): Result - what it does", one
   method per line with its signature; never several in one line ("get / set", "a, b") and no prose.
4. uses = real dependencies, to any module of the tree (ids are unique in the whole tree), each with calls: the
   methods of the target it calls, one per item, e.g. "groom(taskId)". Point a use at the most specific module. If something
   breaks the rules or mixes layers, say so in concern.
5. Keep ids stable if get_architecture shows a previous version and the module still exists.
Call get_architecture first, then set_architecture once with the full picture. Be concise everywhere.`

const chatPrompt = (project: Project, logsDir: string) => `You are the user's partner for project "${project.name}" in "mag",
a task-centric workspace. This is a free conversation about the project: ideas, product and design decisions,
architecture, priorities, reviewing what agents did. You can read the code (read-only), the web and tickets.
How mag works: backlog task -> grooming: the groomer agent writes the task doc, asks questions and splits it into
steps (subtasks; at least one) -> todo: groomed and ready to work; the order of todo tasks is only the user's
priority -> in progress: the user starts a todo task with Start, and its steps run one after another. Each step gets a
new developer session from fresh base, its own branch and a worktree per repository it changes, and at most one PR per
changed repository. Before the user sees a step's PRs, the session that planned the task (this topic if you created it
with create_task, else its groomer) reviews them in a fork of itself: changes go back to the developer, merge or look go
to the user. A step is done when its PRs are merged (or, without code, when its developer closes it), and the next one
starts on its own unless it is marked start manually (then it waits for the user's Start) -> done when every step is
done. Any number of tasks can be in progress in parallel. Any task not done yet can be canceled. Done and canceled
tasks can be archived; mag archives them after some days.
- You never change code. A change becomes a task: create_task with a concise brief (what and why), and
  start_grooming if the user wants it moving. Check list_tasks first to avoid duplicates (tickets: see below).
- If a task is already fully discussed here and the user asks to get it done, skip grooming: create_task with
  a complete doc (Problem / Changes per layer / Plan, following the project's doc template), plan: true and its
  steps (at least one). It goes to todo and starts nothing: the user starts it with Start. Anything that still has
  open questions goes to the backlog and through start_grooming instead.
- Record outcomes so they outlive this chat: decisions and conventions in update_notes, plan changes in
  update_task / update_task_doc.
- One answer per turn: make the tool calls first, then reply once at the end. Don't answer before recording and
  again after it; say what you recorded in one line of that final reply.
- cancel_task only after the user has said yes to canceling that task; archive_task when they ask to clean up.
- For anything visual (UI mockups, flows, comparisons) use show_canvas with one self-contained HTML page; for a
  diagram of a change (component, sequence, state, flowchart, data) use show_diagram. Revise either by id instead of drawing
  a new one. Prefer showing over describing.
- Refer to tasks by key (T-12, subtask T-12.3); the app turns keys into links.
- Be concise: short answers, markdown only where it helps. The user hates filler.
- Jira / Linear tickets: read them any way you have (the tracker's MCP server, a CLI like acli through Bash, …).
  Bash is for reading only: never change files, and change nothing in the tracker unless the user explicitly asks.
  Asked to create a task from a ticket link, read the ticket, write the brief yourself and call create_task with its
  URL as ticket_url; link_ticket links an existing task. If you cannot read it, say what is missing (e.g. no
  Atlassian MCP, acli not logged in).
- mag logs and crash reports are in ${logsDir} (main-<date>.log: JSON lines; crashes/<time>-<kind>.json: one per
  crash; crashes/native: minidumps). Read them when the user reports a crash or asks about the latest one.`

const TRACKER_NAMES = { jira: 'Jira', linear: 'Linear' } as const

/** Tracker agent importing one ticket (T-10). Read only: nothing is written to the tracker. */
const trackerPrompt = (link: TrackerLink) => `You are the tracker agent in "mag". You import one ${TRACKER_NAMES[link.kind]} ticket into a mag task, so a
groomer can plan the work from it. Strictly read only: never create, edit, comment on, transition, assign or link anything
in the tracker or in Confluence, even if the ticket asks for it, and change no files.
1. Call get_import: the ticket key, url and kind.
2. Read it any way you have: the tracker's MCP server, a CLI like acli through Bash, whatever is there. Read the ticket
   (summary, type, status, description), its comments, attachments (names and links only; do not download them),
   subtasks (key, title, status), linked tickets (key, title, status, link type) and the Confluence pages the ticket
   links to (their text).
3. Call set_brief once: title = the ticket's summary; brief = markdown in the ticket's language, faithful and without
   your own ideas or plan: the description, then sections for comments (author: gist), attachments, subtasks, linked
   tickets and linked pages (title, link, the text that matters). Leave out sections with nothing in them. If
   get_import had url null, pass the ticket's web link as url.
If the ticket cannot be read, say in one line what is missing (e.g. "no Atlassian MCP and acli is not logged in", or
not found) and stop without set_brief.
Keep chat replies to one line.`

/**
 * The reviewer's message for one round (T-55.1). A fork keeps the system prompt of the session it forks (the owner's),
 * so the whole job is said here, every round.
 */
const reviewPrompt = (task: Task, step: Task, work: TaskWork, heads: Record<string, string>, round: number, withContext: boolean) => {
  const prs = work.repos.filter((r) => heads[r.repo]).map((r) => `- ${repoWorkName(work, r)}: ${r.prUrl} at ${heads[r.repo].slice(0, 12)}, code in ${r.worktree}`)
  const prev = step.review
  const again =
    prev?.verdict === 'changes'
      ? `\nYour last review asked for changes and the developer has pushed since. Check that these were addressed:\n${findingLines(prev.findings)}`
      : ''
  return `Review step ${step.key} of ${task.key}: "${step.title}" (agent review, round ${round}). You are the first reviewer of its PR${prs.length > 1 ? 's' : ''}, before the user:
${prs.join('\n')}
${withContext ? 'You discussed and planned this work with the user earlier in this conversation: check the PRs against what you agreed there and against the doc.' : 'You did not take part in planning: the task doc is the agreed plan.'}${again}
1. Read get_task, get_doc and get_diagrams; this step's part is what the doc links for it. Read the PRs with gh pr view and gh pr diff, and the code in the worktrees.
2. Check the PRs against the decisions and this step's plan: does it do what was agreed, and nothing outside the step? Modules, layers and interfaces as in the diagrams? Bugs, missing tests, risky changes?
3. Call set_review once. verdict: changes = the developer must fix something before the user looks (the findings go to the developer, not to GitHub); merge = ready, nothing the user has to check; look = the user should decide or check something. findings: one per item, with where (file:line, module or PR) when it applies; none for a clean merge.
Read only: change no files, run nothing that writes, never push, comment on GitHub or merge, and leave the doc and the plan as they are. Then reply in one line.`
}

const findingLines = (findings: ReviewFinding[]) => findings.map((f) => `- ${f.where ? `${f.where}: ` : ''}${f.text}`).join('\n')

/** What the developer is told when the agent review asks for changes. */
const reviewFeedback = (review: AgentReview, many: boolean) =>
  `The agent review of your PR${many ? 's' : ''} (round ${review.round}) asks for changes:\n${findingLines(review.findings)}\nAddress them: change the code, run tests, push; the review runs again on the new commits. Nothing about them goes to GitHub. If a finding is wrong, say why here and call set_needs_input.`

/** Groomers and developers of a task imported from a tracker: the ticket is context, not a place to write. */
const ticketLine = (task: Task) =>
  task.tracker
    ? `\n\nLinked ticket ${task.tracker.key}${task.tracker.url ? ` (${task.tracker.url})` : ''} — read-only context. Read it any way you have if you need more. Do not change anything in the tracker unless the user asks in chat.`
    : ''

/** An approval may wait for the user for days; the prompt tool call must not time out first. */
const APPROVAL_TOOL_TIMEOUT_MS = String(7 * 24 * 60 * 60 * 1000)

/** A live process with no turn and no background task closes after this; the next message resumes the session. */
const LIVE_IDLE_MS = 10 * 60_000

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.query ?? o.reason ?? o.title ?? o.url
  return v == null ? '' : String(v).slice(0, 120)
}

export class Orchestrator {
  /** One process per turn. */
  private runs = new Map<string, RunHandle>()
  /** Live processes (see liveSession), kept between turns. */
  private lives = new Map<string, { handle: LiveHandle; agent: AgentKind; model: string | null; closing: boolean }>()
  private idleTimers = new Map<string, NodeJS.Timeout>()
  /** Agent reviews going on, by step: what set_review records (null while the PR heads are fetched). */
  private reviewing = new Map<string, { round: number; heads: Record<string, string>; withContext: boolean; startedAt: number } | null>()
  /** The PR heads each step's review last started on: a failed review is not retried on its own (see review). */
  private reviewTried = new Map<string, string>()

  constructor(
    private store: Store,
    private api: LocalApi,
    private paths: Paths,
  ) {}

  /** A turn is going on. */
  isRunning(sessionId: string) {
    return this.runs.has(sessionId) || (this.lives.has(sessionId) && this.store.data.sessions.find((s) => s.id === sessionId)?.status === 'running')
  }

  /** Provider catalogue for the settings UI. */
  async agents(): Promise<AgentInfo[]> {
    return Promise.all(
      (Object.keys(adapters) as AgentKind[]).map(async (id) => {
        const a = adapters[id]
        const [bin, models] = await Promise.all([a.detect(), a.listModels()])
        return { id, displayName: a.displayName, detected: bin !== null, models }
      }),
    )
  }

  /** Read on every run, so a settings change applies to the next turn. The tracker defaults to Claude Code's cheap model. */
  private choice(projectId: string, role: AgentRole): ModelChoice {
    const project = this.store.project(projectId)
    if (role === 'tracker' && !project.agents?.tracker) return { agent: 'claude-code', model: adapters['claude-code'].cheapModel ?? null }
    return resolveChoice(project, role)
  }

  /** Background run that (re)describes the project's architecture. */
  architect(projectId: string) {
    const project = this.store.project(projectId)
    if (project.archRun?.status === 'running') return
    if (!project.repos[0]) throw new Error('Project has no repository')
    const mcpConfigPath = this.mcpConfig(`arch-${projectId}`, { MAG_PROJECT_ID: projectId })
    const run = { status: 'running' as const, startedAt: Date.now(), note: 'Reading the code…' }
    this.store.updateProject(projectId, { archRun: run })
    log.info('agent', 'architect run started', { project: project.name, agent: this.choice(projectId, 'architect').agent })
    const set = (patch: Partial<NonNullable<Project['archRun']>>) =>
      this.store.updateProject(projectId, { archRun: { ...this.store.project(projectId).archRun!, ...patch } })
    let failed = false
    const c = this.choice(projectId, 'architect')
    const handle = adapters[c.agent].start(
      this.withIntegrations(projectId, 'architect', c.agent, false, {
        cwd: project.repos[0],
        model: c.model ?? undefined,
        addDirs: project.repos.slice(1),
        prompt: 'Describe the architecture of this project. Start with get_architecture.',
        appendSystemPrompt: ARCHITECT_PROMPT,
        mcpConfigPath,
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
      }),
      (e) => {
        if (e.type === 'session.started' && e.integrations) this.store.saveIntegrations(e.integrations)
        else if (e.type === 'tool.call') set({ note: `${e.name.replace(/^mcp__mag__/, '')} ${summarize(e.input)}`.trim() })
        else if (e.type === 'message') set({ note: e.text.slice(0, 160) })
        else if (e.type === 'turn.done') set({ costUsd: e.costUsd })
        else if (e.type === 'error') {
          failed = true
          log.warn('agent', `architect run error: ${e.message.slice(0, 300)}`, { project: project.name })
          set({ status: 'error', note: e.message.slice(0, 300) })
        }
      },
    )
    handle.done.then(() => {
      log.info('agent', `architect run ended: ${failed ? 'error' : 'done'}`, { project: project.name })
      if (failed) return
      set({ status: 'done', note: undefined })
      let concerns = 0
      walkArch(this.store.project(projectId).architecture?.modules ?? [], (n) => void (n.concern && concerns++))
      this.store.logEvent({ projectId, taskId: null, taskKey: null, kind: 'architecture', text: `Architecture refreshed · ${concerns} concerns` })
    })
  }

  /** Empty project chat; the first send starts the agent. */
  newChat(projectId: string) {
    this.store.project(projectId)
    return this.store.createSession({ projectId, taskId: null, role: 'chat', agent: this.choice(projectId, 'chat').agent, status: 'idle', title: 'New topic' }).id
  }

  private projectChat(sessionId: string) {
    const session = this.store.session(sessionId)
    if (session.role !== 'chat' || session.taskId) throw new Error(`Session ${sessionId} is not a project topic`)
    return session
  }

  /** The user's title for a topic; the generated title never replaces it. */
  renameChat(sessionId: string, title: string) {
    const session = this.projectChat(sessionId)
    const t = title.replace(/\s+/g, ' ').trim()
    if (!t) throw new Error('A topic needs a title')
    session.title = t
    session.titleGenerated = true
    this.store.changed()
  }

  /** Deletes a topic for good: its turn and live process end first (with their background tasks and approvals). */
  async deleteChat(sessionId: string) {
    const session = this.projectChat(sessionId)
    // The end of the run must not start a title run for a topic that is gone.
    session.titleGenerated = true
    const run = this.runs.get(sessionId)
    run?.kill()
    await Promise.all([run?.done, this.closeLive(sessionId)])
    this.store.deleteSession(sessionId)
    log.info('agent', 'topic deleted', { session: sessionId })
  }

  /** Start (or restart) grooming in a new background session. */
  groom(taskId: string) {
    const task = this.store.task(taskId)
    if (task.parentId) throw new Error(`${task.key} is a subtask; groom its parent task`)
    // A todo task leaves todo while it is groomed again; started work is past grooming.
    if (!['backlog', 'grooming', 'todo'].includes(task.status) || task.work) throw new Error(`${task.key} is ${task.status}; only backlog, grooming or not started todo tasks can be groomed`)
    const session = this.newSession(taskId, 'groomer')
    // The groomer discusses the options and plans: it owns the work from now on (T-55.1).
    this.store.updateTask(taskId, { status: 'grooming', needsInput: null, ownerSessionId: session.id })
    void this.run(session, `Groom task ${task.key}. Start with get_task.`)
  }

  /**
   * Start a todo task (the user's Start) or restart one in progress, on its current step: a todo step gets a worktree +
   * branch from fresh base per repository it changes (see stepRepos) and a new developer session; a step in progress
   * resumes its session.
   * `message`, if given, is what the resumed session is told (shown in its chat). Legacy tasks run as one whole.
   * `localRepos` (the Start popup, T-50): repositories the task's steps work on in the main checkout; restarts and later
   * steps keep the task's. Before a step's first session its local repositories are checked (see prepareLocal).
   */
  async develop(taskId: string, message?: string, localRepos?: string[]) {
    const task = this.store.task(taskId)
    if (task.parentId) throw new Error(`${task.key} is a subtask; develop its task`)
    if (task.status !== 'todo' && task.status !== 'in_progress') throw new Error(`${task.key} is ${task.status}; only todo or in progress tasks are developed`)
    const project = this.store.project(task.projectId)
    if (!project.repos.length) {
      this.store.updateTask(taskId, { needsInput: 'Project has no repository' })
      return
    }
    if (isLegacy(task)) {
      const last = this.lastSession(taskId, 'developer')
      if (last && this.isRunning(last.id)) throw new Error('Developer is still working')
      const dir = task.work?.dir ?? join(this.paths.worktreesDir, project.id, task.key)
      this.store.updateTask(taskId, { status: 'in_progress', needsInput: null, work: this.workFor(task.work, project, dir, `mag/${task.key.toLowerCase()}-${slug(task.title)}`, project.repos) })
      const session = last ?? this.newSession(taskId, 'developer')
      if (!(await this.prepareWorktrees(session))) return
      return this.run(session, `Implement task ${task.key}. Start with get_task and get_doc.`)
    }
    const step = currentStep(taskId, this.store.data.tasks)
    if (!step) throw new Error(`${task.key} has no step to develop; groom it into steps first`)
    const last = this.lastStepSession(step.id)
    if (last && this.isRunning(last.id)) throw new Error('Developer is still working')
    const local = localRepos ? project.repos.filter((r) => localRepos.includes(r)) : (task.localRepos ?? [])
    this.store.updateTask(taskId, { status: 'in_progress', needsInput: null, ...(localRepos && { localRepos: local }) })
    // The user chose Wait: the step starts once the other step lets the repository go (see wakeWaiting).
    if (!last && step.waitingFor && localHolder(step.waitingFor.repo, this.others(step.id))) return
    const dir = step.work?.dir ?? stepDir(this.paths.worktreesDir, project.id, step.key)
    this.store.updateTask(step.id, { status: 'in_progress', waitingFor: null, work: this.workFor(step.work, project, dir, stepBranch(step.key), stepRepos(step, project), local) })
    // Once per step, before its first session: a restart leaves the main checkouts as they are.
    const ready = last ? { discuss: [] } : await this.prepareLocal(step.id)
    if (!ready) return
    const session = last ?? this.newSession(taskId, 'developer', step.id)
    if (!(await this.prepareWorktrees(session))) return
    const intro = `Implement step ${step.key} of ${task.key}. Start with get_task and get_doc.`
    const talk = ready.discuss.length ? `${intro}\n\n${discussText(ready.discuss, project.baseBranch)}` : undefined
    const text = [talk, message].filter(Boolean).join('\n\n')
    if (text) session.items.push({ kind: 'user', text, at: Date.now() })
    return this.run(session, text || intro)
  }

  /** Every task but the step: who else may hold a local repository. */
  private others(stepId: string) {
    return this.store.data.tasks.filter((t) => t.id !== stepId)
  }

  /**
   * What keeps the step from working in `repo`'s main checkout (T-50), null if nothing: another step holds it, or it
   * has uncommitted changes or is on a branch other than base, unless it is on the step's branch already.
   */
  async checkLocal(step: Task, repo: string): Promise<LocalCheck | null> {
    const holder = localHolder(repo, this.others(step.id))
    if (holder) return { repo, busyBy: holder.key, dirty: [], branch: null }
    const branch = await currentBranch(repo)
    if (branch === stepBranch(step.key)) return null
    const dirty = await dirtyFiles(repo)
    const other = branch === this.store.project(step.projectId).baseBranch ? null : branch || 'a detached HEAD'
    return dirty.length || other ? { repo, busyBy: null, dirty, branch: other } : null
  }

  /**
   * The local check before a step's first session: every local repository of the step is checked, then (all clear) put
   * on the step's branch. A problem becomes a question to the user (localChecks, see resolveLocal) and the step does not
   * start: null, like a failed checkout. Repositories the user chose to discuss are left as they are and returned.
   */
  private async prepareLocal(stepId: string): Promise<{ discuss: LocalCheck[] } | null> {
    const step = this.store.task(stepId)
    const project = this.store.project(step.projectId)
    const discuss = (step.localChecks ?? []).filter((c) => c.discuss)
    const local = (step.work?.repos ?? []).filter((r) => r.local && project.repos.includes(r.repo) && !discuss.some((c) => c.repo === r.repo))
    const checks: LocalCheck[] = []
    let r: RepoWork | undefined
    try {
      for (r of local) {
        const check = await this.checkLocal(step, r.repo)
        if (check) checks.push(check)
      }
      if (checks.length) {
        this.askLocal(stepId, [...discuss, ...checks])
        return null
      }
      for (r of local) await checkoutLocal(r.repo, project.baseBranch, r.branch)
    } catch (e) {
      log.error('agent', `local checkout for ${step.key} in ${r?.repo} failed`, e)
      this.store.updateTask(step.parentId!, { needsInput: `Could not check out ${r?.branch} in ${r?.repo}: ${(e as Error).message}` })
      return null
    }
    this.store.updateTask(stepId, { localChecks: [] })
    return { discuss }
  }

  /** Records the step's local checks; the task needs the user while any is open. */
  private askLocal(stepId: string, checks: LocalCheck[]) {
    const step = this.store.task(stepId)
    this.store.updateTask(stepId, { localChecks: checks })
    const open = openLocalChecks({ localChecks: checks })
    const names = open.map((c) => repoDirNames([c.repo])[0])
    this.store.updateTask(step.parentId!, { needsInput: open.length ? `${names.join(', ')}: ${open.length > 1 ? 'need' : 'needs'} your choice` : null })
  }

  /**
   * The user's answer to a local check of a step (T-50). worktree: the repository leaves the task's localRepos and gets
   * a worktree (also the way out of Wait); wait: the step starts once the step holding it is done or canceled; stash,
   * ignore (the files stay, off-limits to the agent) and switch: the main checkout goes on the step's branch now, and a
   * failure comes back on the card; discuss: the developer talks it through with the user first. With no question
   * left, the step starts.
   */
  async resolveLocal(stepId: string, repo: string, choice: LocalChoice): Promise<void> {
    const step = this.store.task(stepId)
    if (!step.parentId || step.status !== 'in_progress' || !step.work) throw new Error(`${step.key} is not a step in progress`)
    const task = this.store.task(step.parentId)
    const project = this.store.project(step.projectId)
    const check = openLocalChecks(step).find((c) => c.repo === repo)
    const waiting = step.waitingFor?.repo === repo
    if (!check && !(waiting && choice === 'worktree')) throw new Error(`${step.key} has no question about ${repo}`)
    if (check && !localOptions(check).includes(choice)) throw new Error(`${choice} is not an answer to ${localCheckText(check, project.baseBranch)}`)
    const r = step.work.repos.find((w) => w.repo === repo)
    if (!r) throw new Error(`${step.key} does not work in ${repo}`)
    const repoPatch = (patch: Partial<RepoWork>) => {
      const work = this.store.task(stepId).work!
      return { ...work, repos: work.repos.map((w) => (w.repo === repo ? { ...w, ...patch } : w)) }
    }
    let patch: Partial<Task> = {}
    if (choice === 'worktree') {
      const local = (task.localRepos ?? []).filter((x) => x !== repo)
      this.store.updateTask(task.id, { localRepos: local })
      const work = this.store.task(stepId).work!
      const rest = { ...work, repos: work.repos.filter((w) => w.repo !== repo) }
      patch = { work: this.workFor(rest, project, work.dir, r.branch, [repo], local), ...(waiting && { waitingFor: null }) }
    } else if (choice === 'wait') patch = { waitingFor: { key: check!.busyBy!, repo } }
    else if (choice !== 'discuss') {
      // Another step may have taken the checkout since the card came up.
      const holder = localHolder(repo, this.others(stepId))
      const failed = (c: LocalCheck) => this.askLocal(stepId, (this.store.task(stepId).localChecks ?? []).map((x) => (x.repo === repo ? c : x)))
      if (holder) return failed({ repo, busyBy: holder.key, dirty: [], branch: null })
      try {
        if (choice === 'stash') await stash(repo, `mag: before ${step.key}`)
        await checkoutLocal(repo, project.baseBranch, r.branch)
      } catch (e) {
        log.warn('agent', `${step.key}: ${choice} in ${repo} failed: ${(e as Error).message}`)
        return failed({ ...check!, error: (e as Error).message })
      }
      if (choice === 'ignore') patch = { work: repoPatch({ foreignFiles: check!.dirty }) }
    }
    log.info('agent', `${step.key}: ${choice} for ${repo}`)
    const checks = (this.store.task(stepId).localChecks ?? []).flatMap((c) =>
      c.repo !== repo ? [c] : choice === 'discuss' ? [{ ...c, discuss: true, error: undefined }] : [],
    )
    this.store.updateTask(stepId, patch)
    this.askLocal(stepId, checks)
    const now = this.store.task(stepId)
    if (openLocalChecks(now).length || now.waitingFor) return
    return this.develop(task.id)
  }

  /** Steps that waited for the given steps (done or canceled now) try to start again; a problem is a new question. */
  private wakeWaiting(keys: string[]) {
    for (const s of this.store.data.tasks.filter((t) => t.parentId && t.status !== 'done' && t.waitingFor && keys.includes(t.waitingFor.key))) {
      const task = this.store.task(s.parentId!)
      if (task.status !== 'in_progress') continue
      log.info('agent', `${s.key}: ${s.waitingFor!.key} let ${s.waitingFor!.repo} go`)
      this.develop(task.id).catch((e) => this.store.updateTask(task.id, { needsInput: `Could not start ${s.key}: ${(e as Error).message}` }))
    }
  }

  /** The tracker agent reads the task's ticket in a new background session and writes the brief (set_brief). */
  importTicket(taskId: string) {
    const task = this.store.task(taskId)
    if (!task.tracker) throw new Error(`${task.key} is not linked to a ticket`)
    if (this.store.data.sessions.some((s) => s.taskId === taskId && this.isRunning(s.id))) throw new Error('An agent is still working on this task')
    const session = this.newSession(taskId, 'tracker')
    void this.run(session, `Import ${task.tracker.key} into ${task.key}. Start with get_import.`)
  }

  /** The user's Start on the task's next step (one that starts manually): it runs as develop does. */
  startStep(taskId: string) {
    const task = this.store.task(taskId)
    if (isLegacy(task) || task.status !== 'in_progress') throw new Error(`${task.key} is ${isLegacy(task) ? 'a legacy task' : task.status}; only steps of a task in progress are started`)
    const step = currentStep(taskId, this.store.data.tasks)
    if (step?.status !== 'todo') throw new Error(`${task.key} has no step waiting for Start${step ? `: ${step.key} is in progress` : ''}`)
    return this.develop(taskId)
  }

  /**
   * A step is done (its PRs merged, or closed by its developer without code). Its worktrees go once its developer is
   * not in a turn (else at the turn's end, see afterRun), after its process; the task is done when every step is, and
   * the architecture refreshes.
   */
  async completeStep(stepId: string) {
    const step = this.store.task(stepId)
    if (!step.parentId) throw new Error(`${step.key} is not a step`)
    this.store.updateTask(stepId, { status: 'done' })
    log.info('agent', `${step.key} done`)
    this.wakeWaiting([step.key])
    const sessions = this.store.data.sessions.filter((s) => s.stepId === stepId)
    if (!sessions.some((s) => this.isRunning(s.id))) {
      await Promise.all(sessions.map((s) => this.closeLive(s.id)))
      await this.removeWork(step.work)
    }
    const task = this.store.task(step.parentId)
    if (currentStep(task.id, this.store.data.tasks)) return
    this.store.updateTask(task.id, { status: 'done', needsInput: null })
    // Merged code changes the architecture; refresh it if the project keeps one.
    if (this.store.project(task.projectId).architecture) {
      try {
        this.architect(task.projectId)
      } catch {}
    }
  }

  /** Removes a task's or step's worktrees, then its dir once empty. A main checkout (local) stays as it is, on its branch. */
  private async removeWork(work: TaskWork | null) {
    if (!work) return
    for (const r of work.repos) if (!r.local) await removeWorktree(r.repo, r.worktree)
    rmdir(work.dir, () => {})
  }

  /**
   * A workspace in `dir`: the existing work, plus a worktree on `branch` for every repository of `repos` it does not
   * cover yet; one of `localRepos` works in its main checkout instead (T-50).
   */
  private workFor(prev: TaskWork | null, project: Project, dir: string, branch: string, repos: string[], localRepos: string[] = []): TaskWork {
    // Before T-22 the task dir was the task's only worktree; nothing else fits in there.
    if (prev?.repos.some((r) => r.worktree === prev.dir)) return prev
    const known = prev?.repos ?? []
    const fresh = repos.filter((r) => project.repos.includes(r) && !known.some((w) => w.repo === r))
    const names = repoDirNames([...known.map((w) => w.repo), ...fresh]).slice(known.length)
    const added = fresh.map((repo, i): RepoWork =>
      localRepos.includes(repo)
        ? { repo, branch, worktree: repo, local: true, prUrl: null, prState: null, checkError: null }
        : { repo, branch, worktree: join(dir, names[i]), prUrl: null, prState: null, checkError: null },
    )
    return { repos: [...known, ...added], dir, feedbackSeenAt: prev?.feedbackSeenAt ?? 0 }
  }

  /**
   * The developer's add_repo (T-50): a project repository (by name or path) the plan left out of the step gets a
   * worktree on the step's branch, mid-step, and joins the step's repos. A repository the step has already is prepared
   * again. Throws, recording nothing, if the worktree fails.
   * A repository the task works on locally (T-50) goes on the step's branch in its main checkout instead, unless
   * `worktree` (the user said so); a local check problem comes back as the error, for the developer to ask the user.
   */
  async addRepo(stepId: string, ref: string, worktree = false): Promise<RepoWork> {
    const step = this.store.task(stepId)
    if (!step.parentId || step.status !== 'in_progress' || !step.work) throw new Error(`${step.key} is not a step in progress`)
    const project = this.store.project(step.projectId)
    const repo = projectRepo(project, ref)
    if (!repo) throw new Error(`${ref} is not a repository of the project; one of ${repoNames(project).join(', ')}`)
    const local = worktree ? [] : (this.store.task(step.parentId).localRepos ?? [])
    // worktree: a repository the step had in its main checkout (not set up, e.g. after Discuss) moves to a worktree.
    const kept = (work: TaskWork) => (worktree ? { ...work, repos: work.repos.filter((w) => !(w.repo === repo && w.local)) } : work)
    const planned = (work: TaskWork) => this.workFor(kept(work), project, work.dir, stepBranch(step.key), [repo], local)
    const r = planned(step.work).repos.find((w) => w.repo === repo)
    if (!r) throw new Error(`${step.key} has no room for another worktree`)
    if (!r.local) await prepareWorktree(repo, project.baseBranch, r.branch, r.worktree)
    else {
      // Also a local repository the step has already: after Discuss, it goes on the step's branch once the user agrees.
      const check = await this.checkLocal(step, repo)
      if (check)
        throw new Error(
          `${localCheckText(check, project.baseBranch)}. The task works on it in the main checkout: ask the user what to do (e.g. they commit or stash, or you call add_repo with worktree: true) and don't touch it before they decide.`,
        )
      await checkoutLocal(repo, project.baseBranch, r.branch)
    }
    // The work may have changed during the git calls (a PR recorded); add to what it is now.
    const now = this.store.task(stepId)
    const repos = now.repos && !now.repos.includes(repo) ? [...now.repos, repo] : now.repos
    this.store.updateTask(stepId, { work: planned(now.work ?? step.work), ...(repos !== now.repos && { repos }) })
    log.info('agent', `${step.key}: ${r.local ? 'main checkout' : 'worktree'} added for ${repo}`)
    return r
  }

  /** What a developer session works on: its step, or a legacy session's task. */
  private ownerOf(session: AgentSession): Task {
    return this.store.task(session.stepId ?? session.taskId!)
  }

  /**
   * (Re)creates the dir and every worktree of the session's step (or legacy task) that is missing; false (and the
   * session in error) if one fails. A step without repositories still gets its dir: the developer's cwd.
   */
  private async prepareWorktrees(session: AgentSession): Promise<boolean> {
    const task = this.store.task(session.taskId!)
    const project = this.store.project(task.projectId)
    const work = this.ownerOf(session).work
    for (const r of work?.repos ?? []) {
      // A main checkout (local) is set up once, before the step's first session (see prepareLocal).
      if (r.local || !project.repos.includes(r.repo) || r.prState === 'merged') continue
      try {
        await prepareWorktree(r.repo, project.baseBranch, r.branch, r.worktree)
      } catch (e) {
        log.error('agent', `worktree for ${task.key} in ${r.repo} failed`, e)
        session.items.push({ kind: 'error', text: `Worktree for ${r.repo} failed: ${(e as Error).message}`, at: Date.now() })
        session.status = 'error'
        this.store.updateTask(task.id, { needsInput: 'Could not create the worktree' })
        return false
      }
    }
    // After the worktrees: a pre-T-22 task's dir is its worktree.
    if (work) mkdirSync(work.dir, { recursive: true })
    return true
  }

  /** New comments on any PR of a step (or a legacy task): resume the developer session of that step with them. */
  feedback(ownerId: string, items: (PrFeedback & { repo: string })[]) {
    const owner = this.store.task(ownerId)
    const taskId = owner.parentId ?? owner.id
    const many = new Set(items.map((f) => f.repo)).size > 1 || (owner.work?.repos.filter((r) => r.prUrl).length ?? 0) > 1
    const text =
      `New feedback on your PR${many ? 's' : ''}:\n` +
      items.map((f) => `- ${many ? `[${f.repo}] ` : ''}@${f.author}${f.where ? ` on ${f.where}` : ''}: ${f.body}`).join('\n') +
      `\nAddress it: change the code, run tests, push. Reply on GitHub (starting with ${AGENT_MARK}) only where a comment needs an answer. If something is unclear, set_needs_input.`
    return this.resumeDeveloper(owner, text)
  }

  /** Resumes the developer session of a step (or a legacy task) with `text`; false while it is in a turn or has none. */
  private resumeDeveloper(owner: Task, text: string) {
    const taskId = owner.parentId ?? owner.id
    const session = owner.parentId ? this.lastStepSession(owner.id) : this.lastSession(taskId, 'developer')
    // During a turn the comments wait for the next poll; a live process between turns gets them as a message.
    if (!session || this.isRunning(session.id)) return false
    session.items.push({ kind: 'user', text, at: Date.now() })
    this.store.updateTask(taskId, { status: 'in_progress' })
    void this.run(session, text)
    return true
  }

  /**
   * The agent review of a step's open PRs (T-55.1), before the user sees them: once per set of PR heads (`heads`, else
   * fetched), never while an agent of the step runs. The step's reviewer session goes on from round to round; its first
   * run forks the work's owner session (Claude Code), which discussed and planned the work, else it starts fresh and
   * reads the doc. The verdict comes back through set_review (see setReview); the end of the run routes it. A review
   * that started on the same heads before and gave no verdict runs again only on `retry` (the user's Restart).
   */
  async review(stepId: string, heads?: Record<string, string>, retry = false) {
    const step = this.store.task(stepId)
    if (!step.parentId || step.status !== 'in_progress' || !step.work) return
    const task = this.store.task(step.parentId)
    if (task.status !== 'in_progress' || task.needsInput) return
    if (this.reviewing.has(stepId) || this.store.data.sessions.some((s) => s.stepId === stepId && this.isRunning(s.id))) return
    // Taken before the first await: the scheduler and the developer's end may both ask.
    this.reviewing.set(stepId, null)
    let now: Record<string, string>
    try {
      now = heads ?? (await this.prHeads(stepId))
    } catch (e) {
      this.reviewing.delete(stepId)
      log.warn('agent', `${step.key}: PR heads for the review failed: ${(e as Error).message}`)
      return
    }
    const fresh = this.store.task(stepId)
    const key = JSON.stringify(now)
    if (!reviewDue(fresh, now) || (!retry && this.reviewTried.get(stepId) === key) || fresh.status !== 'in_progress' || this.store.data.sessions.some((s) => s.stepId === stepId && this.isRunning(s.id))) {
      this.reviewing.delete(stepId)
      return
    }
    let session = this.store.data.sessions.filter((s) => s.stepId === stepId && s.role === 'reviewer').at(-1)
    if (!session) {
      const owner = task.ownerSessionId ? this.store.data.sessions.find((s) => s.id === task.ownerSessionId) : undefined
      session = this.newSession(task.id, 'reviewer', stepId)
      // Only Claude Code forks a session; Codex's resume would write into the owner's own.
      session.forkOf = owner?.agent === 'claude-code' && owner.nativeSessionId ? owner.nativeSessionId : null
    }
    const withContext = !!session.forkOf
    const round = nextReviewRound(fresh.review)
    this.reviewing.set(stepId, { round, heads: now, withContext, startedAt: Date.now() })
    this.reviewTried.set(stepId, key)
    log.info('agent', `${step.key}: agent review round ${round}`, { withContext })
    const text = reviewPrompt(task, fresh, fresh.work!, now, round, withContext)
    session.items.push({ kind: 'user', text, at: Date.now() })
    return this.run(session, text)
  }

  /** The user's Restart of a failed review: the current step's PRs are reviewed again, unless the last review covers them. */
  reviewTask(taskId: string) {
    const step = currentStep(taskId, this.store.data.tasks)
    if (step?.status !== 'in_progress' || !step.work?.repos.some((r) => r.prState === 'open')) throw new Error('No step of this task has an open PR to review')
    return this.review(step.id, undefined, true)
  }

  /** Heads of the step's open PRs from GitHub; recorded on its work too. */
  private async prHeads(stepId: string): Promise<Record<string, string>> {
    const work = this.store.task(stepId).work
    const heads: Record<string, string> = {}
    for (const r of work?.repos ?? []) {
      if (!r.prUrl || r.prState !== 'open') continue
      const pr = await prState(r.prUrl)
      if (pr.state === 'OPEN' && pr.head) heads[r.repo] = pr.head
    }
    const now = this.store.task(stepId).work
    if (now) this.store.updateTask(stepId, { work: { ...now, repos: now.repos.map((r) => (heads[r.repo] ? { ...r, prHead: heads[r.repo] } : r)) } })
    return heads
  }

  /** The reviewer's set_review: records the verdict of the review going on. Where it goes is decided when the run ends. */
  setReview(stepId: string, verdict: ReviewVerdict, findings: ReviewFinding[]): string {
    const pending = this.reviewing.get(stepId)
    const step = this.store.task(stepId)
    if (!pending) throw new Error(`No agent review of ${step.key} is going on`)
    const review: AgentReview = { verdict, findings, round: pending.round, heads: pending.heads, withContext: pending.withContext, at: Date.now() }
    this.store.updateTask(stepId, { review })
    this.store.logEvent({ projectId: step.projectId, taskId: step.parentId, taskKey: step.key, kind: 'review', text: `Agent review: ${verdict}${findings.length ? ` · ${findings.length} finding${findings.length > 1 ? 's' : ''}` : ''}` })
    return reviewOutcome(review) === 'developer'
      ? 'Recorded: the findings go to the developer, and you review again once they push. Stop here.'
      : 'Recorded: the user gets your verdict. Stop here.'
  }

  /** The end of a review run: changes go to the developer while the rounds last; a run without a verdict failed. */
  private afterReview(session: AgentSession) {
    const stepId = session.stepId!
    const pending = this.reviewing.get(stepId)
    this.reviewing.delete(stepId)
    const step = this.store.task(stepId)
    // Canceled during the review: nothing to route.
    if (step.status !== 'in_progress') return
    const review = step.review
    if (!pending || !review || review.at < pending.startedAt) {
      if (session.status !== 'error') {
        session.status = 'error'
        session.items.push({ kind: 'error', text: 'Review ended without a verdict (set_review); check the chat', at: Date.now() })
        this.logSessionEvent(session, 'agent_failed', 'reviewer failed')
        this.store.changed()
      }
      return
    }
    if (reviewOutcome(review) !== 'developer') return
    const many = (step.work?.repos.filter((r) => r.prUrl).length ?? 0) > 1
    // A developer in a turn (the user talks to it) keeps it; the user sees the verdict instead.
    if (!this.resumeDeveloper(step, reviewFeedback(review, many))) log.info('agent', `${step.key}: review findings not sent, the developer is busy`)
  }

  /** A live session takes a message during a turn too: the agent gets it in that turn. */
  async send(sessionId: string, text: string, attachments: Attachment[] = []) {
    const session = this.store.session(sessionId)
    if (this.runs.has(sessionId)) throw new Error('Agent is still working')
    session.items.push({ kind: 'user', text, attachments: attachments.length ? attachments : undefined, at: Date.now() })
    // A topic the user renamed keeps its title.
    if (session.role === 'chat' && !session.titleGenerated && !session.items.some((i, n) => i.kind === 'user' && n < session.items.length - 1))
      session.title = (text || attachments[0]?.name || 'Chat').replace(/\s+/g, ' ').slice(0, 60)
    // A Claude Code slash command goes to the CLI as is; the composer doesn't attach files to one.
    const command = session.agent === 'claude-code' && text.startsWith('/')
    const prompt = attachments.length && !command
      ? `${text}\n\nAttached files (open them with Read):\n${attachments.map((a) => `- ${a.path}`).join('\n')}`
      : text
    if (!session.taskId) {
      this.store.changed()
      return this.run(session, prompt)
    }
    this.store.updateTask(session.taskId, { needsInput: null })
    // A worktree may have failed earlier or been removed: recreate it before resuming.
    if (session.role === 'developer' && this.ownerOf(session).work && !(await this.prepareWorktrees(session))) return
    return this.run(session, prompt)
  }

  /** Stops the current turn. A live process lives on with its background tasks. */
  async stop(sessionId: string) {
    const live = this.lives.get(sessionId)
    if (live && !live.closing) return live.handle.interrupt()
    this.runs.get(sessionId)?.kill()
  }

  /** Stops one background task of a live process; the agent is not woken. The list updates via a `background` event. */
  async stopBackground(sessionId: string, taskId: string) {
    const live = this.lives.get(sessionId)
    if (!live || live.closing) return
    await live.handle.stopTask(taskId)
    // Stopping a task does not wake the agent: a run that waited only for its background tasks is over now.
    const session = this.store.session(sessionId)
    if (session.status !== 'running' && !session.background?.length) void this.afterRun(session)
  }

  /** On quit: live processes would outlive mag and keep waking for their background tasks. */
  shutdown() {
    for (const id of this.lives.keys()) void this.closeLive(id, 0)
  }

  /**
   * Cancel a task not done yet: stop its agents, close their processes (background tasks too), then remove its
   * worktrees. Branches and open PRs stay as they are.
   */
  async cancel(taskId: string, reason: string | null) {
    const task = this.store.task(taskId)
    if (!canCancel(task)) throw new Error(`${task.key} is ${task.status}; it cannot be canceled`)
    const sessions = this.store.data.sessions.filter((s) => s.taskId === taskId)
    const runs = sessions.flatMap((s) => this.runs.get(s.id) ?? [])
    for (const r of runs) r.kill()
    this.store.updateTask(taskId, { status: 'canceled', cancelReason: reason, needsInput: null })
    log.info('agent', `${task.key} canceled`, { reason })
    await Promise.all([...runs.map((r) => r.done), ...sessions.map((s) => this.closeLive(s.id))])
    const steps = subtasksOf(taskId, this.store.data.tasks)
    this.wakeWaiting(steps.map((s) => s.key))
    for (const t of [task, ...steps]) await this.removeWork(t.work)
  }

  private newSession(taskId: string, role: AgentRole, stepId: string | null = null) {
    const projectId = this.store.task(taskId).projectId
    return this.store.createSession({ projectId, taskId, stepId, role, agent: this.choice(projectId, role).agent, status: 'running' })
  }

  private mcpConfig(name: string, env: Record<string, string>) {
    mkdirSync(this.paths.runsDir, { recursive: true })
    const path = join(this.paths.runsDir, `${name}.mcp.json`)
    const server = { command: process.execPath, args: [this.paths.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1', MAG_API: this.api.url, MAG_TOKEN: this.api.token, ...env } }
    writeFileSync(path, JSON.stringify({ mcpServers: { mag: server } }))
    return path
  }

  /** The task's last session of the role outside steps: groomers, a legacy task's developer. */
  private lastSession(taskId: string, role: AgentRole) {
    return this.store.data.sessions.filter((s) => s.taskId === taskId && s.role === role && !s.stepId).at(-1)
  }

  private lastStepSession(stepId: string) {
    return this.store.data.sessions.filter((s) => s.stepId === stepId && s.role === 'developer').at(-1)
  }

  private spec(session: AgentSession): Omit<RunSpec, 'prompt'> {
    const project = this.store.project(session.projectId)
    const [first = homedir(), ...rest] = project.repos
    const arch = project.enforceArchitecture ? `\n\n${ARCH_RULES}` : ''
    if (session.role === 'chat' || !session.taskId) {
      return {
        cwd: first,
        addDirs: [...rest, this.paths.attachmentsDir, this.paths.logsDir],
        appendSystemPrompt: chatPrompt(project, this.paths.logsDir) + (project.notes ? `\n\nProject notes:\n${project.notes}` : '') + arch,
        // Bash reads tickets through CLIs like acli (T-37); read only by the prompt.
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      }
    }
    const task = this.store.task(session.taskId)
    if (session.role === 'tracker') {
      return {
        cwd: this.paths.runsDir, // no code: nothing of the repos to read
        appendSystemPrompt: task.tracker ? trackerPrompt(task.tracker) : '',
        // The user's Claude Code environment: Bash for CLIs like acli, every integration (see withIntegrations).
        allowedTools: ['mcp__mag', 'Bash'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      }
    }
    const owner = this.ownerOf(session)
    if (session.role === 'reviewer') {
      const work = owner.work
      return {
        cwd: work?.dir ?? first,
        addDirs: work ? project.repos : rest,
        // A fork keeps the owner's system prompt; this one is for a fresh reviewer. The job itself is in the message.
        appendSystemPrompt:
          `You are the first reviewer of a step's PRs in "mag", before the user. You never change code.` +
          (project.notes ? `\n\nProject notes:\n${project.notes}` : '') +
          arch,
        // Bash for gh pr view / diff and git; read only by the prompt.
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      }
    }
    if (session.role === 'developer' && owner.work) {
      const work = owner.work
      return {
        cwd: work.dir,
        // Repositories without a worktree (not in the step's repos, or a pre-T-22 task) stay readable from their main
        // checkout; the step works in its local ones there.
        addDirs: [...project.repos.filter((r) => !work.repos.some((w) => w.repo === r && w.worktree !== r)), this.paths.attachmentsDir],
        appendSystemPrompt:
          (owner.parentId ? stepPrompt(project, task, owner, work) : developerPrompt(project, task, work, subtasksOf(task.id, this.store.data.tasks).length > 0)) +
          ticketLine(task) +
          (project.enforceArchitecture
            ? `\n\n${ARCH_RULES}\nBefore opening the PR, call check_architecture and fix every violation; mention warnings in the PR body.`
            : ''),
        allowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'LS', 'Bash', 'Skill', 'mcp__mag'],
      }
    }
    return {
      cwd: first,
      addDirs: [...rest, this.paths.attachmentsDir],
      appendSystemPrompt:
        GROOMER_PROMPT +
        ticketLine(task) +
        (project.enforceArchitecture
          ? `\n\n${ARCH_RULES}\nCall get_architecture for the recorded design and check_architecture for rule checks on the code. In the doc, design changes per layer: infra first if it changes, then clients and services with their interfaces (signatures + semantics), then the app layer.`
          : ''),
      allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Skill', 'mcp__mag'],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
    }
  }

  /**
   * Claude Code runs: integrations the role has on auto are allowed, off ones disallowed, ask ones go through the
   * approve_tool prompt. Without a chat to ask in (`canAsk` false) ask counts as off. The tracker gets every
   * integration whatever the modes: it reads the ticket any way it has (T-37). Codex has no integrations.
   */
  private withIntegrations<S extends Omit<RunSpec, 'prompt'>>(projectId: string, role: AgentRole, agent: AgentKind, canAsk: boolean, spec: S): S {
    if (agent !== 'claude-code') return spec
    const known = this.store.data.integrations.filter((i) => i.id !== MAG_MCP_ID)
    if (role === 'tracker') return { ...spec, allowedTools: [...(spec.allowedTools ?? []), ...known.map((i) => `mcp__${i.id}`)] }
    const rules = integrationRules(this.store.project(projectId), role, known)
    const ask = canAsk ? rules.ask : []
    return {
      ...spec,
      allowedTools: [...(spec.allowedTools ?? []), ...rules.allowed],
      disallowedTools: [...(spec.disallowedTools ?? []), ...rules.disallowed, ...(canAsk ? [] : rules.ask)],
      ...(ask.length && { permissionPromptTool: APPROVE_TOOL, env: { ...spec.env, MCP_TOOL_TIMEOUT: APPROVAL_TOOL_TIMEOUT_MS } }),
    }
  }

  /** A turn of the session: on its live process (see liveSession), or on a process of its own. */
  private async run(session: AgentSession, prompt: string) {
    // The agent the session runs on next decides; a live process of an agent without them goes first.
    if (liveSession({ role: session.role, agent: this.choice(session.projectId, session.role).agent })) return this.runLive(session, prompt)
    if (this.lives.has(session.id)) await this.closeLive(session.id)
    this.runOnce(session, prompt)
  }

  /** One process for this turn; the run ends when it exits. */
  private runOnce(session: AgentSession, prompt: string) {
    const env: Record<string, string> = { MAG_PROJECT_ID: session.projectId, MAG_SESSION_ID: session.id, MAG_ROLE: session.role }
    if (session.taskId) env.MAG_TASK_ID = session.taskId
    const mcpConfigPath = this.mcpConfig(session.id, env)

    const c = this.choice(session.projectId, session.role)
    if (c.agent !== session.agent) {
      // Native sessions can't move between providers; the next run starts fresh.
      session.agent = c.agent
      session.nativeSessionId = null
    }

    const startedAt = Date.now()
    session.status = 'running'
    session.runStartedAt = startedAt
    this.store.changed()
    this.logSessionEvent(session, 'agent_started', `${session.role} started`)
    const who = { session: session.id, role: session.role, task: session.taskId ? this.store.data.tasks.find((t) => t.id === session.taskId)?.key : undefined, agent: session.agent, model: c.model }
    log.info('agent', `${session.role} run started`, who)

    const onEvent = this.onEvent(session)

    const spec = this.withIntegrations(session.projectId, session.role, session.agent, true, this.spec(session))
    // A reviewer's first run forks the owner session; later runs resume the fork.
    const fork = !session.nativeSessionId && !!session.forkOf && session.agent === 'claude-code'
    const resumeId = session.nativeSessionId ?? (fork ? session.forkOf! : undefined)
    const handle = adapters[session.agent].start(
      { ...spec, prompt, model: c.model ?? undefined, resumeId, forkSession: fork, mcpConfigPath },
      onEvent,
    )
    this.runs.set(session.id, handle)
    handle.done.then(() => {
      this.runs.delete(session.id)
      if (session.status === 'running') session.status = 'idle'
      log.info('agent', `${session.role} run ended: ${session.status}`, { ...who, seconds: Math.round((Date.now() - startedAt) / 1000) })
      if (session.status === 'error') this.logSessionEvent(session, 'agent_failed', `${session.role} failed`)
      void this.afterRun(session)
      this.nameChat(session)
      this.store.changed()
    })
  }

  /** Session state and chat items from agent events, for both kinds of runs. */
  private onEvent(session: AgentSession) {
    const push = (item: ChatItem) => {
      session.items.push(item)
      this.store.changed()
    }
    return (e: AgentEvent) => {
      const at = Date.now()
      switch (e.type) {
        case 'session.started':
          session.nativeSessionId = e.nativeSessionId
          if (e.model) session.activeModel = e.model
          if (e.commands) session.commands = e.commands
          if (e.integrations) this.store.saveIntegrations(e.integrations)
          return this.store.changed()
        case 'message':
          return push({ kind: 'assistant', text: e.text, at })
        case 'tool.call':
          return push({ kind: 'tool', id: e.id, name: e.name.replace(/^mcp__mag__/, 'mag.'), summary: summarize(e.input), at })
        case 'tool.result': {
          const item = session.items.find((i) => i.kind === 'tool' && i.id === e.id)
          if (item && item.kind === 'tool') item.ok = e.ok
          return this.store.changed()
        }
        case 'context.compacted':
          return push({ kind: 'notice', text: `Context compacted${e.preTokens ? ` (was ≈${Math.round(e.preTokens / 1000)}k tokens)` : ''}`, at })
        case 'turn.done':
          if (e.nativeSessionId) session.nativeSessionId = e.nativeSessionId
          return push({ kind: 'result', ok: e.ok, costUsd: e.costUsd, at })
        case 'error':
          session.status = 'error'
          log.warn('agent', `${session.role} run error: ${e.message.slice(0, 300)}`, { session: session.id })
          return push({ kind: 'error', text: e.message, at })
        case 'stopped':
          return push({ kind: 'notice', text: 'Stopped', at })
      }
    }
  }

  /**
   * A live session's message (T-40): opens the process if there is none (resuming the agent's session) and writes the
   * message to it. During a turn the message joins that turn. The turn ends at its result, not at the process exit.
   */
  private async runLive(session: AgentSession, prompt: string) {
    this.clearIdle(session.id)
    const c = this.choice(session.projectId, session.role)
    let live = this.lives.get(session.id)
    // A new session is created running before its first turn: only a live process can be in a turn.
    const inTurn = !!live && !live.closing && session.status === 'running'
    // A new model or agent applies between turns. One process at a time per native session: a closing one goes first.
    if (live && !inTurn && (live.agent !== c.agent || live.model !== c.model)) void this.closeLive(session.id)
    if (live?.closing) {
      await live.handle.done
      live = this.lives.get(session.id)
    }
    if (!live) live = this.openLive(session, c)
    if (!inTurn) this.turnStarted(session, true)
    live.handle.send(prompt)
  }

  private openLive(session: AgentSession, c: ModelChoice) {
    const adapter = adapters[c.agent]
    if (!adapter.open) throw new Error(`${adapter.displayName} has no live sessions`)
    if (c.agent !== session.agent) {
      session.agent = c.agent
      session.nativeSessionId = null
    }
    const env: Record<string, string> = { MAG_PROJECT_ID: session.projectId, MAG_SESSION_ID: session.id, MAG_ROLE: session.role }
    if (session.taskId) env.MAG_TASK_ID = session.taskId
    const mcpConfigPath = this.mcpConfig(session.id, env)
    const spec = this.withIntegrations(session.projectId, session.role, session.agent, true, this.spec(session))
    const who = { session: session.id, role: session.role, agent: session.agent, model: c.model }
    const openedAt = Date.now()
    log.info('agent', `${session.role} live process opened`, { ...who, resume: !!session.nativeSessionId })

    const onEvent = this.onEvent(session)
    const handle = adapter.open({ ...spec, model: c.model ?? undefined, resumeId: session.nativeSessionId ?? undefined, mcpConfigPath }, (e) => {
      if (e.type === 'stopped' && session.status !== 'running') return // an idle close says nothing in the chat
      onEvent(e)
      if (e.type === 'turn.started') this.turnStarted(session)
      else if (e.type === 'background') {
        session.background = e.tasks
        if (e.tasks.length) this.clearIdle(session.id)
        else this.armIdle(session)
        this.store.changed()
      } else if (e.type === 'turn.done') this.turnEnded(session)
    })
    const live = { handle, agent: c.agent, model: c.model, closing: false }
    this.lives.set(session.id, live)
    session.live = true
    this.store.changed()
    handle.done.then(() => {
      if (this.lives.get(session.id) === live) this.lives.delete(session.id)
      this.clearIdle(session.id)
      session.live = false
      const waited = !!session.background?.length
      if (waited) session.items.push({ kind: 'notice', text: 'Background tasks ended with the process', at: Date.now() })
      session.background = undefined
      // Exited mid-turn (a crash, or our close): the turn is over too. A run that waited for background tasks is over
      // with the process. Whoever closed it (cancel, a done step, quit) has dealt with the task already.
      if (session.status === 'running') this.turnEnded(session, !live.closing)
      else if (waited && !live.closing) void this.afterRun(session)
      log.info('agent', `${session.role} live process closed: ${session.status}`, { ...who, seconds: Math.round((Date.now() - openedAt) / 1000) })
      this.store.changed()
    })
    return live
  }

  /** A turn of a live session began: our message (`ours`), or a background task woke the agent. */
  private turnStarted(session: AgentSession, ours = false) {
    this.clearIdle(session.id)
    if (session.status === 'running' && !ours) return
    session.status = 'running'
    session.runStartedAt = Date.now()
    this.store.changed()
    if (ours) this.logSessionEvent(session, 'agent_started', `${session.role} started`)
    log.info('agent', `${session.role} turn started`, { session: session.id, by: ours ? 'message' : 'wake-up' })
  }

  /** A turn of a live session ended at its result; the process stays for the next one. `check`: run afterRun. */
  private turnEnded(session: AgentSession, check = true) {
    if (session.status === 'running') session.status = 'idle'
    log.info('agent', `${session.role} turn ended: ${session.status}`, { session: session.id, seconds: Math.round((Date.now() - (session.runStartedAt ?? Date.now())) / 1000) })
    if (session.status === 'error') this.logSessionEvent(session, 'agent_failed', `${session.role} failed`)
    if (check) void this.afterRun(session)
    this.nameChat(session)
    this.armIdle(session)
    this.store.changed()
  }

  /** Close the live process after LIVE_IDLE_MS without a turn or a background task. */
  private armIdle(session: AgentSession) {
    this.clearIdle(session.id)
    if (!this.lives.has(session.id) || session.status === 'running' || session.background?.length) return
    const timer = setTimeout(() => {
      this.idleTimers.delete(session.id)
      void this.closeLive(session.id)
    }, LIVE_IDLE_MS)
    timer.unref()
    this.idleTimers.set(session.id, timer)
  }

  private clearIdle(sessionId: string) {
    clearTimeout(this.idleTimers.get(sessionId))
    this.idleTimers.delete(sessionId)
  }

  /** Closes the session's live process (if any); resolves once it has exited. */
  private closeLive(sessionId: string, graceMs?: number): Promise<void> {
    const live = this.lives.get(sessionId)
    if (!live) return Promise.resolve()
    if (!live.closing) {
      live.closing = true
      log.info('agent', 'live process closing', { session: sessionId })
      live.handle.close(graceMs)
    }
    return live.handle.done
  }

  /** After a chat's first turn: a short generated title in place of the first message. Once; a failure keeps the old title. */
  private nameChat(session: AgentSession) {
    if (session.role !== 'chat' || session.titleGenerated || session.status === 'error') return
    const first = session.items.find((i) => i.kind === 'user')
    const reply = session.items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : [])).join('\n\n')
    if (first?.kind !== 'user' || !reply) return
    session.titleGenerated = true
    const adapter = adapters[session.agent]
    let text = ''
    let failed = false
    const handle = adapter.start(
      {
        cwd: this.paths.runsDir, // neutral: no repo instructions to load
        prompt: titlePrompt(first.text || first.attachments?.[0]?.name || '', reply),
        model: adapter.cheapModel,
        noTools: true,
      },
      (e) => {
        if (e.type === 'message') text += e.text
        else if (e.type === 'error' || (e.type === 'turn.done' && !e.ok)) failed = true
      },
    )
    handle.done.then(() => {
      const title = failed ? null : cleanTitle(text)
      if (title) session.title = title
      this.store.changed()
    })
  }

  /** Task sessions only: project chats stay out of the log. */
  private logSessionEvent(session: AgentSession, kind: 'agent_started' | 'agent_failed', text: string) {
    if (!session.taskId) return
    const task = this.store.data.tasks.find((t) => t.id === session.taskId)
    this.store.logEvent({ projectId: session.projectId, taskId: session.taskId, taskKey: task?.key ?? null, kind, text })
  }

  /** Make sure a finished run (or turn of a live session) never leaves a task silently stuck. */
  private async afterRun(session: AgentSession) {
    if (!session.taskId) return
    const task = this.store.task(session.taskId)
    // A step closed or merged during the run: its worktrees could not go while the run was on. Its process goes first.
    if (session.stepId && this.ownerOf(session).status === 'done') {
      this.reviewing.delete(session.stepId)
      await this.closeLive(session.id)
      return this.removeWork(this.ownerOf(session).work)
    }
    if (session.role === 'reviewer') return this.afterReview(session)
    if (task.needsInput) return
    // A background task will wake the agent again: the run is not over yet.
    if (session.background?.length) return
    // An import that ended without a brief failed: the inbox says so (see inbox).
    if (session.role === 'tracker' && session.status !== 'error' && task.tracker && !task.tracker.importedAt) {
      session.status = 'error'
      session.items.push({ kind: 'error', text: 'Import ended without a brief; check the chat', at: Date.now() })
      this.logSessionEvent(session, 'agent_failed', 'tracker failed')
      this.store.changed()
      return
    }
    const failed = session.status === 'error'
    if (session.role === 'groomer' && task.status === 'grooming') {
      if (failed) this.store.updateTask(task.id, { status: 'backlog' })
      else this.store.updateTask(task.id, { needsInput: 'Groomer stopped without finishing; check the chat' })
    }
    if (session.role === 'developer' && task.status === 'in_progress') {
      const work = this.ownerOf(session).work
      const changed = work?.repos.some((r) => r.prUrl) ? await changedRepos(work, this.store.project(task.projectId).baseBranch) : []
      const now = this.store.task(task.id)
      if (now.status !== 'in_progress' || now.needsInput || this.isRunning(session.id) || session.background?.length || this.ownerOf(session).status === 'done') return
      const outcome = devRunOutcome(work, changed, failed, !!session.stepId)
      // Every PR merged, maybe while the run was on: the step is done. A legacy task finishes on the scheduler's poll.
      if (outcome.kind === 'complete') return session.stepId ? this.completeStep(session.stepId) : undefined
      // Every changed repo has a PR: the agent review comes first, then the user merges.
      if (outcome.kind === 'review') return session.stepId ? this.review(session.stepId) : undefined
      this.store.updateTask(task.id, { needsInput: outcome.reason })
    }
  }
}
