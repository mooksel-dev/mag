import { DEFAULT_TEMPLATES, type ArchApp, type LeafTaskType, type Project, type Task, type TaskType } from '@mag/core'
import { analyze, formatReport } from '@mag/arch'
import type { Store } from './store'

export interface ToolContext {
  taskId?: string
  projectId?: string
  /** Session whose chat shows canvases. */
  sessionId?: string
}

/** Things tools can kick off; wired to the orchestrator after it exists. */
export interface ToolActions {
  groom(taskId: string): void
  architect(projectId: string): void
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
    const brief = (id: string) => {
      const t = store.data.tasks.find((x) => x.id === id)
      return t ? { key: t.key, title: t.title, type: t.type, status: t.status } : { id }
    }

    switch (name) {
      case 'get_task':
        return JSON.stringify(
          {
            key: task.key,
            title: task.title,
            type: task.type,
            status: task.status,
            description: task.description,
            parent: task.parentId ? brief(task.parentId) : null,
            subtasks: store.data.tasks.filter((t) => t.parentId === task.id).map((t) => brief(t.id)),
            dependsOn: task.dependsOn?.map(brief) ?? 'not set',
            project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
            work: task.work,
            docTemplate: project.templates[task.type] ?? DEFAULT_TEMPLATES[task.type],
          },
          null,
          2,
        )

      case 'get_doc':
        return store.data.docs[task.id] ?? '(empty)'

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
        if (task.needsInput) throw new Error('needs_input is still set; clear it first')
        store.updateTask(task.id, { status: 'groomed' })
        return 'Task marked as groomed. The user will review it.'

      case 'create_subtask': {
        const sub = store.createTask({
          projectId: project.id,
          parentId: task.id,
          title: String(args.title),
          type: String(args.type) as LeafTaskType,
          description: String(args.description ?? ''),
        })
        if (task.type !== 'story') store.updateTask(task.id, { type: 'story' })
        return `Created ${sub.key}.`
      }

      case 'set_pr': {
        if (!task.work) throw new Error('This task has no work in progress')
        const url = String(args.url ?? '')
        if (!/^https:\/\/github\.com\/.+\/pull\/\d+/.test(url)) throw new Error('Expected a GitHub pull request URL')
        store.updateTask(task.id, { status: 'in_review', work: { ...task.work, prUrl: url, feedbackSeenAt: Date.now() } })
        return 'PR recorded. The user reviews and merges it; you will be resumed if they leave comments.'
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
  const keysToIds = (keys: unknown) => (keys == null ? null : (keys as string[]).map((k) => byKey(k).id))

  switch (name) {
    case 'list_tasks':
      return JSON.stringify(
        {
          project: { name: project.name, repos: project.repos, notes: project.notes, baseBranch: project.baseBranch },
          tasks: tasks.map((t) => ({
            key: t.key,
            title: t.title,
            type: t.type,
            status: t.status,
            parent: t.parentId ? keyOf(t.parentId) : undefined,
            dependsOn: t.dependsOn?.map(keyOf) ?? 'not set',
            needsInput: t.needsInput ?? undefined,
            pr: t.work?.prUrl ?? undefined,
          })),
        },
        null,
        2,
      )

    case 'read_task': {
      const t = byKey(args.key)
      return JSON.stringify({ ...t, parent: t.parentId && keyOf(t.parentId), dependsOn: t.dependsOn?.map(keyOf) ?? 'not set', doc: store.data.docs[t.id] ?? '(empty)' }, null, 2)
    }

    case 'create_task': {
      const t = store.createTask({
        projectId: project.id,
        title: String(args.title),
        type: String(args.type) as TaskType,
        description: String(args.description ?? ''),
        parentId: args.parentKey ? byKey(args.parentKey).id : null,
      })
      if (args.dependsOn !== undefined) store.updateTask(t.id, { dependsOn: keysToIds(args.dependsOn) })
      return `Created ${t.key} in the backlog.`
    }

    case 'update_task': {
      const t = byKey(args.key)
      const patch: Partial<Task> = {}
      if (typeof args.title === 'string') patch.title = args.title
      if (typeof args.description === 'string') patch.description = args.description
      if (args.dependsOn !== undefined) patch.dependsOn = keysToIds(args.dependsOn)
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
      const task = ctx.taskId ? store.task(ctx.taskId) : null
      const dir = task?.work?.worktree ?? project.repos[0]
      if (!dir) throw new Error('Project has no repository')
      return formatReport(analyze(dir))
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
