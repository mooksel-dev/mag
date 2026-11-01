import { DEFAULT_TEMPLATES, REVIEW_VERDICTS, linkedCanvasIds, stepDiagrams, taskDiagrams as workDiagrams, SUBTASK_STATUSES, workSections, projectIdeas, canCancel, taskByKey, currentStep, diagramSummary, findRepoWork, formatDiffCount, isLegacy, normalizeDiagram, parseFlowRef, projectRepo, prRollup, repoNames, repoWorkName, stepRepoNames, subtaskProgress, subtaskStatusChanges, subtasksOf, taskPrs, ticketRef, withTicket, validateDiagram, walkArch, type ArchNode, type ArchUse, type Canvas, type CanvasPlacement, type Project, type RepoWork, type ReviewFinding, type ReviewVerdict, type SubtaskStatus, type Task, type TaskType, type TaskWork, type TicketRef } from '@mag/core'
import { existsSync } from 'node:fs'
import { analyze, formatReport } from '@mag/arch'
import type { Store } from './store'
import { changedRepos } from './git.ts'
import { OWNER_TOOLS, TOOL_DEFS, toolForRole } from './tool-defs.ts'

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
  setReview(stepId: string, verdict: ReviewVerdict, findings: ReviewFinding[]): string
  /** Continue a done work (T-55.6): back to planning; `by`, the topic asking, owns it. Returns what to tell the agent. */
  reopen(taskId: string, what: string, by?: string): string
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

/** Review findings from a tool argument: [{ text, where? }]; some agent CLIs pass the array as a JSON string. */
function findingsArg(v: unknown): ReviewFinding[] {
  let raw = v ?? []
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new Error('findings must be an array of { text, where? }')
    }
  }
  if (!Array.isArray(raw)) throw new Error('findings must be an array of { text, where? }')
  return raw.map((x: Record<string, unknown>) => {
    const text = String(x?.text ?? '').trim()
    if (!text) throw new Error('Every finding needs a text')
    const where = typeof x.where === 'string' && x.where.trim() ? x.where.trim() : undefined
    return where ? { text, where } : { text }
  })
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
  if (work.ownerSessionId !== ctx.sessionId) throw new Error(`${work.key} is not planned in this topic${work.ownerSessionId ? ' (its owner is another session)' : ''}: only its owner changes its plan`)
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
              repos: work.repos.map((r) => ({ name: repoWorkName(work, r), repo: r.repo, worktree: r.worktree, branch: r.branch, prUrl: r.prUrl, prState: r.prState })),
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
          list.map((c) => ({ id: c.id, title: c.title, version: c.version, changes: changes(c), ...placementOut(store, project, task.id, c), diagram: c.diagram })),
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
        store.updateTask(task.id, { needsInput: reason })
        return reason ? 'The user will be notified.' : 'Cleared.'
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

      case 'set_review': {
        const stepId = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId)?.stepId : null
        if (role !== 'reviewer' || !stepId) throw new Error('set_review is for the reviewer of a step')
        const verdict = args.verdict as ReviewVerdict
        if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${REVIEW_VERDICTS.join(', ')}`)
        const findings = findingsArg(args.findings)
        if (verdict !== 'merge' && !findings.length) throw new Error(`A ${verdict} verdict needs findings: what and where`)
        return actions.setReview(stepId, verdict, findings)
      }

      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }
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
    role: c.role ?? undefined,
    option: c.option ?? undefined,
    step: keyOf(c.stepId),
    repo: c.repo ? repoName(project, c.repo) : undefined,
    of: c.taskId !== taskId ? (keyOf(c.taskId) ?? 'another task') : undefined,
  }
}

/** The short name of a project repository (see repoNames); the path of one removed since. */
const repoName = (project: Project, path: string) => repoNames(project)[project.repos.indexOf(path)] ?? path

/** " as option A", " in the plan of T-1.2 (api)", or " (unplaced)". */
function placedAs(store: Store, project: Project, p: CanvasPlacement): string {
  if (p.role === 'option') return ` as option ${p.option}`
  if (p.role !== 'plan') return ' (unplaced)'
  const key = store.data.tasks.find((t) => t.id === p.stepId)?.key
  return ` in the plan of ${key}${p.repo ? ` (${repoName(project, p.repo)})` : ''}`
}

/** Moves the project-chat canvases a task doc links into the task; says so in the tool's answer. */
function adopted(store: Store, taskId: string, md: string): string {
  const moved = store.adoptCanvases(taskId, linkedCanvasIds(md))
  return moved.length ? ` Moved into ${store.task(taskId).key}, as the doc links them: ${moved.map((c) => c.id).join(', ')}.` : ''
}

/** "+2 ~1 −0", or "no changes". */
const changes = (c: Canvas) => formatDiffCount(diagramSummary(c.diagram!)) || 'no changes'

/**
 * Records the module tree. Ids must be unique in the whole tree; uses of unknown ids or of the module itself are
 * dropped, repeats of one target merged. A plain string in `uses` counts as `{ to, calls: [] }`.
 */
function setArchitecture(store: Store, projectId: string, args: Record<string, unknown>) {
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
  walkArch(modules, (n) => {
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
  })
  store.updateProject(projectId, {
    architecture: { summary: String(args.summary ?? ''), modules, updatedAt: Date.now() },
  })
  return `Recorded ${ids.size} module(s), ${modules.length} on the top level.${dropped ? ` Dropped ${dropped} use(s) of unknown ids or of the module itself.` : ''}`
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
      return `${said} Plan what is left right here: update_doc, diagrams and create_subtask with work: "${t.key}"; its done steps stay. The user approves the plan when it is ready.`
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

    case 'update_notes':
      store.updateProject(project.id, { notes: String(args.notes ?? '') })
      return 'Notes updated.'

    case 'run_architect':
      actions.architect(project.id)
      return 'Architect started; the diagram updates when it finishes.'

    case 'get_architecture':
      return project.architecture ? JSON.stringify(project.architecture, null, 2) : 'No architecture recorded yet.'

    case 'set_architecture':
      return setArchitecture(store, project.id, args)

    case 'check_architecture': {
      const work = ctx.taskId ? runWork(store, ctx) : null
      // Worktrees are removed once merged; only the ones still there have code to check.
      const repos = work?.repos.filter((r) => existsSync(r.worktree)) ?? []
      if (work && repos.length === 1) return formatReport(analyze(repos[0].worktree))
      if (work && repos.length) return repos.map((r) => `## ${repoWorkName(work, r)}\n${formatReport(analyze(r.worktree))}`).join('\n\n')
      if (!project.repos[0]) throw new Error('Project has no repository')
      return formatReport(analyze(project.repos[0]))
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
      const placement = placementArg(store, ctx.taskId ? store.task(ctx.taskId) : null, project, args)
      // One flow per method: a second flowchart of the same method is revised by id instead.
      const of = diagram.type === 'flowchart' && diagram.of ? parseFlowRef(diagram.of) : null
      if (of && ctx.taskId) {
        const same = taskDiagrams(store, ctx.taskId).find((c) => {
          if (c.taskId !== ctx.taskId) return false
          const ref = c.id !== id && c.diagram!.type === 'flowchart' && c.diagram!.of ? parseFlowRef(c.diagram!.of) : null
          return ref?.module === of.module && ref.method === of.method
        })
        if (same) throw new Error(`Not saved: flowchart ${same.id} ("${same.title}") already shows ${of.module}#${of.method}; revise it with id ${same.id}`)
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
      })
      showInChat(store, ctx, canvas)
      return `Diagram ${canvas.id} (v${canvas.version})${canvas.role ? placedAs(store, project, canvas) : ''}: ${changes(canvas)}. Link it as [${canvas.title}](canvas:${canvas.id}), a node as canvas:${canvas.id}#<node-id>.`
    }
  }
  return undefined
}
