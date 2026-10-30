import { mkdirSync, rmdir, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { canCancel, cleanTitle, integrationRules, prRollup, repoDirNames, repoWorkName, resolveChoice, subtasksOf, titlePrompt, type AgentEvent, type AgentInfo, type AgentKind, type AgentRole, type AgentSession, type Attachment, type ChatItem, type ModelChoice, type Project, type Task, type TaskWork } from '@mag/core'
import { adapters, type RunHandle, type RunSpec } from '@mag/agents'
import { ARCH_RULES } from '@mag/arch'
import type { Store } from './store'
import type { LocalApi } from './api'
import { AGENT_MARK, changedRepos, prepareWorktree, removeWorktree, slug, type PrFeedback } from './git'
import { APPROVE_TOOL } from './tool-defs'
import { log } from './log'

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
3. If something only the user can decide is unclear, list it under "Open questions" in the doc
   and call set_needs_input with a one-line summary. Then stop and wait. Ask everything at once, at the task
   level; subtasks never get questions of their own.
4. When the user answers in chat, update the doc (remove answered questions, fold answers in).
5. For design work or UI changes, show mockups or diagrams with show_canvas (kept with the task) and reference them in the doc
   as a link [title](canvas:<id>), using the id show_canvas returned; the app renders the canvas in place. Diagrams in
   the doc itself can be \`\`\`mermaid blocks.
6. One developer session does the whole task, with one PR per changed repository. For a task with several
   steps, add them with create_subtask: a short checklist of the plan (title plus an optional one-line note), in
   order. Subtasks have no doc, agent or PR of their own; the developer marks their progress. The task doc carries the
   details. When re-grooming, change the existing subtasks with update_subtask / delete_subtask /
   reorder_subtasks instead of creating duplicates (get_task lists them).
7. When no open questions remain and the plan is ready: set_needs_input(null), then mark_groomed. The task then is in
   todo, ready for the user to start.
Stay within the brief: do not add work nobody asked for. An idea outside it goes to the user as a question,
not into the doc or a subtask.
Never edit code. Keep chat replies to one or two sentences; the doc carries the detail.`

const developerPrompt = (project: Project, task: Task, work: TaskWork, checklist: boolean) => {
  const repos = work.repos.map((r) => `- ${repoWorkName(work, r)}: ${r.worktree} (branch ${r.branch}${r.prUrl ? `, PR ${r.prUrl}` : ''})`)
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
1. Find the apps (packages, entrypoints). Skim structure first (Glob), then read the key files.
2. Choose nodes at the granularity a human designs at: one node per real responsibility, not per file. Usually
   5-20 per app. Classify by what the code does, not by folder names; the code may not follow the pattern.
3. For services and clients, write the public interface as short lines "method(args): Result - what it does".
4. uses = real dependencies between nodes. If something breaks the rules or mixes layers, say so in concern.
5. Keep ids stable if get_architecture shows a previous version and the module still exists.
Call get_architecture first, then set_architecture once with the full picture. Be concise everywhere.`

const chatPrompt = (project: Project, logsDir: string) => `You are the user's partner for project "${project.name}" in "mag",
a task-centric workspace. This is a free conversation about the project: ideas, product and design decisions,
architecture, priorities, reviewing what agents did. You can read the code (read-only) and the web.
How mag works: backlog task -> grooming: the groomer agent writes the task doc, asks questions and may split it
into subtasks (a checklist of the plan) -> todo: groomed and ready to work; the order of todo tasks is only the user's
priority -> in progress: the user starts a todo task with Start, and one developer agent implements the whole task,
with a worktree per repository and one PR per changed repository -> done when the user has merged every PR. Nothing
starts on its own; any number of tasks can be in progress in parallel, one developer each. Any task not done yet can
be canceled. Done and canceled tasks can be archived; mag archives them after some days.
- You never change code. A change becomes a task: create_task with a concise brief (what and why), and
  start_grooming if the user wants it moving. Check list_tasks first to avoid duplicates.
- If a task is already fully discussed here and the user asks to get it done, skip grooming: create_task with
  a complete doc (Problem / Changes per layer / Plan, following the project's doc template) and plan: true.
  It goes to todo and starts nothing: the user starts it with Start. Anything that needs splitting into
  subtasks or still has open questions goes to the backlog and through start_grooming instead.
- Record outcomes so they outlive this chat: decisions and conventions in update_notes, plan changes in
  update_task / update_task_doc. Say in one line what you recorded.
- cancel_task only after the user has said yes to canceling that task; archive_task when they ask to clean up.
- For anything visual (UI mockups, flows, diagrams, comparisons) use show_canvas with one self-contained HTML page;
  revise it by id instead of drawing a new one. Prefer showing over describing.
- Refer to tasks by key (T-12, subtask T-12.3); the app turns keys into links.
- Be concise: short answers, markdown only where it helps. The user hates filler.
- mag logs and crash reports are in ${logsDir} (main-<date>.log: JSON lines; crashes/<time>-<kind>.json: one per
  crash; crashes/native: minidumps). Read them when the user reports a crash or asks about the latest one.`

/** An approval may wait for the user for days; the prompt tool call must not time out first. */
const APPROVAL_TOOL_TIMEOUT_MS = String(7 * 24 * 60 * 60 * 1000)

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.query ?? o.reason ?? o.title ?? o.url
  return v == null ? '' : String(v).slice(0, 120)
}

export class Orchestrator {
  private runs = new Map<string, RunHandle>()

  constructor(
    private store: Store,
    private api: LocalApi,
    private paths: Paths,
  ) {}

  isRunning(sessionId: string) {
    return this.runs.has(sessionId)
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

  /** Read on every run, so a settings change applies to the next turn. */
  private choice(projectId: string, role: AgentRole): ModelChoice {
    return resolveChoice(this.store.project(projectId), role)
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
      const concerns = (this.store.project(projectId).architecture?.apps ?? []).flatMap((a) => a.nodes).filter((n) => n.concern).length
      this.store.logEvent({ projectId, taskId: null, taskKey: null, kind: 'architecture', text: `Architecture refreshed · ${concerns} concerns` })
    })
  }

  /** Empty project chat; the first send starts the agent. */
  newChat(projectId: string) {
    this.store.project(projectId)
    return this.store.createSession({ projectId, taskId: null, role: 'chat', agent: this.choice(projectId, 'chat').agent, status: 'idle', title: 'New chat' }).id
  }

  /** Start (or restart) grooming in a new background session. */
  groom(taskId: string) {
    const task = this.store.task(taskId)
    if (task.parentId) throw new Error(`${task.key} is a subtask; groom its parent task`)
    // A todo task leaves todo while it is groomed again; started work is past grooming.
    if (!['backlog', 'grooming', 'todo'].includes(task.status) || task.work) throw new Error(`${task.key} is ${task.status}; only backlog, grooming or not started todo tasks can be groomed`)
    const session = this.newSession(taskId, 'groomer')
    this.store.updateTask(taskId, { status: 'grooming', needsInput: null })
    this.run(session, `Groom task ${task.key}. Start with get_task.`)
  }

  /** Start a todo task (the user's Start) or restart one in progress: a worktree + branch per repository, then its developer session (the same one on a restart). */
  async develop(taskId: string) {
    const task = this.store.task(taskId)
    if (task.parentId) throw new Error(`${task.key} is a subtask; develop its task`)
    if (task.status !== 'todo' && task.status !== 'in_progress') throw new Error(`${task.key} is ${task.status}; only todo or in progress tasks are developed`)
    const project = this.store.project(task.projectId)
    if (!project.repos.length) {
      this.store.updateTask(taskId, { needsInput: 'Project has no repository' })
      return
    }
    const last = this.lastSession(taskId, 'developer')
    if (last && this.runs.has(last.id)) throw new Error('Developer is still working')
    this.store.updateTask(taskId, { status: 'in_progress', needsInput: null, work: this.workFor(task, project) })
    const session = last ?? this.newSession(taskId, 'developer')
    if (!(await this.prepareWorktrees(session))) return
    this.run(session, `Implement task ${task.key}. Start with get_task and get_doc.`)
  }

  /** The task's workspace: its existing work, plus a worktree for every project repository it does not cover yet. */
  private workFor(task: Task, project: Project): TaskWork {
    const prev = task.work
    // Before T-22 the task dir was the task's only worktree; nothing else fits in there.
    if (prev?.repos.some((r) => r.worktree === prev.dir)) return prev
    const dir = prev?.dir ?? join(this.paths.worktreesDir, project.id, task.key)
    const branch = `mag/${task.key.toLowerCase()}-${slug(task.title)}`
    const known = prev?.repos ?? []
    const fresh = project.repos.filter((r) => !known.some((w) => w.repo === r))
    const names = repoDirNames([...known.map((w) => w.repo), ...fresh]).slice(known.length)
    const added = fresh.map((repo, i) => ({ repo, branch, worktree: join(dir, names[i]), prUrl: null, prState: null, checkError: null }))
    return { repos: [...known, ...added], dir, feedbackSeenAt: prev?.feedbackSeenAt ?? 0 }
  }

  /** (Re)creates every worktree of the session's task that is missing; false (and the session in error) if one fails. */
  private async prepareWorktrees(session: AgentSession): Promise<boolean> {
    const task = this.store.task(session.taskId!)
    const project = this.store.project(task.projectId)
    for (const r of task.work?.repos ?? []) {
      if (!project.repos.includes(r.repo) || r.prState === 'merged') continue
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
    return true
  }

  /** New comments on any of the task's PRs: resume its developer session with them. */
  feedback(taskId: string, items: (PrFeedback & { repo: string })[]) {
    const session = this.lastSession(taskId, 'developer')
    if (!session || this.runs.has(session.id)) return false
    const many = new Set(items.map((f) => f.repo)).size > 1 || (this.store.task(taskId).work?.repos.filter((r) => r.prUrl).length ?? 0) > 1
    const text =
      `New feedback on your PR${many ? 's' : ''}:\n` +
      items.map((f) => `- ${many ? `[${f.repo}] ` : ''}@${f.author}${f.where ? ` on ${f.where}` : ''}: ${f.body}`).join('\n') +
      `\nAddress it: change the code, run tests, push. Reply on GitHub (starting with ${AGENT_MARK}) only where a comment needs an answer. If something is unclear, set_needs_input.`
    session.items.push({ kind: 'user', text, at: Date.now() })
    this.store.updateTask(taskId, { status: 'in_progress' })
    this.run(session, text)
    return true
  }

  async send(sessionId: string, text: string, attachments: Attachment[] = []) {
    const session = this.store.session(sessionId)
    if (this.runs.has(sessionId)) throw new Error('Agent is still working')
    session.items.push({ kind: 'user', text, attachments: attachments.length ? attachments : undefined, at: Date.now() })
    if (session.role === 'chat' && !session.items.some((i, n) => i.kind === 'user' && n < session.items.length - 1))
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
    const task = this.store.task(session.taskId)
    // A worktree may have failed earlier or been removed: recreate it before resuming.
    if (session.role === 'developer' && task.work && !(await this.prepareWorktrees(session))) return
    this.run(session, prompt)
  }

  stop(sessionId: string) {
    this.runs.get(sessionId)?.kill()
  }

  /** Cancel a task not done yet: stop its agents and remove its worktrees. Branches and open PRs stay as they are. */
  async cancel(taskId: string, reason: string | null) {
    const task = this.store.task(taskId)
    if (!canCancel(task)) throw new Error(`${task.key} is ${task.status}; it cannot be canceled`)
    for (const s of this.store.data.sessions) if (s.taskId === taskId) this.stop(s.id)
    this.store.updateTask(taskId, { status: 'canceled', cancelReason: reason, needsInput: null })
    log.info('agent', `${task.key} canceled`, { reason })
    const work = task.work
    if (!work) return
    for (const r of work.repos) await removeWorktree(r.repo, r.worktree)
    // Only removes the task dir once it is empty.
    rmdir(work.dir, () => {})
  }

  private newSession(taskId: string, role: AgentRole) {
    const projectId = this.store.task(taskId).projectId
    return this.store.createSession({ projectId, taskId, role, agent: this.choice(projectId, role).agent, status: 'running' })
  }

  private mcpConfig(name: string, env: Record<string, string>) {
    mkdirSync(this.paths.runsDir, { recursive: true })
    const path = join(this.paths.runsDir, `${name}.mcp.json`)
    const server = { command: process.execPath, args: [this.paths.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1', MAG_API: this.api.url, MAG_TOKEN: this.api.token, ...env } }
    writeFileSync(path, JSON.stringify({ mcpServers: { mag: server } }))
    return path
  }

  private lastSession(taskId: string, role: AgentRole) {
    return this.store.data.sessions.filter((s) => s.taskId === taskId && s.role === role).at(-1)
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
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
      }
    }
    const task = this.store.task(session.taskId)
    if (session.role === 'developer' && task.work) {
      const work = task.work
      return {
        cwd: work.dir,
        // Repositories without a worktree in the task (pre-T-22 tasks) stay readable from their main checkout.
        addDirs: [...project.repos.filter((r) => !work.repos.some((w) => w.repo === r)), this.paths.attachmentsDir],
        appendSystemPrompt:
          developerPrompt(project, task, work, subtasksOf(task.id, this.store.data.tasks).length > 0) +
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
        (project.enforceArchitecture
          ? `\n\n${ARCH_RULES}\nCall get_architecture for the recorded design and check_architecture for rule checks on the code. In the doc, design changes per layer: infra first if it changes, then clients and services with their interfaces (signatures + semantics), then the app layer.`
          : ''),
      allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Skill', 'mcp__mag'],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
    }
  }

  /**
   * Claude Code runs: integrations the role has on auto are allowed, off ones disallowed, ask ones go through the
   * approve_tool prompt. Without a chat to ask in (`canAsk` false) ask counts as off. Codex has no integrations.
   */
  private withIntegrations<S extends Omit<RunSpec, 'prompt'>>(projectId: string, role: AgentRole, agent: AgentKind, canAsk: boolean, spec: S): S {
    if (agent !== 'claude-code') return spec
    const rules = integrationRules(this.store.project(projectId), role, this.store.data.integrations)
    const ask = canAsk ? rules.ask : []
    return {
      ...spec,
      allowedTools: [...(spec.allowedTools ?? []), ...rules.allowed],
      disallowedTools: [...(spec.disallowedTools ?? []), ...rules.disallowed, ...(canAsk ? [] : rules.ask)],
      ...(ask.length && { permissionPromptTool: APPROVE_TOOL, env: { ...spec.env, MCP_TOOL_TIMEOUT: APPROVAL_TOOL_TIMEOUT_MS } }),
    }
  }

  private run(session: AgentSession, prompt: string) {
    const env: Record<string, string> = { MAG_PROJECT_ID: session.projectId, MAG_SESSION_ID: session.id }
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

    const push = (item: ChatItem) => {
      session.items.push(item)
      this.store.changed()
    }

    const onEvent = (e: AgentEvent) => {
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
      }
    }

    const spec = this.withIntegrations(session.projectId, session.role, session.agent, true, this.spec(session))
    const handle = adapters[session.agent].start(
      { ...spec, prompt, model: c.model ?? undefined, resumeId: session.nativeSessionId ?? undefined, mcpConfigPath },
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

  /** Make sure a finished run never leaves a task silently stuck. */
  private async afterRun(session: AgentSession) {
    if (!session.taskId) return
    const task = this.store.task(session.taskId)
    if (task.needsInput) return
    const failed = session.status === 'error'
    if (session.role === 'groomer' && task.status === 'grooming') {
      if (failed) this.store.updateTask(task.id, { status: 'backlog' })
      else this.store.updateTask(task.id, { needsInput: 'Groomer stopped without finishing; check the chat' })
    }
    if (session.role === 'developer' && task.status === 'in_progress') {
      if (failed || !task.work?.repos.some((r) => r.prUrl)) {
        this.store.updateTask(task.id, { needsInput: failed ? 'Developer agent failed; check the chat' : 'Developer stopped without opening a PR' })
        return
      }
      const work = task.work
      const changed = await changedRepos(work, this.store.project(task.projectId).baseBranch)
      const now = this.store.task(task.id)
      if (now.status !== 'in_progress' || now.needsInput || this.runs.has(session.id)) return
      // Every changed repo has a PR: the task waits for the user to merge.
      if (prRollup(work, changed) === 'review') return
      const missing = work.repos.filter((r) => changed.includes(r.repo) && (!r.prUrl || r.prState === 'closed'))
      this.store.updateTask(task.id, {
        needsInput: missing.length
          ? `Developer stopped without a PR for ${missing.map((r) => repoWorkName(work, r)).join(', ')}`
          : 'Developer stopped without opening a PR',
      })
    }
  }
}
