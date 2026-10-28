import { BACKLOG_STATUSES, DEFAULT_TEMPLATES, PLAN_STATUSES, findRepoWork, nextPlanRank, planQueue, prRollup, repoWorkName, subtaskProgress, subtasksOf, type ArchApp, type Project, type Task, type TaskType } from '@mag/core'
import { existsSync } from 'node:fs'
import { analyze, formatReport } from '@mag/arch'
import type { Store } from './store'
import { changedRepos } from './git'

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
}

const TYPES: TaskType[] = ['dev', 'design', 'spike', 'research']

function taskType(v: unknown): TaskType {
  if (!TYPES.includes(v as TaskType)) throw new Error(`type must be one of ${TYPES.join(', ')}`)
  return v as TaskType
}

export type ToolHandler = (ctx: ToolContext, name: string, args: Record<string, unknown>) => Promise<string>

export function createTools(store: Store, actions: ToolActions): ToolHandler {
  return async (ctx, name, args) => {
    const projectId = ctx.taskId ? store.task(ctx.taskId).projectId : (ctx.projectId ?? '')
    const shared = sharedTool(store, actions, store.project(projectId), ctx, name, args)
    if (shared !== undefined) return shared
    if (!ctx.taskId) throw new Error(`${name} needs a task`)
    const task = store.task(ctx.taskId)
    const project = store.project(task.projectId)
    const doc = (id: string) => store.data.docs[id] ?? '(empty)'
    const subtask = (key: unknown) => {
      const sub = store.data.tasks.find((t) => t.parentId === task.id && t.key.toLowerCase() === String(key).toLowerCase())
      if (!sub) throw new Error(`${key} is not a subtask of ${task.key}`)
      return sub
    }
    /** A subtask of the current task that grooming may still change. */
    const ownSubtask = (key: unknown) => {
      if (PLAN_STATUSES.includes(task.status)) throw new Error(`${task.key} is already in the plan; its subtasks can no longer change`)
      return subtask(key)
    }
    const note = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

    switch (name) {
      case 'get_task':
        return JSON.stringify(
          {
            key: task.key,
            title: task.title,
            type: task.type,
            status: task.status,
            description: task.description,
            subtasks: subtasksOf(task.id, store.data.tasks).map((t) => ({ key: t.key, title: t.title, note: t.description || undefined, status: t.status })),
            project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
            work: task.work && {
              dir: task.work.dir,
              repos: task.work.repos.map((r) => ({ name: repoWorkName(task.work!, r), repo: r.repo, worktree: r.worktree, branch: r.branch, prUrl: r.prUrl, prState: r.prState })),
            },
            docTemplate: project.templates[task.type] ?? DEFAULT_TEMPLATES[task.type],
          },
          null,
          2,
        )

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

      case 'mark_groomed':
        if (task.parentId) throw new Error('Subtasks are not groomed separately; groom the parent task')
        if (task.needsInput) throw new Error('needs_input is still set; clear it first')
        store.updateTask(task.id, { status: 'groomed' })
        return 'Task marked as groomed. The user will review it.'

      case 'create_subtask': {
        if (task.parentId) throw new Error('Subtasks cannot have subtasks')
        if (task.status !== 'grooming') throw new Error(`${task.key} is ${task.status}; subtasks are created while grooming`)
        const title = String(args.title ?? '').trim()
        if (!title) throw new Error('title is required')
        const sub = store.createTask({ projectId: project.id, parentId: task.id, title, type: task.type, description: note(args.note), status: 'todo' })
        return `Created ${sub.key}.`
      }

      case 'update_subtask': {
        const sub = ownSubtask(args.key)
        const patch: Partial<Task> = {}
        if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim()
        if (typeof args.note === 'string') patch.description = note(args.note)
        store.updateTask(sub.id, patch)
        return `Updated ${sub.key}.`
      }

      case 'check_subtask': {
        const sub = subtask(args.key)
        store.updateTask(sub.id, { status: args.done === false ? 'todo' : 'done' })
        const { done, total } = subtaskProgress(task.id, store.data.tasks)
        return `${sub.key} ${args.done === false ? 'unticked' : 'ticked'}; ${done}/${total} done.`
      }

      case 'delete_subtask': {
        const sub = ownSubtask(args.key)
        store.deleteTask(sub.id)
        return `Deleted ${sub.key}.`
      }

      case 'reorder_subtasks': {
        const ordered = (Array.isArray(args.keys) ? args.keys : []).map(ownSubtask)
        store.reorderSubtasks(task.id, ordered.map((t) => t.id))
        return `Order: ${ordered.map((t) => t.key).join(', ')}.`
      }

      case 'set_pr': {
        const work = task.work
        if (!work) throw new Error('This task has no work in progress')
        const url = String(args.url ?? '')
        if (!/^https:\/\/github\.com\/.+\/pull\/\d+/.test(url)) throw new Error('Expected a GitHub pull request URL')
        const names = work.repos.map((r) => repoWorkName(work, r)).join(', ')
        const ref = typeof args.repo === 'string' && args.repo.trim() ? args.repo : work.repos.length === 1 ? work.repos[0].repo : null
        if (!ref) throw new Error(`Pass repo: one of ${names}`)
        const target = findRepoWork(work, ref)
        if (!target) throw new Error(`${ref} is not a repo of this task; one of ${names}`)
        const first = !work.repos.some((r) => r.prUrl)
        const next = {
          ...work,
          repos: work.repos.map((r) => (r === target ? { ...r, prUrl: url, prState: 'open' as const, checkError: null } : r)),
          // Comments made before the first PR are not feedback; later ones on any PR are.
          feedbackSeenAt: first ? Date.now() : work.feedbackSeenAt,
        }
        const changed = await changedRepos(next, project.baseBranch)
        const review = prRollup(next, changed) === 'in_review'
        store.updateTask(task.id, { work: next, ...(review && { status: 'in_review' }) })
        const missing = next.repos.filter((r) => changed.includes(r.repo) && (!r.prUrl || r.prState === 'closed')).map((r) => repoWorkName(next, r))
        return review
          ? 'PR recorded. The task is in review: the user merges; you will be resumed if they leave comments.'
          : `PR recorded for ${repoWorkName(next, target)}. Still without a PR: ${missing.join(', ') || 'none'}; open one per changed repo.`
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
): string | undefined {
  const tasks = store.data.tasks.filter((t) => t.projectId === project.id)
  const byKey = (key: unknown) => {
    const t = tasks.find((x) => x.key.toLowerCase() === String(key).toLowerCase())
    if (!t) throw new Error(`No task ${key}`)
    return t
  }
  const keyOf = (id: string) => tasks.find((t) => t.id === id)?.key ?? id
  const withSubtasks = (t: Task): Task[] => [t, ...subtasksOf(t.id, tasks).flatMap(withSubtasks)]

  switch (name) {
    case 'list_tasks':
      return JSON.stringify(
        {
          project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
          tasks: [
            ...planQueue(tasks),
            ...tasks.filter((t) => !t.parentId && BACKLOG_STATUSES.includes(t.status)).sort((a, b) => a.createdAt - b.createdAt),
          ].flatMap(withSubtasks).map((t) => ({
            key: t.key,
            title: t.title,
            type: t.type,
            status: t.status,
            parent: t.parentId ? keyOf(t.parentId) : undefined,
            needsInput: t.needsInput ?? undefined,
            prs: t.work?.repos.flatMap((r) => (r.prUrl ? [r.prUrl] : [])),
          })),
        },
        null,
        2,
      )

    case 'read_task': {
      const t = byKey(args.key)
      return JSON.stringify({ ...t, parent: t.parentId && keyOf(t.parentId), doc: store.data.docs[t.id] ?? '(empty)' }, null, 2)
    }

    case 'create_task': {
      const md = typeof args.doc === 'string' ? args.doc : ''
      const plan = args.plan === true
      if (plan && !md.trim()) throw new Error('plan: true needs the full doc')
      const t = store.createTask({
        projectId: project.id,
        title: String(args.title),
        type: taskType(args.type),
        description: String(args.description ?? ''),
        status: plan ? 'planned' : undefined,
      })
      // `tasks` was read before the new task existed, so it is the plan ahead of it.
      if (md.trim()) store.data.docs[t.id] = md
      if (plan) store.updateTask(t.id, { rank: nextPlanRank(tasks) })
      else if (md.trim()) store.changed()
      return plan ? `Created ${t.key} in the plan (position ${planQueue(tasks).length + 1}).` : `Created ${t.key} in the backlog.`
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
      if (!['backlog', 'groomed'].includes(t.status)) throw new Error(`${t.key} is ${t.status}; only backlog or groomed tasks can be groomed`)
      actions.groom(t.id)
      return `Groomer started on ${t.key}.`
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
      const work = ctx.taskId ? store.task(ctx.taskId).work : null
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
