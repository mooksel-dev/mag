import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveChoice, type AgentEvent, type AgentInfo, type AgentKind, type AgentRole, type AgentSession, type Attachment, type ChatItem, type ModelChoice, type Project, type Task } from '@mag/core'
import { adapters, type RunHandle, type RunSpec } from '@mag/agents'
import { ARCH_RULES } from '@mag/arch'
import type { Store } from './store'
import type { LocalApi } from './api'
import { AGENT_MARK, prepareWorktree, slug, type PrFeedback } from './git'

interface Paths {
  /** Built task-mcp.js next to the main bundle. */
  mcpScript: string
  runsDir: string
  worktreesDir: string
  /** Files the user attached to messages. */
  attachmentsDir: string
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
6. If the task is too big for one PR, split it with create_subtask: one subtask = one PR, each with a short doc
   (what this part changes, how to check it). Subtasks run one by one in creation order; they are not groomed
   separately. When re-grooming, change the existing subtasks with update_subtask / delete_subtask /
   reorder_subtasks instead of creating duplicates (get_task lists them).
7. When no open questions remain and the plan is ready: set_needs_input(null), then mark_groomed.
Stay within the brief: do not add work nobody asked for. An idea outside it goes to the user as a question,
not into the doc or a subtask.
Never edit code. Keep chat replies to one or two sentences; the doc carries the detail.`

const developerPrompt = (project: Project, task: Task, parent?: Task) => `You are a developer agent in "mag".
${parent ? `This is subtask ${task.key} of ${parent.key}; the parent's doc (get_task -> parent) is context, implement only this subtask.\n` : ''}You work in your own git worktree on branch ${task.work?.branch}, based on ${project.baseBranch}.
1. Call get_task and get_doc. The doc is the agreed plan; follow it.
2. Implement it. Add or update tests and run them; run lint/typecheck if the repo has them.
3. Review your own diff (git diff ${project.baseBranch}...HEAD) like a strict reviewer and fix what you find.
4. Commit with clear messages, then: git push -u origin ${task.work?.branch}
5. Open a PR: gh pr create --base ${project.baseBranch} --head ${task.work?.branch} --title ... --body ...
   Body: short summary, how you tested, and any assumptions you were not sure about. Then call set_pr with the URL.
6. If you need a decision only the user can make, call set_needs_input with a one-line question, say it in chat, and stop.
Never merge. Never push to ${project.baseBranch}. Anything you post on GitHub starts with "${AGENT_MARK}".
Keep chat replies short.`

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

const chatPrompt = (project: Project) => `You are the user's partner for project "${project.name}" in "mag",
a task-centric workspace. This is a free conversation about the project: ideas, product and design decisions,
architecture, priorities, reviewing what agents did. You can read the code (read-only) and the web.
How mag works: backlog task -> groomer agent writes the task doc, asks questions and may split it into subtasks
(one PR each) -> the user adds the task to the plan -> developer agents implement it in a worktree and open a PR
-> the user merges. The plan is an ordered queue run one task at a time: subtasks one by one, the next task after
the previous one is merged.
- You never change code. A change becomes a task: create_task with a concise brief (what and why), and
  start_grooming if the user wants it moving. Check list_tasks first to avoid duplicates.
- If a task is already fully discussed here and the user asks to get it done, skip grooming: create_task with
  a complete doc (Problem / Changes per layer / Plan, following the project's doc template) and plan: true.
  It goes to the end of the plan and a developer picks it up automatically. Anything that needs splitting into
  subtasks or still has open questions goes to the backlog and through start_grooming instead.
- Record outcomes so they outlive this chat: decisions and conventions in update_notes, plan changes in
  update_task / update_task_doc. Say in one line what you recorded.
- For anything visual (UI mockups, flows, diagrams, comparisons) use show_canvas with one self-contained HTML page;
  revise it by id instead of drawing a new one. Prefer showing over describing.
- Refer to tasks by key (T-12, subtask T-12.3); the app turns keys into links.
- Be concise: short answers, markdown only where it helps. The user hates filler.`

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
    const set = (patch: Partial<NonNullable<Project['archRun']>>) =>
      this.store.updateProject(projectId, { archRun: { ...this.store.project(projectId).archRun!, ...patch } })
    let failed = false
    const c = this.choice(projectId, 'architect')
    const handle = adapters[c.agent].start(
      {
        cwd: project.repos[0],
        model: c.model ?? undefined,
        addDirs: project.repos.slice(1),
        prompt: 'Describe the architecture of this project. Start with get_architecture.',
        appendSystemPrompt: ARCHITECT_PROMPT,
        mcpConfigPath,
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
      },
      (e) => {
        if (e.type === 'tool.call') set({ note: `${e.name.replace(/^mcp__mag__/, '')} ${summarize(e.input)}`.trim() })
        else if (e.type === 'message') set({ note: e.text.slice(0, 160) })
        else if (e.type === 'turn.done') set({ costUsd: e.costUsd })
        else if (e.type === 'error') {
          failed = true
          set({ status: 'error', note: e.message.slice(0, 300) })
        }
      },
    )
    handle.done.then(() => {
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
    const session = this.newSession(taskId, 'groomer')
    this.store.updateTask(taskId, { status: 'grooming', needsInput: null })
    this.run(session, `Groom task ${task.key}. Start with get_task.`)
  }

  /** Pick up a planned task: worktree + branch, then a developer session. */
  async develop(taskId: string) {
    const task = this.store.task(taskId)
    if (this.store.data.tasks.some((t) => t.parentId === taskId)) throw new Error(`${task.key} has subtasks; they are developed one by one`)
    const project = this.store.project(task.projectId)
    const repo = project.repos[0]
    if (!repo) {
      this.store.updateTask(taskId, { needsInput: 'Project has no repository' })
      return
    }
    const work = task.work ?? {
      repo,
      branch: `mag/${task.key.toLowerCase()}-${slug(task.title)}`,
      worktree: join(this.paths.worktreesDir, project.id, task.key),
      prUrl: null,
      feedbackSeenAt: 0,
    }
    this.store.updateTask(taskId, { status: 'in_progress', needsInput: null, work })
    const session = this.newSession(taskId, 'developer')
    try {
      await prepareWorktree(work.repo, project.baseBranch, work.branch, work.worktree)
    } catch (e) {
      session.items.push({ kind: 'error', text: `Worktree failed: ${(e as Error).message}`, at: Date.now() })
      session.status = 'error'
      this.store.updateTask(taskId, { needsInput: 'Could not create the worktree' })
      return
    }
    this.run(session, `Implement task ${task.key}. Start with get_task and get_doc.`)
  }

  /** New PR comments: resume the developer with them. */
  feedback(taskId: string, items: PrFeedback[]) {
    const session = this.lastSession(taskId, 'developer')
    if (!session || this.runs.has(session.id)) return false
    const text =
      'New feedback on your PR:\n' +
      items.map((f) => `- @${f.author}${f.where ? ` on ${f.where}` : ''}: ${f.body}`).join('\n') +
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
    if (session.role === 'developer' && task.work) {
      // The worktree may have failed earlier or been removed: recreate it before resuming.
      try {
        await prepareWorktree(task.work.repo, this.store.project(task.projectId).baseBranch, task.work.branch, task.work.worktree)
      } catch (e) {
        session.items.push({ kind: 'error', text: `Worktree failed: ${(e as Error).message}`, at: Date.now() })
        session.status = 'error'
        this.store.updateTask(task.id, { needsInput: 'Could not create the worktree' })
        return
      }
    }
    this.run(session, prompt)
  }

  stop(sessionId: string) {
    this.runs.get(sessionId)?.kill()
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
        addDirs: [...rest, this.paths.attachmentsDir],
        appendSystemPrompt: chatPrompt(project) + (project.notes ? `\n\nProject notes:\n${project.notes}` : '') + arch,
        allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'Skill', 'mcp__mag'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
      }
    }
    const task = this.store.task(session.taskId)
    if (session.role === 'developer' && task.work) {
      return {
        cwd: task.work.worktree,
        addDirs: [...project.repos.filter((r) => r !== task.work!.repo), this.paths.attachmentsDir],
        appendSystemPrompt:
          developerPrompt(project, task, task.parentId ? this.store.data.tasks.find((t) => t.id === task.parentId) : undefined) +
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

    session.status = 'running'
    session.runStartedAt = Date.now()
    this.store.changed()
    this.logSessionEvent(session, 'agent_started', `${session.role} started`)

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
          return push({ kind: 'error', text: e.message, at })
      }
    }

    const handle = adapters[session.agent].start(
      { ...this.spec(session), prompt, model: c.model ?? undefined, resumeId: session.nativeSessionId ?? undefined, mcpConfigPath },
      onEvent,
    )
    this.runs.set(session.id, handle)
    handle.done.then(() => {
      this.runs.delete(session.id)
      if (session.status === 'running') session.status = 'idle'
      if (session.status === 'error') this.logSessionEvent(session, 'agent_failed', `${session.role} failed`)
      this.afterRun(session)
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
  private afterRun(session: AgentSession) {
    if (!session.taskId) return
    const task = this.store.task(session.taskId)
    if (task.needsInput) return
    const failed = session.status === 'error'
    if (session.role === 'groomer' && task.status === 'grooming') {
      if (failed) this.store.updateTask(task.id, { status: 'backlog' })
      else this.store.updateTask(task.id, { needsInput: 'Groomer stopped without finishing; check the chat' })
    }
    if (session.role === 'developer' && task.status === 'in_progress') {
      if (!failed && task.work?.prUrl) this.store.updateTask(task.id, { status: 'in_review' })
      else
        this.store.updateTask(task.id, {
          needsInput: failed ? 'Developer agent failed; check the chat' : 'Developer stopped without opening a PR',
        })
    }
  }
}
