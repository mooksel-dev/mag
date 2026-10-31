import { DEFAULT_TEMPLATES, SUBTASK_STATUSES, activeSections, backlogTasks, canArchive, canCancel, currentStep, findRepoWork, isLegacy, nextPlanRank, prRollup, repoWorkName, subtaskProgress, subtaskStatusChanges, subtasksOf, taskPrs, todoTasks, type ArchApp, type Project, type SubtaskStatus, type Task, type TaskType, type TaskWork } from '@mag/core'
import { existsSync } from 'node:fs'
import { analyze, formatReport } from '@mag/arch'
import type { Store } from './store'
import { changedRepos } from './git.ts'
import { TOOL_DEFS, toolForRole } from './tool-defs.ts'

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
  /** The remaining steps of a task in progress were re-groomed: it goes on, resuming its current step's developer. */
  regroomed(taskId: string): Promise<void>
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

const TYPES: TaskType[] = ['dev', 'design', 'spike', 'research']

function taskType(v: unknown): TaskType {
  if (!TYPES.includes(v as TaskType)) throw new Error(`type must be one of ${TYPES.join(', ')}`)
  return v as TaskType
}

export type ToolHandler = (ctx: ToolContext, name: string, args: Record<string, unknown>) => Promise<string>

export function createTools(store: Store, actions: ToolActions): ToolHandler {
  return async (ctx, name, args) => {
    const role = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId)?.role : undefined
    const def = TOOL_DEFS.find((d) => d.name === name)
    if (def && role && !toolForRole(def, role)) throw new Error(`${name} is not available to the ${role} agent`)
    const projectId = ctx.taskId ? store.task(ctx.taskId).projectId : (ctx.projectId ?? '')
    const shared = sharedTool(store, actions, store.project(projectId), ctx, name, args)
    if (shared !== undefined) return shared
    if (!ctx.taskId) throw new Error(`${name} needs a task`)
    const task = store.task(ctx.taskId)
    const project = store.project(task.projectId)
    const doc = (id: string) => store.data.docs[id] ?? '(empty)'
    const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
    const steps = () => subtasksOf(task.id, store.data.tasks)
    const subtask = (key: unknown) => {
      const sub = store.data.tasks.find((t) => t.parentId === task.id && t.key.toLowerCase() === String(key).toLowerCase())
      if (!sub) throw new Error(`${key} is not a subtask of ${task.key}`)
      return sub
    }
    /** Remaining mode: a task in progress is re-groomed; its done steps are locked, the current one is only renamed. */
    const remaining = task.status === 'in_progress' && !isLegacy(task)
    /** Grooming, or re-grooming the remaining steps; throws otherwise. */
    const canEditSteps = () => {
      if (task.parentId) throw new Error('Subtasks cannot have subtasks')
      if (task.status === 'backlog' || task.status === 'grooming') return
      if (!remaining) throw new Error(`${task.key} is ${task.status}; its steps change only while grooming`)
      if (session && session.role !== 'groomer') throw new Error('Only the groomer changes the steps; if the plan no longer fits, set_needs_input')
    }
    /** A step grooming may still change: in remaining mode not a done one, and the current one only by edit. */
    const ownSubtask = (key: unknown, op: 'edit' | 'delete' = 'edit') => {
      canEditSteps()
      const sub = subtask(key)
      if (!remaining) return sub
      if (sub.status === 'done') throw new Error(`${sub.key} is done; done steps are locked`)
      if (op === 'delete' && sub.status === 'in_progress') throw new Error(`${sub.key} is the current step: it can be renamed, not deleted or moved`)
      return sub
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
              prs: t.work?.repos.flatMap((r) => (r.prUrl ? [`${r.prUrl} (${r.prState ?? 'unknown'})`] : [])),
              current: t.id === step?.id || undefined,
            })),
            project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
            work: work && {
              dir: work.dir,
              repos: work.repos.map((r) => ({ name: repoWorkName(work, r), repo: r.repo, worktree: r.worktree, branch: r.branch, prUrl: r.prUrl, prState: r.prState })),
            },
            docTemplate: project.templates[task.type] ?? DEFAULT_TEMPLATES[task.type],
            tracker: task.tracker ?? undefined,
          },
          null,
          2,
        )
      }

      case 'get_doc':
        return doc(task.id)

      case 'update_doc':
        store.data.docs[task.id] = String(args.markdown ?? '')
        store.changed()
        return 'Document updated.'

      case 'set_needs_input': {
        const reason = args.reason == null || args.reason === '' ? null : String(args.reason)
        store.updateTask(task.id, { needsInput: reason })
        return reason ? 'The user will be notified.' : 'Cleared.'
      }

      case 'mark_groomed': {
        if (task.parentId) throw new Error('Subtasks are not groomed separately; groom the parent task')
        if (task.needsInput) throw new Error('needs_input is still set; clear it first')
        if (task.status !== 'grooming' && !remaining) throw new Error(`${task.key} is ${task.status}, not grooming`)
        if (!steps().length) throw new Error('Add at least one step with create_subtask')
        if (task.status === 'grooming') {
          store.updateTask(task.id, { status: 'todo', rank: nextPlanRank(store.data.tasks.filter((t) => t.projectId === project.id)) })
          return 'Task groomed: it is in todo, ready for the user to start.'
        }
        canEditSteps()
        await actions.regroomed(task.id)
        const step = currentStep(task.id, store.data.tasks)
        return step ? `Remaining steps groomed: the task continues with ${step.key}.` : 'Remaining steps groomed.'
      }

      case 'create_subtask': {
        canEditSteps()
        const title = String(args.title ?? '').trim()
        if (!title) throw new Error('title is required')
        const sub = store.createTask({ projectId: project.id, parentId: task.id, title, type: task.type, description: note(args.note), status: 'todo', startManually: args.start_manually === true })
        return `Created ${sub.key}.`
      }

      case 'update_subtask': {
        const sub = ownSubtask(args.key)
        const patch: Partial<Task> = {}
        if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim()
        if (typeof args.note === 'string') patch.description = note(args.note)
        if (typeof args.start_manually === 'boolean') patch.startManually = args.start_manually
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
        const sub = ownSubtask(args.key, 'delete')
        store.deleteTask(sub.id)
        return `Deleted ${sub.key}.`
      }

      case 'reorder_subtasks': {
        canEditSteps()
        const ordered = (Array.isArray(args.keys) ? args.keys : []).map(subtask)
        // Steps that started (done, current) keep their places at the front.
        const locked = remaining ? steps().filter((s) => s.status !== 'todo') : []
        if (locked.some((s, i) => ordered[i]?.id !== s.id)) throw new Error(`${locked.map((s) => s.key).join(', ')} started; they keep their places at the front`)
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
          repos: work.repos.map((r) => (r === target ? { ...r, prUrl: url, prState: 'open' as const, checkError: null } : r)),
          // Comments made before the first PR are not feedback; later ones on any PR are.
          feedbackSeenAt: first ? Date.now() : work.feedbackSeenAt,
        }
        const changed = await changedRepos(next, project.baseBranch)
        const review = prRollup(next, changed) === 'review'
        store.updateTask(step?.id ?? task.id, { work: next })
        const missing = next.repos.filter((r) => changed.includes(r.repo) && (!r.prUrl || r.prState === 'closed')).map((r) => repoWorkName(next, r))
        return review
          ? `PR recorded. Every changed repo has a PR: the user merges${step ? `, and ${step.key} is done once every PR is merged` : ''}; you will be resumed if they leave comments.`
          : `PR recorded for ${repoWorkName(next, target)}. Still without a PR: ${missing.join(', ') || 'none'}; open one per changed repo.`
      }

      case 'get_import': {
        if (!task.tracker) throw new Error(`${task.key} is not linked to a ticket`)
        // The scope is the key's prefix (see parseTrackerRef).
        const { key, url, kind } = task.tracker
        return JSON.stringify({ key, url, kind, scope: key.slice(0, key.lastIndexOf('-')) }, null, 2)
      }

      case 'set_brief': {
        const link = task.tracker
        if (!link) throw new Error(`${task.key} is not linked to a ticket`)
        const title = String(args.title ?? '').replace(/\s+/g, ' ').trim()
        const brief = String(args.brief ?? '').trim()
        if (!title || !brief) throw new Error('title and brief are required')
        const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : null
        if (url && !/^https:\/\/\S+$/.test(url)) throw new Error('url must be an https link')
        store.updateTask(task.id, { title, description: brief, tracker: { ...link, url: link.url ?? url, importedAt: Date.now() } })
        return `Brief of ${task.key} written. Stop here.`
      }

      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }
}

function setArchitecture(store: Store, projectId: string, args: Record<string, unknown>) {
  const apps = Array.isArray(args.apps) ? (args.apps as ArchApp[]) : null
  if (!apps?.length) throw new Error('apps is required')
  for (const app of apps) {
    const ids = new Set(app.nodes.map((n) => n.id))
    for (const n of app.nodes) n.uses = (n.uses ?? []).filter((u) => ids.has(u) && u !== n.id)
  }
  store.updateProject(projectId, {
    architecture: { summary: String(args.summary ?? ''), apps, updatedAt: Date.now() },
  })
  const nodes = apps.reduce((n, a) => n + a.nodes.length, 0)
  return `Recorded ${apps.length} app(s), ${nodes} node(s).`
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
    const t = tasks.find((x) => x.key.toLowerCase() === String(key).toLowerCase())
    if (!t) throw new Error(`No task ${key}`)
    return t
  }
  const keyOf = (id: string) => tasks.find((t) => t.id === id)?.key ?? id
  const withSubtasks = (t: Task): Task[] => [t, ...subtasksOf(t.id, tasks).flatMap(withSubtasks)]

  switch (name) {
    case 'list_tasks': {
      const active = activeSections(tasks)
      return JSON.stringify(
        {
          project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
          tasks: [...active.inProgress, ...active.todo, ...active.grooming, ...backlogTasks(tasks), ...active.finished].flatMap(withSubtasks).map((t) => ({
            key: t.key,
            title: t.title,
            type: t.type,
            status: t.status,
            parent: t.parentId ? keyOf(t.parentId) : undefined,
            needsInput: t.needsInput ?? undefined,
            prs: t.work?.repos.flatMap((r) => (r.prUrl ? [`${r.prUrl} (${r.prState ?? 'unknown'})`] : [])),
            cancelReason: t.cancelReason ?? undefined,
          })),
        },
        null,
        2,
      )
    }

    case 'read_task': {
      const t = byKey(args.key)
      return JSON.stringify({ ...t, parent: t.parentId && keyOf(t.parentId), doc: store.data.docs[t.id] ?? '(empty)' }, null, 2)
    }

    case 'create_task': {
      const md = typeof args.doc === 'string' ? args.doc : ''
      const plan = args.plan === true
      const steps = stepsArg(args.steps)
      if (plan && !md.trim()) throw new Error('plan: true needs the full doc')
      if (plan && !steps.length) throw new Error('plan: true needs steps: at least one { title, note?, start_manually? }')
      const t = store.createTask({
        projectId: project.id,
        title: String(args.title),
        type: taskType(args.type),
        description: String(args.description ?? ''),
        status: plan ? 'todo' : undefined,
      })
      // `tasks` was read before the new task existed, so it is the plan ahead of it.
      if (md.trim()) store.data.docs[t.id] = md
      if (plan) store.updateTask(t.id, { rank: nextPlanRank(tasks) })
      else if (md.trim()) store.changed()
      for (const s of steps) store.createTask({ projectId: project.id, parentId: t.id, title: s.title, type: t.type, description: s.note, status: 'todo', startManually: s.startManually })
      return plan ? `Created ${t.key} in todo (priority ${todoTasks(tasks).length + 1}); the user starts it.` : `Created ${t.key} in the backlog.`
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
      store.data.docs[t.id] = String(args.markdown ?? '')
      store.changed()
      return `Document of ${t.key} updated.`
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

    case 'archive_task': {
      const t = byKey(args.key)
      if (!canArchive(t)) throw new Error(`${t.key} is ${t.status}${t.archivedAt ? ', already archived' : ''}; only done or canceled tasks can be archived`)
      store.updateTask(t.id, { archivedAt: Date.now() })
      return `Archived ${t.key}.`
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
        html,
      })
      const session = ctx.sessionId ? store.data.sessions.find((s) => s.id === ctx.sessionId) : undefined
      session?.items.push({ kind: 'canvas', canvas: { id: canvas.id, title: canvas.title, version: canvas.version }, at: Date.now() })
      store.changed()
      return `Shown to the user as canvas ${canvas.id} (v${canvas.version}).`
    }
  }
  return undefined
}
