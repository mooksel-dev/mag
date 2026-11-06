import { MAG_MCP_ID, chatTranscript, integrationMode, DIRECTION_CHOICES, unknownDecisions, type DirectionChoice, verdictFloor, withFloor, type MagFloors, checkReport, markChecked, normalizeReport, prVerdictOf, reportFindings, stepVerdict, type ReportKind, type ReviewReport, CANVAS_ROLES, needsQuestions, DEFAULT_TEMPLATES, diagramWarnings, mergeDraft, setKey, setOf, validateLinks, withScenarioLinks, type ComponentDiagram, FINDING_LEVELS, PR_VERDICTS, REVIEW_VERDICTS, isReview, formatOfTopic, reviewTopicIds, REVIEW_FORMATS, type ReviewFormat, type ReviewResult, type PrVerdict, linkedCanvasIds, stepDiagrams, taskDiagrams as workDiagrams, SUBTASK_STATUSES, workSections, projectIdeas, canCancel, taskByKey, currentStep, diagramSummary, findRepoWork, formatDiffCount, isLegacy, normalizeDiagram, parseFlowRef, projectRepo, prRollup, repoNames, repoWorkName, stepRepoNames, subtaskProgress, subtaskStatusChanges, subtasksOf, taskPrs, ticketRef, withTicket, validateDiagram, walkArch, renameIds, type AgentSession, type ArchNode, type ArchUse, type Canvas, type CanvasPlacement, type Project, type RepoWork, type ReviewFinding, type ReviewVerdict, type SubtaskStatus, type Task, type TaskType, type TaskWork, type TicketRef } from '@mag/core'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { analyze, formatReport } from '@mag/arch'
import { carryIds, formatFiles, sharedPaths, unowned, vocabularyOf } from '@mag/diff'
import type { Store } from './store'
import { changedRepos, revParse, treeAt } from './git.ts'
import { log } from './log.ts'
import { planCheck } from './plan-check.ts'
import { changes as factChanges, draftListing, factDiagrams, factReport, factRoot, flowchartRefusal, generated, hunkListing, scenariosOf, type Changes, type ChangeTarget, type Fact } from './core/services/fact/index.ts'
import { branchTarget, factRecord, localGit, reviewChanges, reviewFact, reviewFacts, stepChanges, stepFact, stepSet } from './fact.ts'
import { MESSAGED_ROLES, OWNER_TOOLS, TOOL_DEFS, toolForRole, type MessagedRole } from './tool-defs.ts'

export interface ToolContext {
  taskId?: string
  projectId?: string
  /** Session whose chat shows canvases. */
  sessionId?: string
  /** Aborted when the MCP server hangs up before the answer. */
  signal?: AbortSignal
}

/** Things tools can kick off; wired to the orchestrator after it exists. */
export interface ToolActions {
  groom(taskId: string): void
  architect(projectId: string): void
  /** Stops the task's agents, removes its worktrees and marks it canceled. */
  cancel(taskId: string, reason: string | null): Promise<void>
  /** Marks a step done and removes its worktrees; the task is done once every step is. */
  completeStep(stepId: string): Promise<void>
  /** A developer's add_repo: a worktree of one more project repository in its step. */
  addRepo(stepId: string, ref: string, worktree?: boolean): Promise<RepoWork>
  /** The reviewer's verdict on the step under review (T-55.1); returns what to tell it. */
  setReview(stepId: string, verdict: ReviewVerdict, findings: ReviewFinding[], report?: ReviewReport): string
  /** Continue a done work (T-55.6): back to planning; `by`, the topic asking, owns it. Returns what to tell the agent. */
  reopen(taskId: string, what: string, by?: string): string
  /** A step developer's question goes to the work's owner (ahent-vede-robotu-vlasna-pozytsiia.2); false: busy or gone. */
  askOwner(stepId: string, question: string): boolean
  /** The owner's answer to its step developer's waiting question; the developer goes on with it. */
  answerDeveloper(stepId: string, text: string): Promise<void>
  /** A topic's Branch: a new topic forking its agent session; `text` is its first message. Returns the new topic's id. */
  branchChat(sessionId: string, text?: string): string
  /** A topic's review_pr: the review of a teammate's PR in `format` (the project's without one), run by `by`; returns the job for its turn. */
  reviewPr(projectId: string, url: string, by: string, format?: ReviewFormat): Promise<{ taskId: string; job: string }>
  /** The user's export_review: the review's .zip at `path` (default: Downloads); returns the file's path. */
  exportReview(workId: string, path?: string): Promise<string>
  /** The fact of a review's PR (its get_pr_changes), without a plan; starts the fact diagram on the first call. */
  reviewFact(workId: string): Promise<string>
  /** A review topic's set_pr_review, into the result of the format it runs; returns what to tell it. */
  setPrReview(workId: string, sessionId: string, review: Pick<ReviewResult, 'problem' | 'approach' | 'verdict' | 'findings' | 'report'>): string
  /** The owner topic's decide_direction: the user's call on the review's direction; returns what to tell it. */
  decideDirection(workId: string, decision: { choice: DirectionChoice; option?: string; principle?: string; draft?: string }): string
  /** The user's Approve: planning → ready, with the button's checks. */
  approve(taskId: string): void
  /** The user's Start (or Restart) of a work; `localRepos`: repositories its steps work on in the main checkout. */
  develop(taskId: string, localRepos?: string[]): Promise<void>
  /** The user's Approve & Start of a work in planning: approve's checks, then Start. */
  approveAndStart(taskId: string, localRepos?: string[]): Promise<void>
  /** The user's Start of a work's next step that starts manually. */
  startStep(taskId: string): Promise<void>
  /** The user's Restart of the review of a work's current step. */
  restartReview(taskId: string): Promise<void>
  /** The session a message to a work or a step goes to: of `role`, else the one that worked last. */
  agentOf(taskId: string, role?: MessagedRole): AgentSession | null
  /** A message to a session, as the user's in its chat; resumes it. */
  send(sessionId: string, text: string): Promise<void>
  /** Stops the agents of a work or a step in a turn; returns those stopped. */
  stopAgents(taskId: string): Promise<AgentSession[]>
  /** The failed CI checks of a PR, by name (with link), for mag's review floor; without it, CI sets no floor. */
  failedChecks?(url: string): Promise<string[]>
}

/**
 * The step a task run works on: a developer session's own step, else the task's current step. null for a legacy task,
 * which works on its own work.
 */
function runStep(store: Store, ctx: ToolContext): Task | null {
  const task = store.task(ctx.taskId!)
  if (isLegacy(task)) return null
  const stepId = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId)?.stepId : null
  return (stepId && store.data.tasks.find((t) => t.id === stepId)) || currentStep(task.id, store.data.tasks)
}

/** The worktrees a task run works in: a legacy task's own, else its step's. */
function runWork(store: Store, ctx: ToolContext): TaskWork | null {
  return store.task(ctx.taskId!).work ?? runStep(store, ctx)?.work ?? null
}

/** Steps from a tool argument: [{ title, note?, start_manually? }]. */
function stepsArg(v: unknown): { title: string; note: string; startManually: boolean }[] {
  if (!Array.isArray(v)) return []
  return v.map((x: Record<string, unknown>) => {
    const title = String(x?.title ?? '').trim()
    if (!title) throw new Error('Every step needs a title')
    return { title, note: typeof x.note === 'string' ? x.note.replace(/\s+/g, ' ').trim() : '', startManually: x.start_manually === true }
  })
}

/** Repositories of a step from a tool argument: names or paths of project repositories, stored as paths in project order. */
function reposArg(v: unknown, project: Project): string[] {
  if (!Array.isArray(v)) throw new Error('repos must be an array of repository names or paths')
  const unknown = v.filter((r) => typeof r !== 'string' || !projectRepo(project, r))
  if (unknown.length) throw new Error(`Not a repository of the project: ${unknown.join(', ')}; one of ${repoNames(project).join(', ') || '(none)'}`)
  const paths = v.map((r) => projectRepo(project, r as string)!)
  return project.repos.filter((r) => paths.includes(r))
}

/** Review findings from a tool argument: [{ text, where?, level?, node? }]; some agent CLIs pass the array as a JSON string. */
function findingsArg(v: unknown): ReviewFinding[] {
  let raw = v ?? []
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new Error('findings must be an array of { text, where?, level?, node? }')
    }
  }
  if (!Array.isArray(raw)) throw new Error('findings must be an array of { text, where?, level?, node? }')
  return raw.map((x: Record<string, unknown>) => {
    const text = String(x?.text ?? '').trim()
    if (!text) throw new Error('Every finding needs a text')
    const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const level = opt(x.level)
    if (level && !(FINDING_LEVELS as string[]).includes(level)) throw new Error(`level must be one of ${FINDING_LEVELS.join(', ')}`)
    const f: ReviewFinding = { text }
    if (opt(x.where)) f.where = opt(x.where)
    if (level) f.level = level as ReviewFinding['level']
    if (opt(x.node)) f.node = opt(x.node)
    return f
  })
}

/**
 * A review report from a tool argument (review-v2-questions-first-direction.1): its shape, then checkReport against the
 * inventory of the review's fact; mag's checked badge on the claims that cite only units the hunks bear out. Throws with
 * everything to fix; nothing is stored then.
 */
function reportArg(raw: unknown, kind: ReportKind, fact: Pick<Fact, 'inventory' | 'inventoryCheck'> | null): ReviewReport {
  const { report, errors } = normalizeReport(raw)
  const all = [...errors, ...(errors.length ? [] : checkReport(report, fact?.inventory ?? null, kind))]
  if (all.length) throw new Error(`Not recorded. Fix the report and call again:\n- ${all.join('\n- ')}`)
  const bad = new Set([...(fact?.inventoryCheck?.ungrounded ?? []), ...(fact?.inventoryCheck?.otherModule ?? [])].map((u) => u.unit))
  return markChecked(report, (fact?.inventory?.units ?? []).map((u) => u.id).filter((id) => !bad.has(id)))
}

/** A PR's failed CI checks; none when GitHub cannot be asked (the floor then rests on the reviewer). */
async function failedChecks(actions: ToolActions, url: string): Promise<string[]> {
  return (
    (await actions.failedChecks?.(url).catch((e) => {
      log.warn('agent', `CI of ${url} not read for the review floor: ${(e as Error).message.split('\n')[0]}`)
      return []
    })) ?? []
  )
}

/**
 * What mag owns about a step's PRs under review (prompts-use-the-models-to.1): plan ↔ fact's blockers (deviations, an
 * incomplete fact), their failed CI checks and, in a project that enforces its architecture, the rules the step's
 * worktrees break at the heads under review (a worktree elsewhere is not what is reviewed).
 */
async function stepFloors(actions: ToolActions, project: Project, step: Task): Promise<MagFloors> {
  const repos = step.work?.repos.filter((r) => r.prUrl && r.prState === 'open') ?? []
  const ci = (await Promise.all(repos.map(async (r) => (await failedChecks(actions, r.prUrl!)).map((c) => (repos.length > 1 ? `${repoWorkName(step.work!, r)}: ${c}` : c))))).flat()
  const rules: string[] = []
  if (project.enforceArchitecture)
    for (const r of repos) {
      const head = step.fact?.heads[r.repo]
      if (!head || !existsSync(r.worktree) || (await revParse(r.worktree, 'HEAD').catch(() => null)) !== head) continue
      for (const v of analyze(r.worktree).violations.filter((x) => x.severity === 'error')) rules.push(`${v.rule}: ${v.from} -> ${v.to} (${v.file}:${v.line})`)
    }
  return { deviations: step.fact?.blockers ?? [], ci, rules }
}

/** Tickets from a tool argument: [{ url, key? }] (a plain string is a URL); some agent CLIs pass the array as a JSON string. */
function ticketsArg(v: unknown): TicketRef[] {
  let raw = v ?? []
  if (typeof raw === 'string') {
    try {
      raw = raw.trim().startsWith('[') ? JSON.parse(raw) : [raw]
    } catch {
      throw new Error('tickets must be an array of { url, key? }')
    }
  }
  if (!Array.isArray(raw)) throw new Error('tickets must be an array of { url, key? }')
  return raw.reduce<TicketRef[]>((all, x: unknown) => {
    const o = (typeof x === 'string' ? { url: x } : (x ?? {})) as Record<string, unknown>
    return withTicket(all, ticketRef(String(o.url ?? ''), typeof o.key === 'string' ? o.key : null))
  }, [])
}

const TYPES: TaskType[] = ['dev', 'design', 'spike', 'research']

function taskType(v: unknown): TaskType {
  if (v === undefined || v === null || v === '') return 'dev'
  if (!TYPES.includes(v as TaskType)) throw new Error(`type must be one of ${TYPES.join(', ')}`)
  return v as TaskType
}

/**
 * A project chat planning a work it owns (T-55.5): the owner tools take the work's key, and the call runs as in that
 * work. Only the topic that owns the work may; a work planned by its groomer is the groomer's.
 */
function ownerContext(store: Store, ctx: ToolContext, name: string, args: Record<string, unknown>, role: string | undefined): ToolContext {
  if (ctx.taskId || role !== 'chat' || !(OWNER_TOOLS as readonly string[]).includes(name)) return ctx
  const key = typeof args.work === 'string' ? args.work.trim() : ''
  if (!key) {
    if (name === 'show_diagram' || name === 'show_canvas') return ctx
    throw new Error(`${name} needs work: the key of a work this topic owns, e.g. ABC-12`)
  }
  const work = store.data.tasks.find((t) => t.projectId === ctx.projectId && !t.parentId && t.key.toLowerCase() === key.toLowerCase())
  if (!work) throw new Error(`No work ${key}`)
  // A review is run by a topic per format (review-v2-part-2-v1-2.1): each of them may.
  const owns = isReview(work) ? !!ctx.sessionId && reviewTopicIds(work).includes(ctx.sessionId) : work.ownerSessionId === ctx.sessionId
  if (!owns) throw new Error(`${work.key} is not planned in this topic${work.ownerSessionId ? ' (its owner is another session)' : ''}: only its owner changes its plan`)
  return { ...ctx, taskId: work.id }
}

export type ToolHandler = (ctx: ToolContext, name: string, args: Record<string, unknown>) => Promise<string>

export function createTools(store: Store, actions: ToolActions): ToolHandler {
  return async (callCtx, name, args) => {
    const role = callCtx.sessionId ? store.data.sessions.find((s) => s.id === callCtx.sessionId)?.role : undefined
    const def = TOOL_DEFS.find((d) => d.name === name)
    if (def && role && !toolForRole(def, role)) throw new Error(`${name} is not available to the ${role} agent`)
    const ctx = ownerContext(store, callCtx, name, args, role)
    const projectId = ctx.taskId ? store.task(ctx.taskId).projectId : (ctx.projectId ?? '')
    const shared = sharedTool(store, actions, store.project(projectId), ctx, name, args)
    if (shared !== undefined) return shared
    if (!ctx.taskId) throw new Error(`${name} needs a task`)
    const task = store.task(ctx.taskId)
    const project = store.project(task.projectId)
    const doc = (id: string) => store.data.docs[id] ?? '(empty)'
    const steps = () => subtasksOf(task.id, store.data.tasks)
    const subtask = (key: unknown) => {
      const sub = store.data.tasks.find((t) => t.parentId === task.id && t.key.toLowerCase() === String(key).toLowerCase())
      if (!sub) throw new Error(`${key} is not a subtask of ${task.key}`)
      return sub
    }
    /** Steps change only while planning; throws otherwise. */
    const canEditSteps = () => {
      if (task.parentId) throw new Error('Subtasks cannot have subtasks')
      if (task.status !== 'planning') throw new Error(`${task.key} is ${task.status}; its steps change only while planning`)
    }
    /**
     * The checkpoint (T-55.2): a groomer plans steps only after the user has answered it in its chat (confirmed the
     * problem, picked an option). Other roles plan with the user already.
     */
    const pastCheckpoint = () => {
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      if (session?.role === 'groomer' && task.status === 'planning' && !session.items.some((i) => i.kind === 'user'))
        throw new Error('Checkpoint first: steps come after the user confirms the problem and picks an option. Put that under Open questions, call set_needs_input and stop; plan the steps once the user has answered in this chat.')
    }
    /** A step of the task, while planning. */
    const ownSubtask = (key: unknown) => {
      canEditSteps()
      return subtask(key)
    }
    const note = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

    switch (name) {
      case 'get_task': {
        const legacy = isLegacy(task)
        const step = runStep(store, ctx)
        const work = runWork(store, ctx)
        return JSON.stringify(
          {
            key: task.key,
            title: task.title,
            type: task.type,
            status: task.status,
            description: task.description,
            subtasks: steps().map((t) => ({
              key: t.key,
              title: t.title,
              note: t.description || undefined,
              status: t.status,
              startManually: legacy ? undefined : !!t.startManually,
              repos: legacy ? undefined : stepRepoNames(t, project),
              prs: t.work?.repos.flatMap((r) => (r.prUrl ? [`${r.prUrl} (${r.prState ?? 'unknown'})`] : [])),
              current: t.id === step?.id || undefined,
            })),
            project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
            work: work && {
              dir: work.dir,
              repos: work.repos.map((r) => ({ name: repoWorkName(work, r), repo: r.repo, worktree: r.worktree, branch: r.branch, base: r.base ?? project.baseBranch, prUrl: r.prUrl, prState: r.prState })),
            },
            diagrams: taskDiagrams(store, task.id).map((c) => ({ id: c.id, type: c.diagram!.type, title: c.title, changes: changes(c), ...placementOut(store, project, task.id, c) })),
            docTemplate: project.templates[task.type] ?? DEFAULT_TEMPLATES[task.type],
            tickets: task.tickets?.length ? task.tickets : undefined,
          },
          null,
          2,
        )
      }

      case 'get_doc':
        return doc(task.id)

      case 'get_diagrams': {
        const all = taskDiagrams(store, task.id)
        const step = args.step === undefined || args.step === null || args.step === '' ? null : subtask(args.step)
        const list = step ? stepDiagrams(all, step.id) : all
        if (!list.length) return step ? `${step.key} has no diagrams of its own; get_diagrams without step lists all of ${task.key}.` : 'This task has no diagrams.'
        return JSON.stringify(
          list.map((c) => ({ id: c.id, title: c.title, version: c.version, changes: changes(c), ...placementOut(store, project, task.id, c), root: c.root || undefined, inventory: c.inventory, diagram: c.diagram })),
          null,
          2,
        )
      }

      case 'update_doc': {
        const md = String(args.markdown ?? '')
        store.data.docs[task.id] = md
        store.changed()
        return `Document updated.${adopted(store, task.id, md)}`
      }

      case 'place_diagram': {
        const placement = placementArg(store, task, project, args)
        if (!placement) throw new Error(`role is required: ${PLACE_ROLES.join(', ')}`)
        const c = store.data.canvases[String(args.id ?? '')]
        if (!c || c.projectId !== project.id || c.kind !== 'diagram' || !c.diagram) throw new Error(`No diagram ${args.id} in this project`)
        if (c.taskId === task.id || c.taskId === null) {
          store.adoptCanvases(task.id, [c.id])
          store.placeCanvas(c.id, placement)
          return `Placed ${c.id}${placedAs(store, project, placement)}.`
        }
        // A diagram of another task stays there; this work gets its own copy to place and revise.
        const copy = store.saveCanvas({ projectId: project.id, taskId: task.id, sessionId: ctx.sessionId ?? null, title: c.title, kind: 'diagram', diagram: c.diagram, placement })
        const owner = store.data.tasks.find((t) => t.id === c.taskId)?.key ?? 'another task'
        return `${c.id} belongs to ${owner}: copied into ${task.key} as ${copy.id}${placedAs(store, project, placement)}. Link [${copy.title}](canvas:${copy.id}) in the doc instead of canvas:${c.id} and revise the copy from now on.`
      }

      case 'set_needs_input': {
        const reason = args.reason == null || args.reason === '' ? null : String(args.reason)
        // A step's developer asks the work's owner first (ahent-vede-robotu-vlasna-pozytsiia.2).
        const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
        const step = session?.role === 'developer' && session.stepId ? store.task(session.stepId) : null
        if (step) store.updateTask(step.id, { ownerQuestion: null })
        if (reason && step && actions.askOwner(step.id, reason))
          return "The work's owner, who planned it, gets your question first: it answers here or asks the user. Stop here until the answer comes."
        const questions = reason ? needsQuestions(args.questions) : null
        store.updateTask(task.id, { needsInput: reason, needsQuestions: questions })
        return reason ? `The user will be notified${questions ? `, with ${questions.length} question${questions.length > 1 ? 's' : ''} and your recommendations on a card` : ''}.` : 'Cleared.'
      }

      case 'answer_developer': {
        if (task.parentId || task.ownerSessionId !== ctx.sessionId) throw new Error(`answer_developer is for the owner of ${task.key}`)
        const step = subtask(args.step)
        const text = String(args.text ?? '').trim()
        if (!text) throw new Error('text is required')
        await actions.answerDeveloper(step.id, text)
        return `Sent to the developer of ${step.key}; it goes on with your answer.`
      }

      case 'create_subtask': {
        canEditSteps()
        pastCheckpoint()
        const title = String(args.title ?? '').trim()
        if (!title) throw new Error('title is required')
        const repos = args.repos === undefined ? undefined : reposArg(args.repos, project)
        const sub = store.createTask({ projectId: project.id, parentId: task.id, title, type: task.type, description: note(args.note), status: 'todo', startManually: args.start_manually === true, repos })
        return `Created ${sub.key}.`
      }

      case 'update_subtask': {
        const sub = ownSubtask(args.key)
        const patch: Partial<Task> = {}
        if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim()
        if (typeof args.note === 'string') patch.description = note(args.note)
        if (typeof args.start_manually === 'boolean') patch.startManually = args.start_manually
        if (args.repos !== undefined) patch.repos = reposArg(args.repos, project)
        store.updateTask(sub.id, patch)
        return `Updated ${sub.key}.`
      }

      // Legacy tasks only: steps of the others follow their lifecycle. check_subtask: the pre-T-26 name.
      case 'set_subtask_status':
      case 'check_subtask': {
        if (!isLegacy(task)) throw new Error('Step status follows its lifecycle: a step is done when its PRs are merged; close a step without code with complete_step')
        const sub = subtask(args.key)
        const status = (name === 'check_subtask' ? (args.done === false ? 'todo' : 'done') : args.status) as SubtaskStatus
        if (!SUBTASK_STATUSES.includes(status)) throw new Error(`status must be one of ${SUBTASK_STATUSES.join(', ')}`)
        for (const c of subtaskStatusChanges(sub, status, store.data.tasks)) store.updateTask(c.id, { status: c.status })
        const { done, total } = subtaskProgress(task.id, store.data.tasks)
        return `${sub.key} is ${status.replace('_', ' ')}; ${done}/${total} done.`
      }

      case 'delete_subtask': {
        const sub = ownSubtask(args.key)
        store.deleteTask(sub.id)
        return `Deleted ${sub.key}.`
      }

      case 'reorder_subtasks': {
        canEditSteps()
        pastCheckpoint()
        const ordered = (Array.isArray(args.keys) ? args.keys : []).map(subtask)
        store.reorderSubtasks(task.id, ordered.map((t) => t.id))
        return `Order: ${ordered.map((t) => t.key).join(', ')}.`
      }

      case 'complete_step': {
        if (isLegacy(task)) throw new Error(`${task.key} is a legacy task: it has no steps to complete`)
        const step = runStep(store, ctx)
        if (step?.status !== 'in_progress') throw new Error('No step is in progress')
        const work = step.work
        const changed = work ? await changedRepos(work, project.baseBranch) : []
        if (work && changed.length) {
          const names = work.repos.filter((r) => changed.includes(r.repo)).map((r) => repoWorkName(work, r))
          throw new Error(`${step.key} has commits in ${names.join(', ')}: open a PR per changed repo and record it with set_pr`)
        }
        await actions.completeStep(step.id)
        const next = currentStep(task.id, store.data.tasks)
        return `${step.key} is done.${next ? ` Next: ${next.key}, in a new session.` : ' Every step is done.'} Stop here.`
      }

      case 'add_repo': {
        if (role && role !== 'developer') throw new Error('add_repo is for the developer of a step')
        if (isLegacy(task)) throw new Error(`${task.key} is a legacy task: every repository has its worktree already`)
        const step = runStep(store, ctx)
        if (step?.status !== 'in_progress') throw new Error('No step is in progress')
        const ref = String(args.repo ?? '').trim()
        if (!ref) throw new Error(`Pass repo: one of ${repoNames(project).join(', ')}`)
        const r = await actions.addRepo(step.id, ref, args.worktree === true)
        const work = store.task(step.id).work!
        if (r.local) return `${repoWorkName(work, r)}: the main checkout ${r.worktree}, on branch ${r.branch} (the task works there locally). Change it there; it gets its own PR like the other repos of ${step.key}.`
        return `${repoWorkName(work, r)}: worktree ${r.worktree} on branch ${r.branch}. Change it there, never in the main checkout; it gets its own PR like the other repos of ${step.key}.`
      }

      case 'set_pr': {
        const legacy = isLegacy(task)
        const step = legacy ? null : runStep(store, ctx)
        const work = legacy ? task.work : step?.work
        if (!work) throw new Error(`${step?.key ?? task.key} has no work in progress`)
        const url = String(args.url ?? '')
        if (!/^https:\/\/github\.com\/.+\/pull\/\d+/.test(url)) throw new Error('Expected a GitHub pull request URL')
        const names = work.repos.map((r) => repoWorkName(work, r)).join(', ')
        const ref = typeof args.repo === 'string' && args.repo.trim() ? args.repo : work.repos.length === 1 ? work.repos[0].repo : null
        if (!ref) throw new Error(`Pass repo: one of ${names}`)
        const target = findRepoWork(work, ref)
        if (!target) throw new Error(`${ref} is not a repo of this task; one of ${names}`)
        // One PR per repo per step: a new one only replaces a PR closed without merge.
        if (step && target.prUrl && target.prUrl !== url && target.prState !== 'closed')
          throw new Error(`${repoWorkName(work, target)} already has ${target.prUrl} in ${step.key}; push to its branch instead`)
        const first = !work.repos.some((r) => r.prUrl)
        const next = {
          ...work,
          repos: work.repos.map((r) => (r === target ? { ...r, prUrl: url, prState: 'open' as const, prDraft: false, checkError: null } : r)),
          // Comments made before the first PR are not feedback; later ones on any PR are.
          feedbackSeenAt: first ? Date.now() : work.feedbackSeenAt,
        }
        const changed = await changedRepos(next, project.baseBranch)
        const review = prRollup(next, changed) === 'review'
        store.updateTask(step?.id ?? task.id, { work: next })
        const missing = next.repos.filter((r) => changed.includes(r.repo) && (!r.prUrl || r.prState === 'closed')).map((r) => repoWorkName(next, r))
        return review
          ? step
            ? `PR recorded. Every changed repo has a PR: once you stop, an agent reviews ${step.key} first and you are resumed with its findings if it asks for changes; then the user merges, and ${step.key} is done once every PR is merged. You will be resumed if they leave comments.`
            : 'PR recorded. Every changed repo has a PR: the user merges; you will be resumed if they leave comments.'
          : `PR recorded for ${repoWorkName(next, target)}. Still without a PR: ${missing.join(', ') || 'none'}; open one per changed repo.`
      }

      case 'get_pr_changes': {
        if (isReview(task)) return actions.reviewFact(task.id)
        const work = runWork(store, ctx)
        if (!work) throw new Error(`${task.key} has no work in progress`)
        const ref = typeof args.repo === 'string' && args.repo.trim() ? args.repo : null
        const target = ref ? findRepoWork(work, ref) : null
        if (ref && !target) throw new Error(`${ref} is not a repo of this task; one of ${work.repos.map((r) => repoWorkName(work, r)).join(', ')}`)
        const vocabulary = vocabularyOf(project.architecture?.modules ?? [])
        const note = vocabulary.modules.length ? '' : 'No architecture with paths is recorded: files are not grouped by module.\n\n'
        // The reviewer cites the hunks of the heads under review, numbered as mag checks them; others the branches as they are.
        const step = role === 'reviewer' ? runStep(store, ctx) : null
        if (step?.fact && Object.keys(step.fact.heads).length) {
          const changed = await stepChanges(project, step, step.fact.heads, Object.values(store.data.canvases), { draft: true })
          return note + prChangesText(changed, target ? repoWorkName(work, target) : null)
        }
        return note + (await prChanges(project, work, target ? [target] : work.repos))
      }

      case 'set_inventory':
        return setInventory(store, project, ctx, task, role, args.inventory)

      case 'set_review': {
        const stepId = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId)?.stepId : null
        if (role !== 'reviewer' || !stepId) throw new Error('set_review is for the reviewer of a step')
        if (args.report != null) {
          const step = store.task(stepId)
          const agent = reportArg(args.report, 'step', step.fact ? await stepFact(project, step, step.fact.heads, Object.values(store.data.canvases)) : null)
          if (args.verdict != null && args.verdict !== stepVerdict(agent.checks)) throw new Error(`Not recorded: verdict ${String(args.verdict)} and checks ${agent.checks} disagree; checks ${agent.checks} is ${stepVerdict(agent.checks)}. Leave verdict out.`)
          const report = withFloor(agent, verdictFloor(await stepFloors(actions, project, step)))
          return actions.setReview(stepId, stepVerdict(report.checks), reportFindings(report), report)
        }
        const verdict = args.verdict as ReviewVerdict
        if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${REVIEW_VERDICTS.join(', ')}`)
        const findings = findingsArg(args.findings)
        if (verdict !== 'merge' && !findings.length) throw new Error(`A ${verdict} verdict needs findings: what and where`)
        return actions.setReview(stepId, verdict, findings)
      }

      case 'set_pr_review': {
        if (!isReview(task) || !task.prReview) throw new Error(`${task.key} is not a review of a teammate's PR`)
        if (!ctx.sessionId || !reviewTopicIds(task).includes(ctx.sessionId)) throw new Error(`set_pr_review is for a topic that runs ${task.key}`)
        const review = task.prReview!
        const format = formatOfTopic(review, store.data.sessions.find((s) => s.id === ctx.sessionId)) ?? review.shown
        const text = (v: unknown) => String(v ?? '').trim()
        // Each format records its own form (review-v2-part-2-v1-2.1): v1 a verdict with findings, v2 a report.
        if (format === 'v2') {
          if (args.report == null) throw new Error('Not recorded: this is the v2 review of the PR: record it with report (problem and approach beside it), not verdict and findings')
          const pr = review.pr
          const head = task.fact?.heads[pr.repo]
          const agent = reportArg(args.report, 'pr', head ? await reviewFact(project, task, Object.values(store.data.canvases), head) : null)
          const unknown = unknownDecisions(agent, project.directionDecisions)
          if (unknown.length) throw new Error(`Not recorded: no direction decision ${unknown.map((id) => `decision:${id}`).join(', ')}; cite those your job lists`)
          // A teammate's PR has no plan of ours and no rules mag enforces: CI is the floor mag owns there.
          const report = withFloor(agent, verdictFloor({ deviations: [], ci: await failedChecks(actions, pr.url), rules: [] }))
          return actions.setPrReview(task.id, ctx.sessionId, { problem: text(args.problem), approach: text(args.approach), verdict: prVerdictOf(report.checks), findings: reportFindings(report), report })
        }
        if (args.report != null) throw new Error('Not recorded: this is the v1 review of the PR: record verdict and findings (problem and approach beside them), no report')
        const verdict = args.verdict as PrVerdict
        if (!PR_VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${PR_VERDICTS.join(', ')}`)
        const findings = findingsArg(args.findings)
        if (findings.some((f) => !f.level)) throw new Error(`Every finding needs its level: ${FINDING_LEVELS.join(', ')}`)
        if (verdict === 'approve' && findings.some((f) => f.level === 'blocker')) throw new Error('A blocker and approve do not go together: request_changes, or drop the blocker and say why')
        return actions.setPrReview(task.id, ctx.sessionId, { problem: text(args.problem), approach: text(args.approach), verdict, findings, report: undefined })
      }

      case 'decide_direction': {
        if (!isReview(task)) throw new Error(`${task.key} is not a review of a teammate's PR`)
        if (!ctx.sessionId || !reviewTopicIds(task).includes(ctx.sessionId)) throw new Error(`decide_direction is for a topic that runs ${task.key}`)
        const choice = args.choice as DirectionChoice
        if (!DIRECTION_CHOICES.includes(choice)) throw new Error(`choice must be one of ${DIRECTION_CHOICES.join(', ')}`)
        const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
        return actions.decideDirection(task.id, { choice, option: opt(args.option), principle: opt(args.principle), draft: opt(args.draft) })
      }

      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }
}

/**
 * get_pr_changes of a work's repos: the files their branches change against where they left the base (T-58), with the
 * hunks numbered across the repos as a fact numbers them (diff-iak-inventar-zmin-ai.1).
 */
async function prChanges(project: Project, work: TaskWork, repos: RepoWork[]): Promise<string> {
  const notes: string[] = []
  const targets: ChangeTarget[] = []
  for (const r of repos) {
    const name = repoWorkName(work, r)
    // A worktree is removed once merged; the main checkout still has the branch.
    const inWorktree = !r.local && existsSync(r.worktree)
    const dir = inWorktree ? r.worktree : r.repo
    try {
      const target = await branchTarget(project, r, name, dir, await revParse(dir, inWorktree ? 'HEAD' : r.branch))
      if (target.base === target.head) notes.push(`${name}: no commits of its own on ${r.branch}.`)
      else targets.push(target)
    } catch (e) {
      notes.push(`${name}: cannot diff ${r.branch} (${e instanceof Error ? e.message.split('\n')[0] : e}).`)
    }
  }
  if (!targets.length) return notes.join('\n\n')
  return [...notes, prChangesText(await factChanges(project, targets, localGit), null)].join('\n\n')
}

/** The changed files of each repo, then the hunks with their ids; `only` keeps one repo (by name), numbered as in all. */
function prChangesText(changed: Changes, only: string | null): string {
  const repos = changed.repos.filter((r) => !only || r.name === only)
  const files = changed.files.filter((f) => repos.some((r) => r.name === f.repo))
  // The draft of the repos shown, by the hunks its units and noise cite.
  const shown = new Set(files.flatMap((f) => f.hunks.map((h) => h.id)))
  const ofShown = (hunks: string[]) => hunks.filter((h) => shown.has(h.split('.')[0]))
  const draft = {
    units: changed.draft.units.filter((u) => ofShown(u.hunks).length),
    noise: changed.draft.noise.map((n) => ({ ...n, hunks: ofShown(n.hunks) })).filter((n) => n.hunks.length),
  }
  return [...repos.map((r) => formatFiles(r.name, r.baseSha, r.headSha, files.filter((f) => f.repo === r.name))), draftListing({ draft }), hunkListing({ files })].filter(Boolean).join('\n\n')
}

/** Diagrams of a task: its own in the order they were drawn, then those of other tasks its doc links. */
function taskDiagrams(store: Store, taskId: string): Canvas[] {
  return workDiagrams(store.task(taskId), store.data.docs[taskId], Object.values(store.data.canvases))
}

/** Roles an agent places a diagram in; none takes it out of the groups. Facts come with the PR review (T-55.4). */
const PLACE_ROLES = ['option', 'plan', 'none'] as const

/**
 * A diagram's placement from tool arguments (T-55.3): role option with option, role plan with step and an optional
 * repo, role none to unplace. undefined when no role is passed: a revision keeps its placement.
 */
function placementArg(store: Store, task: Task | null, project: Project, args: Record<string, unknown>): CanvasPlacement | undefined {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const role = text(args.role)
  if (!role) {
    if (text(args.option) || text(args.step) || text(args.repo)) throw new Error('option, step and repo go with a role')
    return undefined
  }
  if (!(PLACE_ROLES as readonly string[]).includes(role)) throw new Error(`role must be one of ${PLACE_ROLES.join(', ')}`)
  const none = { role: null, option: null, stepId: null, repo: null, planOf: null }
  if (role === 'none') return none
  if (role === 'option') {
    if (text(args.step) || text(args.repo)) throw new Error('An option diagram has no step or repo')
    if (!text(args.option)) throw new Error('role option needs option: its name as in §Options, e.g. "A"')
    return { ...none, role: 'option', option: text(args.option) }
  }
  if (text(args.option)) throw new Error('A plan diagram has no option')
  if (!task) throw new Error('Plan diagrams belong to the steps of a task: draw them in its run')
  const key = text(args.step)
  const step = key && store.data.tasks.find((t) => t.parentId === task.id && t.key.toLowerCase() === key.toLowerCase())
  if (!step) throw new Error(`role plan needs step: the key of a step of ${task.key}, e.g. ${task.key}.1`)
  let repo: string | null = null
  if (text(args.repo)) {
    repo = projectRepo(project, text(args.repo)) ?? null
    if (!repo) throw new Error(`Not a repository of the project: ${text(args.repo)}; one of ${repoNames(project).join(', ') || '(none)'}`)
    if (step.repos && !step.repos.includes(repo)) throw new Error(`${step.key} does not change ${text(args.repo)}; its repos: ${stepRepoNames(step, project)!.join(', ') || '(none)'}`)
  }
  return { ...none, role: 'plan', stepId: step.id, repo }
}

/** A diagram's placement as tools show it: step keys and repo names; a diagram of another task says whose. */
function placementOut(store: Store, project: Project, taskId: string, c: Canvas) {
  const keyOf = (id: string | null | undefined) => (id ? store.data.tasks.find((t) => t.id === id)?.key : undefined)
  return {
    // A role of an older model (intent) reads as none.
    role: c.role && CANVAS_ROLES.includes(c.role) ? c.role : undefined,
    option: c.option ?? undefined,
    step: keyOf(c.stepId),
    repo: c.repo ? repoName(project, c.repo) : undefined,
    of: c.taskId !== taskId ? (keyOf(c.taskId) ?? 'another task') : undefined,
  }
}

/** The short name of a project repository (see repoNames); the path of one removed since. */
const repoName = (project: Project, path: string) => repoNames(project)[project.repos.indexOf(path)] ?? path

/** " as option A", " in the plan of T-1.2 (api)", " in the fact of T-1.2", or " (unplaced)". */
function placedAs(store: Store, project: Project, p: CanvasPlacement): string {
  if (p.role === 'option') return ` as option ${p.option}`
  if (p.role === 'fact' && !p.stepId) return ' as the fact'
  if (p.role !== 'plan' && p.role !== 'fact') return ' (unplaced)'
  const key = store.data.tasks.find((t) => t.id === p.stepId)?.key
  return ` in the ${p.role} of ${key}${p.repo ? ` (${repoName(project, p.repo)})` : ''}`
}

/** Moves the project-chat canvases a task doc links into the task; says so in the tool's answer. */
function adopted(store: Store, taskId: string, md: string): string {
  const moved = store.adoptCanvases(taskId, linkedCanvasIds(md))
  return moved.length ? ` Moved into ${store.task(taskId).key}, as the doc links them: ${moved.map((c) => c.id).join(', ')}.` : ''
}

/** "+2 ~1 −0", or "no changes". */
const changes = (c: Canvas) => formatDiffCount(diagramSummary(c.diagram!)) || 'no changes'

/** Where a fact set is: a step's (its reviewer's) or a review's (its topic's), with the heads it is of. */
type FactPlace = { step: Task; work?: undefined; heads: Record<string, string> } | { step?: undefined; work: Task; heads: Record<string, string> }

/** The fact set a run writes: the reviewer's step, or the review its topic owns; null for any other run. */
function factPlace(store: Store, ctx: ToolContext, task: Task, role: string | undefined): FactPlace | null {
  if (role === 'reviewer') {
    const step = runStep(store, ctx)
    return step ? { step, heads: step.fact?.heads ?? {} } : null
  }
  const pr = task.prReview?.pr
  if (isReview(task) && pr && !!ctx.sessionId && reviewTopicIds(task).includes(ctx.sessionId)) return { work: task, heads: task.fact?.heads[pr.repo] ? { [pr.repo]: task.fact.heads[pr.repo] } : {} }
  return null
}

const placeSet = (store: Store, place: FactPlace) => (place.step ? stepSet(Object.values(store.data.canvases), place.step.id, 'fact') : reviewFacts(Object.values(store.data.canvases), place.work.id))

/**
 * set_inventory (diff-iak-inventar-zmin-ai.1): the reviewer's change inventory of the PRs becomes the root of the fact
 * set, a Component diagram mag generates from it, with a Data diagram when stored data changes; the Component and Data
 * diagrams drawn before leave the set. mag checks it against the hunks, records the fact and says what is left.
 */
async function setInventory(store: Store, project: Project, ctx: ToolContext, task: Task, role: string | undefined, raw: unknown): Promise<string> {
  const place = factPlace(store, ctx, task, role)
  if (!place) throw new Error("set_inventory is for the reviewer of a step and for the topic that owns a review of a teammate's PR")
  if (!Object.keys(place.heads).length) throw new Error(place.step ? `${place.step.key} has no PR heads under review yet` : 'Call get_pr_changes first: it reads the PR at its head')
  const canvases = Object.values(store.data.canvases)
  const options = { draft: true }
  const changed = place.step ? await stepChanges(project, place.step, place.heads, canvases, options) : await reviewChanges(project, place.work, place.heads[place.work.prReview!.pr.repo], options)
  // The reviewer's units over mag's draft of the same heads: what it left out stays as mag drafted it.
  const { inventory, errors } = mergeDraft(changed.draft, raw)
  if (errors.length) throw new Error(`Not saved. Fix and call again:\n- ${errors.join('\n- ')}`)
  const set = placeSet(store, place)
  const prevRoot = factRoot(set)
  const root = prevRoot?.diagram!.type === 'component' ? prevRoot : undefined
  const prevData = set.find((c) => c.diagram!.type === 'data' && c !== root)
  const key = (place.step ?? place.work).key
  const placement: CanvasPlacement = place.step
    ? { role: 'fact', option: null, stepId: place.step.id, repo: null, planOf: null }
    : { role: 'fact', option: null, stepId: null, repo: place.work.prReview!.pr.repo, planOf: null }
  const base = { projectId: project.id, taskId: place.step ? place.step.parentId : place.work.id, sessionId: ctx.sessionId ?? null, kind: 'diagram' as const }
  const { data } = factDiagrams(inventory, changed, project, set)
  const dataCanvas = data ? store.saveCanvas({ ...base, id: prevData?.id, title: `${key}: fact — data`, diagram: data, placement }) : undefined
  const { component } = factDiagrams(inventory, changed, project, set, dataCanvas?.id)
  const rootCanvas = store.saveCanvas({ ...base, id: root?.id, title: `${key}: fact`, diagram: component, placement, root: true, inventory })
  // Component and Data diagrams drawn before (a copy of the plan, a drawn fact) leave the set: mag's replace them.
  const none: CanvasPlacement = { role: null, option: null, stepId: null, repo: null, planOf: null }
  for (const c of set) if (generated(c) && c.id !== rootCanvas.id && c.id !== dataCanvas?.id) store.placeCanvas(c.id, none)
  showInChat(store, ctx, rootCanvas)
  const fact = place.step
    ? await stepFact(project, place.step, place.heads, Object.values(store.data.canvases), changed)
    : await reviewFact(project, place.work, Object.values(store.data.canvases), undefined, changed)
  store.updateTask((place.step ?? place.work).id, { fact: factRecord(fact, place.heads) })
  const saved = `Inventory saved: ${inventory.units.length} units; mag generated [${rootCanvas.title}](canvas:${rootCanvas.id}) (v${rootCanvas.version}, the root)${dataCanvas ? ` and [${dataCanvas.title}](canvas:${dataCanvas.id}) (v${dataCanvas.version})` : ''}. Draw scenarios and method logic with show_diagram, without role.`
  return `${saved}\n${factReport(fact)}`
}

/**
 * A revision of a diagram of a fact set (T-58; the whole set since povnyi-diff-nabir-pov-iazanykh.1): mag checks the
 * set again (the inventory against the hunks, links, plan ↔ fact), records it for the merge threshold, and says what
 * the reviewer has left to fix.
 */
async function factCheck(store: Store, project: Project, canvas: Canvas): Promise<string> {
  const work = !canvas.stepId && canvas.taskId ? store.data.tasks.find((t) => t.id === canvas.taskId) : undefined
  if (work && isReview(work)) return reviewFactCheck(store, project, work)
  const step = canvas.stepId ? store.data.tasks.find((t) => t.id === canvas.stepId) : undefined
  if (!step?.fact) return ''
  try {
    const fact = await stepFact(project, step, step.fact.heads, Object.values(store.data.canvases))
    store.updateTask(step.id, { fact: factRecord(fact, step.fact.heads) })
    if (!fact.blockers.length && !fact.warnings.length && !fact.inventoryCheck?.undeclared.length && !fact.inventoryCheck?.noiseClaims.length)
      return ' The inventory accounts for every block of changed code and rests on its hunks, the set hangs together and the fact agrees with the plan: merge is allowed.'
    return `\n${factReport(fact)}`
  } catch (e) {
    log.warn('tools', `fact check of ${canvas.id} failed: ${(e as Error).message}`)
    return ''
  }
}

/** A revision of a review's fact set (reviews-ahent-reviuit-pr-timeitiv.2): checked again and recorded, as for a step. */
async function reviewFactCheck(store: Store, project: Project, work: Task): Promise<string> {
  const pr = work.prReview?.pr
  const head = pr && work.fact?.heads[pr.repo]
  if (!head) return ''
  try {
    const fact = await reviewFact(project, work, Object.values(store.data.canvases), head)
    store.updateTask(work.id, { fact: factRecord(fact, work.fact!.heads) })
    if (!fact.blockers.length && !fact.warnings.length && !fact.inventoryCheck?.undeclared.length && !fact.inventoryCheck?.noiseClaims.length)
      return ' The inventory accounts for every block of changed code and rests on its hunks, and the set hangs together.'
    return `\n${factReport(fact)}`
  } catch (e) {
    log.warn('tools', `fact check of ${work.key} failed: ${(e as Error).message}`)
    return ''
  }
}

/**
 * What a fact set takes from show_diagram (diff-iak-inventar-zmin-ai.1): mag generates its Component and Data diagrams
 * from the inventory, so only scenarios and the logic of a method with nontrivial logic are drawn. Throws otherwise.
 */
function factDrawing(set: Canvas[], diagram: { type: string }): void {
  if (diagram.type !== 'sequence' && diagram.type !== 'flowchart')
    throw new Error(`Not saved: mag generates the fact's Component and Data diagrams from the inventory (set_inventory); a fact set takes only sequence and flowchart diagrams`)
  const refusal = flowchartRefusal(factRoot(set)?.inventory ?? null, diagram as Parameters<typeof flowchartRefusal>[1])
  if (refusal) throw new Error(`Not saved: ${refusal}`)
}

/** After a scenario of a fact set changes, the generated root links it from the modules that take part in it. */
function relinkScenarios(store: Store, set: Canvas[]): void {
  const root = set.find((c) => c.inventory && c.diagram!.type === 'component')
  if (!root) return
  const diagram = withScenarioLinks(root.diagram as ComponentDiagram, scenariosOf(set))
  if (JSON.stringify(diagram) === JSON.stringify(root.diagram)) return
  store.saveCanvas({ id: root.id, projectId: root.projectId, taskId: root.taskId, sessionId: root.sessionId, title: root.title, kind: 'diagram', diagram })
}

/**
 * Where the diagram breaks a rule of the diff (diagramWarnings) and the set it is in does not hang together, as notes
 * of show_diagram's answer; '' when neither.
 */
function setNote(store: Store, canvas: Canvas): string {
  const own = diagramWarnings(canvas.diagram!)
  const set = setKey(canvas) ? validateLinks(setOf(canvas, Object.values(store.data.canvases))) : []
  const list = (ws: string[]) => ws.map((w) => `- ${w}`).join('\n')
  return (
    (own.length ? `\nSaved, but fix it and revise it by id:\n${list(own)}` : '') + (set.length ? `\nThe set of this diagram does not hang together yet:\n${list(set)}` : '')
  )
}

/** Unowned files listed in the answer of set_architecture; the rest is a count. */
const UNOWNED_SHOWN = 30

/**
 * Records the module tree. Ids must be unique in the whole tree; uses of unknown ids or of the module itself are
 * dropped, repeats of one target merged. A plain string in `uses` counts as `{ to, calls: [] }`. Every module gets a
 * level (top: system, inside: module) and `paths` (a legacy `path` joins them); two modules may not give one path. A
 * module that is a previous one under a new id gets its old id back (T-57.2). Code files of the repos no module owns
 * are listed in the answer: the architect adds them and calls again.
 */
async function setArchitecture(store: Store, project: Project, args: Record<string, unknown>) {
  const modules = Array.isArray(args.modules) ? (args.modules as ArchNode[]) : null
  if (!modules?.length) throw new Error('modules is required')
  const ids = new Set<string>()
  const dupes = new Set<string>()
  walkArch(modules, (n) => {
    if (typeof n.id !== 'string' || !n.id) throw new Error(`Module "${n.name ?? '?'}" has no id`)
    if (ids.has(n.id)) dupes.add(n.id)
    ids.add(n.id)
  })
  if (dupes.size) throw new Error(`Ids must be unique in the whole tree; repeated: ${[...dupes].join(', ')}`)
  let dropped = 0
  walkArch(modules, (n, ancestors) => {
    const uses = (Array.isArray(n.uses) ? n.uses : []).map((u: ArchUse | string) =>
      typeof u === 'string' ? { to: u, calls: [] } : { to: u.to, calls: Array.isArray(u.calls) ? u.calls.map(String) : [] },
    )
    const kept = uses.filter((u) => ids.has(u.to) && u.to !== n.id)
    dropped += uses.length - kept.length
    // One use per target, with the calls of all its repeats.
    const byTo = new Map<string, ArchUse>()
    for (const u of kept) {
      const seen = byTo.get(u.to)
      if (seen) seen.calls.push(...u.calls.filter((c) => !seen.calls.includes(c)))
      else byTo.set(u.to, u)
    }
    n.uses = [...byTo.values()]
    if (n.children && !n.children.length) delete n.children
    const level = n.level ?? (ancestors.length ? 'module' : 'system')
    if (level !== 'system' && level !== 'module') throw new Error(`${n.id}: level must be system or module`)
    if (level === 'system' && ancestors.some((a) => a.level === 'module')) throw new Error(`${n.id}: a system cannot be inside a module`)
    n.level = level
    const paths = [...(Array.isArray(n.paths) ? n.paths : []), ...(typeof n.path === 'string' ? [n.path] : [])].map((p) => String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean)
    const outside = paths.find((p) => p.startsWith('/') || p.startsWith('~') || p.split('/').includes('..'))
    if (outside) throw new Error(`${n.id}: paths are relative to the repository, inside it; got "${outside}"`)
    delete n.path
    if (paths.length) n.paths = [...new Set(paths)]
    else delete n.paths
  })
  const shared = sharedPaths(vocabularyOf(modules))
  if (shared.length) throw new Error(`A file belongs to one module; paths given by several: ${shared.map((s) => `"${s.path}" (${s.modules.join(', ')})`).join(', ')}`)
  const trees = await Promise.all(project.repos.map((r) => treeAt(r, 'HEAD').then((t) => t.map((f) => f.path)).catch(() => null)))
  const files = trees.flatMap((t) => t ?? [])
  const renamed = carryIds(project.architecture?.modules ?? [], modules, files)
  const recorded = renameIds(modules, renamed)
  store.updateProject(project.id, { architecture: { summary: String(args.summary ?? ''), modules: recorded, updatedAt: Date.now() } })
  const notes = [`Recorded ${ids.size} module(s), ${modules.length} on the top level.`]
  if (dropped) notes.push(`Dropped ${dropped} use(s) of unknown ids or of the module itself.`)
  if (renamed.size) notes.push(`Kept the previous ids of modules that own the same code: ${[...renamed].map(([a, b]) => `${a} → ${b}`).join(', ')}.`)
  const vocabulary = vocabularyOf(recorded)
  const missing = project.repos.flatMap((r, i) => (trees[i] ? unowned(vocabulary, trees[i]).map((f) => (project.repos.length > 1 ? `${repoName(project, r)}:${f}` : f)) : []))
  if (missing.length) {
    const shown = missing.slice(0, UNOWNED_SHOWN).join(', ') + (missing.length > UNOWNED_SHOWN ? ` and ${missing.length - UNOWNED_SHOWN} more` : '')
    notes.push(`${missing.length} code file(s) belong to no module: ${shown}. Every code file must be in exactly one module: add them to the paths of the modules that own them and call set_architecture again with the full tree.`)
  }
  return notes.join(' ')
}

/** The idea a topic discusses leaves the list once that topic owns a work: the work carries it on. */
function ideaBecameWork(store: Store, topicId: string) {
  for (const i of store.data.ideas.filter((x) => x.topicId === topicId)) store.deleteIdea(i.id)
}

/** Puts a card of the canvas into the run's chat. */
function showInChat(store: Store, ctx: ToolContext, canvas: Canvas) {
  const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
  session?.items.push({ kind: 'canvas', canvas: { id: canvas.id, title: canvas.title, version: canvas.version }, at: Date.now() })
  store.changed()
}

/** Tools that work in task runs and project chats alike. Returns undefined when `name` is not one of them. */
function sharedTool(
  store: Store,
  actions: ToolActions,
  project: Project,
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): string | Promise<string> | undefined {
  const tasks = store.data.tasks.filter((t) => t.projectId === project.id)
  const byKey = (key: unknown) => {
    const t = taskByKey(tasks, String(key))
    if (!t) throw new Error(`No task ${key}`)
    return t
  }
  const keyOf = (id: string) => tasks.find((t) => t.id === id)?.key ?? id
  const withSubtasks = (t: Task): Task[] => [t, ...subtasksOf(t.id, tasks).flatMap(withSubtasks)]

  switch (name) {
    case 'list_tasks': {
      const works = workSections(tasks)
      return JSON.stringify(
        {
          project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
          tasks: [...works.inProgress, ...works.ready, ...works.planning, ...works.finished].flatMap(withSubtasks).map((t) => ({
            key: t.key,
            title: t.title,
            type: t.type,
            status: t.status,
            parent: t.parentId ? keyOf(t.parentId) : undefined,
            needsInput: t.needsInput ?? undefined,
            prs: t.work?.repos.flatMap((r) => (r.prUrl ? [`${r.prUrl} (${r.prState ?? 'unknown'})`] : [])),
            tickets: t.tickets?.length ? t.tickets.map((x) => x.url) : undefined,
            cancelReason: t.cancelReason ?? undefined,
          })),
          ideas: projectIdeas(store.data.ideas, project.id).map((i) => ({ text: i.text, source: i.source ?? undefined })),
        },
        null,
        2,
      )
    }

    case 'read_chat': {
      const id = String(args.id ?? '').trim()
      const sessions = store.data.sessions.filter((s) => s.projectId === project.id)
      const item = sessions.find((s) => s.id === id) ?? tasks.find((t) => t.id === id) ?? taskByKey(tasks, id)
      if (!id || !item) throw new Error(`No chat ${id} in this project: pass a topic id, a work key or a task id`)
      const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0
      const page = chatTranscript(item, sessions, 'key' in item ? store.data.docs[item.id] : '', offset)
      return `${page.text}\n\n${page.next === null ? '(end of the chat)' : `(more: call read_chat with offset ${page.next})`}`
    }

    case 'read_task': {
      const t = byKey(args.key)
      return JSON.stringify({ ...t, parent: t.parentId && keyOf(t.parentId), doc: store.data.docs[t.id] ?? '(empty)' }, null, 2)
    }

    case 'create_work': {
      const md = typeof args.doc === 'string' ? args.doc : ''
      const plan = args.plan === true
      const steps = stepsArg(args.steps)
      const title = String(args.title ?? '').replace(/\s+/g, ' ').trim()
      if (!title) throw new Error('title is required')
      if (plan && !md.trim()) throw new Error('plan: true needs the full doc')
      if (plan && !steps.length) throw new Error('plan: true needs steps: at least one { title, note?, start_manually? }')
      // The links are checked first: a bad one creates nothing.
      const tickets = ticketsArg(args.tickets)
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      const owner = session?.role === 'chat' ? session.id : undefined
      const t = store.createTask({
        projectId: project.id,
        title,
        type: taskType(args.type),
        description: String(args.description ?? ''),
        // The topic that creates a work plans it (T-55.5): no groomer, it is in planning from the start.
        status: plan ? 'ready' : 'planning',
        tickets,
        // The topic that discussed it owns the work: it plans it, and its fork reviews the PRs first (T-55.1).
        ownerSessionId: owner,
      })
      if (md.trim()) {
        store.data.docs[t.id] = md
        store.changed()
      }
      for (const s of steps) store.createTask({ projectId: project.id, parentId: t.id, title: s.title, type: t.type, description: s.note, status: 'todo', startManually: s.startManually })
      const moved = adopted(store, t.id, md)
      if (owner) ideaBecameWork(store, owner)
      if (plan) return `Created ${t.key}, ready; the user starts it.${moved}`
      return owner
        ? `Created ${t.key}; you own it and plan it here: pass work: "${t.key}" to the owner tools (update_doc, show_diagram, place_diagram, create_subtask…). The user approves the plan when it is ready.${moved}`
        : `Created ${t.key} in planning; nobody owns it yet: start_grooming plans it.${moved}`
    }

    case 'add_ticket': {
      const t = byKey(args.key)
      if (t.parentId) throw new Error(`${t.key} is a step; add the ticket to its work ${keyOf(t.parentId)}`)
      const ticket = ticketRef(String(args.url ?? ''), typeof args.ticket_key === 'string' ? args.ticket_key : null)
      store.updateTask(t.id, { tickets: withTicket(t.tickets, ticket) })
      return `${t.key} is about ${ticket.key ?? ticket.url} now (${store.task(t.id).tickets!.length} ticket(s)).`
    }

    case 'reopen_work': {
      const t = byKey(args.key)
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      if (session?.role !== 'chat') throw new Error('reopen_work is for a project chat')
      const said = actions.reopen(t.id, String(args.what ?? ''), session.id)
      ideaBecameWork(store, session.id)
      return `${said} Plan what is left right here: update_doc, diagrams and create_subtask with work: "${t.key}"; its done steps stay. The user approves the plan when it is ready.`
    }

    case 'review_pr': {
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      if (session?.role !== 'chat') throw new Error('review_pr is for a project topic')
      const format = args.format == null || args.format === '' ? undefined : (args.format as ReviewFormat)
      if (format && !REVIEW_FORMATS.includes(format)) throw new Error(`format must be one of ${REVIEW_FORMATS.join(', ')}`)
      return actions.reviewPr(project.id, String(args.url ?? ''), session.id, format).then((r) => r.job)
    }

    case 'export_review': {
      const t = byKey(args.key)
      if (!isReview(t)) throw new Error(`${t.key} is not a review of a PR`)
      const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined
      return actions.exportReview(t.id, path).then((file) => `Exported ${t.key} to ${file}. Tell the user the path; on another mag it opens with Import review in the work list's PR field.`)
    }

    case 'branch_topic': {
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      if (session?.role !== 'chat' || session.taskId) throw new Error('branch_topic is for a project topic')
      const id = actions.branchChat(session.id, typeof args.text === 'string' ? args.text : undefined)
      const title = store.session(id).title
      return `Branched into a new topic "${title}" (${id})${typeof args.text === 'string' && args.text.trim() ? '; its agent answers the first message there' : ''}. Tell the user it is in Topics; go on here only with this topic's own question.`
    }

    case 'add_idea': {
      // A step's developer or reviewer found it in that step; a groomer or an owner topic in its work.
      const stepId = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId)?.stepId : null
      const source = stepId ? store.task(stepId).key : ctx.taskId ? store.task(ctx.taskId).key : null
      store.addIdea(project.id, String(args.text ?? ''), source)
      return "Added to the project's ideas; the user decides if it becomes a work. Go on with yours."
    }

    case 'update_task': {
      const t = byKey(args.key)
      const patch: Partial<Task> = {}
      if (typeof args.title === 'string') patch.title = args.title
      if (typeof args.description === 'string') patch.description = args.description
      store.updateTask(t.id, patch)
      return `Updated ${t.key}.`
    }

    case 'update_task_doc': {
      const t = byKey(args.key)
      const md = String(args.markdown ?? '')
      store.data.docs[t.id] = md
      store.changed()
      return `Document of ${t.key} updated.${adopted(store, t.id, md)}`
    }

    case 'start_grooming': {
      const t = byKey(args.key)
      if (t.parentId) throw new Error(`${t.key} is a subtask; groom its parent ${keyOf(t.parentId)}`)
      actions.groom(t.id)
      return `Groomer started on ${t.key}.`
    }

    case 'cancel_task': {
      const t = byKey(args.key)
      if (!canCancel(t)) throw new Error(`${t.key} is ${t.status}${t.parentId ? ' (a subtask)' : ''}; only tasks not done or canceled yet can be canceled`)
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null
      return actions.cancel(t.id, reason).then(() => `Canceled ${t.key}.${taskPrs(t).some((r) => r.prState === 'open') ? ' Its open PRs are left as they are.' : ''}`)
    }

    // The buttons of a work, for a project chat the user asked (chat-keruie-robotamy-i-ahentamy.1): the same methods.
    case 'approve_plan':
    case 'start_work':
    case 'start_step':
    case 'restart_review':
    case 'message_agent':
    case 'stop_agent':
      return controlTool(store, actions, project, ctx, name, args, byKey)

    case 'update_notes':
      store.updateProject(project.id, { notes: String(args.notes ?? '') })
      return 'Notes updated.'

    case 'run_architect':
      actions.architect(project.id)
      return 'Architect started; the diagram updates when it finishes.'

    case 'get_architecture':
      return project.architecture ? JSON.stringify(project.architecture, null, 2) : 'No architecture recorded yet.'

    case 'set_architecture':
      return setArchitecture(store, project, args)

    case 'check_architecture': {
      const work = ctx.taskId ? runWork(store, ctx) : null
      // Worktrees are removed once merged; only the ones still there have code to check.
      const repos = work?.repos.filter((r) => existsSync(r.worktree)) ?? []
      if (work && repos.length === 1) return formatReport(analyze(repos[0].worktree))
      if (work && repos.length) return repos.map((r) => `## ${repoWorkName(work, r)}\n${formatReport(analyze(r.worktree))}`).join('\n\n')
      if (!project.repos[0]) throw new Error('Project has no repository')
      return formatReport(analyze(project.repos[0]))
    }

    case 'request_integration': {
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      if (!session) throw new Error('This run has no chat to ask in: say the integration is off in mag; the user turns it on in Project → Integrations')
      const id = String(args.id ?? '').trim()
      const integration = store.data.integrations.find((i) => i.id === id && i.id !== MAG_MCP_ID)
      if (!integration) throw new Error(`No integration ${id || '(none)'}; the ids are in your prompt`)
      const mode = integrationMode(project, session.role, id)
      if (mode !== 'off') return `${integration.name} is already on (${mode}) for the ${session.role} role in mag; it applies from your next turn.`
      // One card per integration while it is still off.
      if (!session.items.some((i) => i.kind === 'integration' && i.integrationId === id && i.status === 'off')) {
        const why = String(args.why ?? '').replace(/\s+/g, ' ').trim()
        store.pushItem(session.id, { kind: 'integration', id: randomUUID(), integrationId: id, server: integration.name, role: session.role, why, status: 'off', at: Date.now() })
      }
      return `The user is asked to turn on ${integration.name}. End your turn now, saying ${integration.name} is turned off in mag for the ${session.role} role; once it is on, mag tells you to repeat your last step.`
    }

    case 'show_canvas': {
      const html = String(args.html ?? '')
      if (!html.trim()) throw new Error('html is required')
      const canvas = store.saveCanvas({
        id: args.id ? String(args.id) : undefined,
        projectId: project.id,
        taskId: ctx.taskId ?? null,
        sessionId: ctx.sessionId ?? null,
        title: String(args.title ?? 'Canvas'),
        kind: 'html',
        html,
      })
      showInChat(store, ctx, canvas)
      return `Shown to the user as canvas ${canvas.id} (v${canvas.version}).`
    }

    case 'show_diagram': {
      // Some agent CLIs pass a nested object as a JSON string.
      let raw = args.diagram
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw)
        } catch {
          throw new Error('diagram must be an object (or its JSON)')
        }
      }
      const diagram = normalizeDiagram(raw)
      const errors = validateDiagram(diagram)
      if (errors.length) throw new Error(`Not saved. Fix and call again:\n- ${errors.join('\n- ')}`)
      const id = args.id ? String(args.id) : undefined
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      const reviewer = session?.role === 'reviewer'
      const task = ctx.taskId ? store.task(ctx.taskId) : null
      const prev = id ? store.data.canvases[id] : undefined
      const none = { option: null, repo: null, planOf: null }
      let placement: CanvasPlacement | undefined
      if (reviewer) {
        // A reviewer draws the fact set of the step under review (povnyi-diff-nabir-pov-iazanykh.1): revises its diagrams, adds new ones to it.
        if (prev && (prev.role !== 'fact' || prev.stepId !== session.stepId)) throw new Error('A reviewer revises only the fact set of the step under review: pass the id of one of its diagrams, or none to add one to it')
        placement = prev ? undefined : { ...none, role: 'fact', stepId: session.stepId! }
      } else if (task && isReview(task) && !prev && args.role === undefined) {
        // The topic of a review draws its fact set: a new diagram without a role joins it.
        placement = { ...none, role: 'fact', stepId: null, repo: task.prReview?.pr.repo ?? null }
      } else placement = placementArg(store, task, project, args)
      const role = placement?.role ?? prev?.role
      const factSet = role === 'fact' ? setOf<Canvas>({ ...(prev ?? { id: '', projectId: project.id, taskId: ctx.taskId ?? null, sessionId: null, title: '', version: 0, updatedAt: 0 }), ...placement, kind: 'diagram', diagram } as Canvas, Object.values(store.data.canvases)) : null
      if (factSet) {
        if (prev && generated(prev)) throw new Error(`Not saved: ${prev.id} is generated by mag from the inventory; change the inventory with set_inventory`)
        factDrawing(factSet, diagram)
      }
      const root = factSet ? undefined : typeof args.root === 'boolean' ? args.root : undefined
      // One flow per method in a set: a second flowchart of the same method is revised by id instead.
      const of = diagram.type === 'flowchart' && diagram.of ? parseFlowRef(diagram.of) : null
      if (of && ctx.taskId) {
        const key = setKey({ ...(prev ?? { taskId: ctx.taskId, role: null, option: null, stepId: null }), ...placement, kind: 'diagram', diagram })
        const same = taskDiagrams(store, ctx.taskId).find((c) => {
          if (c.taskId !== ctx.taskId || setKey(c) !== key) return false
          const ref = c.id !== id && c.diagram!.type === 'flowchart' && c.diagram!.of ? parseFlowRef(c.diagram!.of) : null
          return ref?.module === of.module && ref.method === of.method
        })
        if (same) throw new Error(`Not saved: flowchart ${same.id} ("${same.title}") already shows ${of.module}#${of.method} in this set; revise it with id ${same.id}`)
      }
      const canvas = store.saveCanvas({
        id,
        projectId: project.id,
        taskId: ctx.taskId ?? null,
        sessionId: ctx.sessionId ?? null,
        title: String(args.title ?? 'Diagram'),
        kind: 'diagram',
        diagram,
        placement,
        root,
      })
      showInChat(store, ctx, canvas)
      const saved = `Diagram ${canvas.id} (v${canvas.version})${canvas.role ? placedAs(store, project, canvas) : ''}${canvas.root ? ', the root of its set' : ''}: ${changes(canvas)}. Link it as [${canvas.title}](canvas:${canvas.id}), a node as canvas:${canvas.id}#<node-id>${setKey(canvas) ? `; another diagram of its set links it with links: [{ to: "${canvas.id}", node?, kind }]` : ''}.`
      if (canvas.role === 'fact' && canvas.diagram!.type === 'sequence') relinkScenarios(store, setOf(canvas, Object.values(store.data.canvases)))
      // A fact set's warnings come with its check.
      return canvas.role === 'fact' ? factCheck(store, project, canvas).then((note) => saved + note) : saved + planCheck(project, canvas.diagram!) + setNote(store, canvas)
    }
  }
  return undefined
}

/**
 * A project chat does what the user's buttons do, when the user asks it (chat-keruie-robotamy-i-ahentamy.1): approve,
 * start a work or a step, restart a review, write to an agent, stop one. Each calls the orchestrator method its button
 * does, so the checks are the same; each done action is a line in the project's log.
 */
async function controlTool(store: Store, actions: ToolActions, project: Project, ctx: ToolContext, name: string, args: Record<string, unknown>, byKey: (key: unknown) => Task): Promise<string> {
  const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
  if (session?.role !== 'chat') throw new Error(`${name} is for a project chat`)
  const t = byKey(args.key)
  const work = t.parentId ? store.task(t.parentId) : t
  const logged = (what: string, of: Task = t) => {
    store.logEvent({ projectId: project.id, taskId: work.id, taskKey: of.key, kind: 'chat', text: `chat: ${what} ${of.key} at the user's request` })
    log.info('tools', `chat ${session.id}: ${what} ${of.key}`)
  }
  /** A step key names the current step of its work; the actions on a step work on that one. */
  const current = () => {
    const step = currentStep(work.id, store.data.tasks)
    if (t.parentId && step?.id !== t.id) throw new Error(`${t.key} is ${t.status}; the current step of ${work.key} is ${step?.key ?? 'none'}`)
    return step
  }

  switch (name) {
    case 'approve_plan': {
      actions.approve(t.id)
      logged('approved')
      return `${t.key} is approved: ready to start.`
    }

    case 'start_work': {
      if (t.parentId) throw new Error(`${t.key} is a step: start its work ${work.key}, or start_step for a step that starts manually`)
      const local = args.local_repos == null ? undefined : reposArg(args.local_repos, project)
      // A plan in planning is approved and started in one go (ux-odna-rozmova-na-robotu.1).
      const approving = t.status === 'planning'
      await (approving ? actions.approveAndStart(t.id, local) : actions.develop(t.id, local))
      logged(approving ? 'approved and started' : 'started')
      const now = store.task(t.id)
      const step = currentStep(t.id, store.data.tasks)
      return `${approving ? 'Approved and started' : 'Started'} ${t.key}${step ? ` on ${step.key}` : ''}${local?.length ? `, locally in ${local.map((r) => repoName(project, r)).join(', ')}` : ''}.${now.needsInput ? ` It needs the user: ${now.needsInput}` : ''}`
    }

    case 'start_step': {
      const step = current()
      await actions.startStep(work.id)
      logged('started step', step ?? t)
      return `Started ${step?.key ?? work.key}.`
    }

    case 'restart_review': {
      const step = current()
      await actions.restartReview(work.id)
      logged('restarted the review of', step ?? t)
      return `The review of ${step?.key ?? work.key} is restarted, unless its last review already covers its PRs.`
    }

    case 'message_agent': {
      const role = typeof args.role === 'string' && args.role.trim() ? args.role.trim() : undefined
      if (role && !(MESSAGED_ROLES as readonly string[]).includes(role)) throw new Error(`role must be one of ${MESSAGED_ROLES.join(', ')}`)
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text is required')
      const agent = actions.agentOf(t.id, role as MessagedRole | undefined)
      if (!agent) throw new Error(`${t.key} has no ${role ?? 'agent'} to write to${role ? '' : ` (${MESSAGED_ROLES.join(', ')})`}`)
      await actions.send(agent.id, text)
      logged(`wrote to the ${agent.role} of`)
      return `Sent to the ${agent.role} of ${t.key}; it goes on with it.`
    }

    case 'stop_agent': {
      const stopped = await actions.stopAgents(t.id)
      if (!stopped.length) throw new Error(`No agent of ${t.key} is working`)
      logged('stopped')
      return `Stopped the ${[...new Set(stopped.map((s) => s.role))].join(', ')} of ${t.key}.`
    }
  }
  throw new Error(`Unknown tool ${name}`)
}

