import { app, crashReporter, dialog, ipcMain, net, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { basename, extname, join, normalize } from 'node:path'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { SUBTASK_STATUSES, canArchive, canMoveInPlan, canMoveToTodo, isLegacy, nextPlanRank, subtaskStatusChanges, subtasksOf, todoTasks, type Attachment, type Project, type SubtaskStatus, type Task } from '@mag/core'
import { claudeCode } from '@mag/agents'
import type { AppState, NewTask, RendererCrash, WindowTarget } from '../preload/api'
import { Store } from './store'
import { createTools, type ToolActions } from './tools'
import { startApi } from './api'
import { Orchestrator } from './orchestrator'
import { createTrackerService } from './core/services/tracker'
import { Approvals } from './approvals'
import { startScheduler } from './scheduler'
import { repoInfo } from './git'
import { ICON, createWindows } from './windows'
import { startAppMenu } from './menu'
import { startAttention } from './attention'
import { initLog, log, logTail, pruneLogs } from './log'
import { Crashes } from './crash'

// Apps launched from Finder get a minimal PATH; take the login shell's so git, gh and claude resolve.
try {
  const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 })
  if (shellPath.trim()) process.env.PATH = shellPath.trim().split('\n').pop()
} catch {
  // keep the inherited PATH
}

// Logs and crash reports; the project chat reads them too.
const logsDir = join(app.getPath('userData'), 'logs')
initLog(logsDir, !app.isPackaged)
const crashes = new Crashes(join(logsDir, 'crashes'), app.getVersion(), logTail)
app.setPath('crashDumps', crashes.nativeDir)
crashReporter.start({ uploadToServer: false })
try {
  pruneLogs(logsDir)
} catch (e) {
  log.warn('app', 'pruning old logs failed', e)
}
log.info('app', 'started', { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron })

const saveCrash = (crash: Parameters<Crashes['write']>[0]) => {
  try {
    crashes.write(crash)
  } catch (e) {
    log.error('crash', 'writing the crash report failed', e)
  }
}
const crashed = (kind: 'uncaughtException' | 'unhandledRejection') => (e: unknown) => {
  const err = e instanceof Error ? e : new Error(String(e))
  log.error('crash', `${kind}: ${err.message}`, err)
  saveCrash({ kind, message: err.message, stack: err.stack })
}
process.on('uncaughtException', crashed('uncaughtException'))
process.on('unhandledRejection', crashed('unhandledRejection'))
app.on('render-process-gone', (_, contents, d) => {
  const message = `Renderer gone: ${d.reason} (exit code ${d.exitCode}) at ${contents.getURL()}`
  log.error('crash', message)
  saveCrash({ kind: 'render-process-gone', message })
})
app.on('child-process-gone', (_, d) => {
  if (d.reason === 'clean-exit') return
  const message = `${d.name ?? d.type} process gone: ${d.reason} (exit code ${d.exitCode})`
  log.error('crash', message)
  saveCrash({ kind: 'child-process-gone', message })
})

/** ipcMain.handle that logs a throwing handler's stack before the error goes back to the renderer. */
function handle<A extends unknown[]>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => unknown) {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return await fn(e, ...(args as A))
    } catch (err) {
      log.error('ipc', `${channel} failed`, err)
      throw err
    }
  })
}

// Serves attached files to the renderer: mag-file://att/<file name>
protocol.registerSchemesAsPrivileged([{ scheme: 'mag-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.html': 'text/html', '.csv': 'text/csv',
}

app.whenReady().then(async () => {
  app.dock?.setIcon(ICON)
  const userData = app.getPath('userData')
  const store = new Store(join(userData, 'db.json'))
  const windows = createWindows(store)
  // Pop-outs save their bounds as they close on quit, after the save timer could fire.
  app.on('will-quit', () => store.flush())
  const attachmentsDir = join(userData, 'attachments')
  mkdirSync(attachmentsDir, { recursive: true })
  const actions: ToolActions = { groom: () => {}, architect: () => {}, cancel: async () => {}, completeStep: async () => {} }
  const tools = createTools(store, actions)
  const approvals = new Approvals(store)
  const api = await startApi((ctx, name, args) => (name === 'approve_tool' ? approvals.request(ctx, args) : tools(ctx, name, args)))
  const orch = new Orchestrator(store, api, {
    mcpScript: join(__dirname, 'task-mcp.js'),
    runsDir: join(userData, 'runs'),
    worktreesDir: join(userData, 'worktrees'),
    attachmentsDir,
    logsDir,
  })
  app.on('will-quit', () => orch.shutdown())
  actions.groom = (id) => orch.groom(id)
  actions.architect = (id) => orch.architect(id)
  actions.cancel = (id, reason) => orch.cancel(id, reason)
  actions.completeStep = (id) => orch.completeStep(id)
  const tracker = createTrackerService(store, { startImport: (id) => orch.importTicket(id) })

  protocol.handle('mag-file', (req) => {
    const file = normalize(join(attachmentsDir, decodeURIComponent(new URL(req.url).pathname)))
    if (!file.startsWith(attachmentsDir)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
  const scheduler = startScheduler(store, orch)
  const claudeBin = await claudeCode.detect()

  const snapshot = (): AppState => {
    const { canvases: _, ui: __, ...data } = store.data
    return { ...data, canvases: store.canvasList(), claudeBin, appVersion: app.getVersion(), openProjects: windows.openProjects() }
  }
  store.onChange(() => windows.broadcast(snapshot()))
  windows.onChange(() => windows.broadcast(snapshot()))
  app.on('browser-window-focus', () => void scheduler.pollNow())

  handle('state:get', () => snapshot())
  handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('project:create', (_, name: string) => store.createProject(name))
  handle('project:update', (_, id: string, patch: Partial<Project>) => store.updateProject(id, patch))
  handle('task:create', (_, t: NewTask) => store.createTask(t))
  const projectTasks = (projectId: string) => store.data.tasks.filter((t) => t.projectId === projectId)
  /** A legacy task, or the parent of a legacy checklist subtask: the only ones whose subtask status the user sets. */
  const legacyParent = (t: Task) => isLegacy(t.parentId ? store.task(t.parentId) : t)
  handle('task:update', (_, id: string, patch: Partial<Task>) => {
    const task = store.task(id)
    if (patch.status !== undefined && patch.status !== task.status) {
      if (task.parentId && !legacyParent(task)) throw new Error(`${task.key} is a step: its status follows its lifecycle`)
      const todo = patch.status === 'todo' && !task.parentId ? canMoveToTodo(task, projectTasks(task.projectId)) : { ok: true }
      if (!todo.ok) throw new Error(`${task.key} cannot move to todo: ${todo.reason}`)
    }
    store.updateTask(id, patch)
  })
  handle('task:moveToTodo', (_, id: string) => {
    const task = store.task(id)
    if (task.status !== 'backlog' && task.status !== 'grooming') throw new Error(`${task.key} is ${task.status}; only backlog and grooming tasks move to todo`)
    if (store.data.sessions.some((s) => s.taskId === id && orch.isRunning(s.id))) throw new Error('An agent is still working on this task')
    const tasks = projectTasks(task.projectId)
    const todo = canMoveToTodo(task, tasks)
    if (!todo.ok) throw new Error(`${task.key} cannot move to todo: ${todo.reason}`)
    store.updateTask(id, { status: 'todo', needsInput: null, rank: nextPlanRank(tasks) })
  })
  // A ref that names no ticket, or one already imported, is an answer for the import field, not a failure to log.
  handle('task:import', async (_, projectId: string, ref: string) => {
    try {
      return { taskId: (await tracker.import(projectId, ref)).id }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })
  handle('task:retryImport', (_, id: string) => tracker.retryImport(id))
  // Same for a pasted link: the error is shown under the field.
  handle('task:linkTicket', (_, id: string, url: string) => {
    try {
      tracker.link(id, url)
      return { ok: true }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })
  handle('task:unlinkTicket', (_, id: string) => void tracker.unlink(id))
  handle('task:groom', (_, id: string) => orch.groom(id))
  handle('task:startStep', (_, id: string) => orch.startStep(id))
  handle('task:cancel', (_, id: string, reason: string | null) => orch.cancel(id, reason))
  handle('task:archive', (_, ids: string[]) => {
    const now = Date.now()
    for (const id of ids) {
      const task = store.task(id)
      if (!canArchive(task)) throw new Error(`${task.key} is ${task.status}; only done or canceled tasks can be archived`)
      store.updateTask(id, { archivedAt: now })
    }
  })
  handle('task:restore', (_, id: string) => store.updateTask(id, { archivedAt: null }))
  handle('task:setSubtaskStatus', (_, id: string, status: SubtaskStatus) => {
    const sub = store.task(id)
    if (!sub.parentId || !SUBTASK_STATUSES.includes(status)) throw new Error(`Cannot set ${sub.key} to ${status}`)
    if (!legacyParent(sub)) throw new Error(`${sub.key} is a step: its status follows its lifecycle`)
    for (const c of subtaskStatusChanges(sub, status, store.data.tasks)) store.updateTask(c.id, { status: c.status })
  })
  handle('task:move', (_, id: string, dir: 'up' | 'down') => {
    const task = store.task(id)
    const tasks = projectTasks(task.projectId)
    if (!canMoveInPlan(task, tasks, dir)) throw new Error(`${task.key} cannot move ${dir}`)
    const todo = todoTasks(tasks)
    const other = todo[todo.indexOf(task) + (dir === 'up' ? -1 : 1)]
    const [a, b] = [task.rank, other.rank]
    store.updateTask(other.id, { rank: a })
    store.updateTask(task.id, { rank: b })
  })
  handle('task:reorderSubtasks', (_, parentId: string, ids: string[]) => {
    // Steps that started (done, current) keep their places at the front; a legacy checklist moves freely.
    const locked = isLegacy(store.task(parentId)) ? [] : subtasksOf(parentId, store.data.tasks).filter((s) => s.status !== 'todo')
    if (locked.some((s, i) => ids[i] !== s.id)) throw new Error(`${locked.map((s) => s.key).join(', ')} started; they keep their places`)
    store.reorderSubtasks(parentId, ids)
  })
  handle('task:develop', (_, id: string) => orch.develop(id))
  handle('pr:checkNow', () => scheduler.pollNow())
  handle('shell:open', (_, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
    return shell.openPath(url)
  })
  handle('arch:run', (_, projectId: string) => orch.architect(projectId))
  handle('agents:list', () => orch.agents())
  handle('repo:info', (_, path: string) => repoInfo(path))
  handle('session:send', (_, sid: string, text: string, attachments?: Attachment[]) => orch.send(sid, text, attachments))
  handle('chat:new', (_, projectId: string) => orch.newChat(projectId))
  handle('canvas:get', (_, id: string) => {
    const c = store.data.canvases[id]
    return c ? { kind: c.kind, html: c.html, diagram: c.diagram } : null
  })
  handle('attach:save', (_, f: { name: string; bytes?: Uint8Array; path?: string }): Attachment => {
    const name = basename(f.name || (f.path ? basename(f.path) : 'file')).replace(/[^\w.-]+/g, '_') || 'file'
    const path = join(attachmentsDir, `${randomUUID().slice(0, 8)}-${name}`)
    if (f.bytes) writeFileSync(path, f.bytes)
    else if (f.path) copyFileSync(f.path, path)
    else throw new Error('Nothing to attach')
    return { name, path, mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' }
  })
  handle('session:stop', (_, sid: string) => orch.stop(sid))
  handle('session:stopBackground', (_, sid: string, taskId: string) => orch.stopBackground(sid, taskId))
  handle('approval:decide', (_, sid: string, approvalId: string, allow: boolean) => approvals.decide(sid, approvalId, allow))
  handle('window:open', (_, target: WindowTarget) => windows.openPopout(target))
  handle('window:openProject', (e, projectId: string) => windows.openProjectFrom(e.sender, projectId))
  handle('window:openTask', (_, taskId: string) => windows.focusTask(taskId))
  handle('log:crash', (_, c: RendererCrash) => {
    log.error('crash', `renderer error on ${c.screen ?? 'unknown screen'}: ${c.message}`)
    saveCrash({ kind: 'renderer', message: c.message, stack: c.stack, componentStack: c.componentStack, screen: c.screen })
  })
  handle('crash:last', () => crashes.last())
  handle('crash:dismiss', () => crashes.dismiss())
  const openLogs = () => shell.openPath(logsDir)
  handle('logs:open', () => openLogs())
  startAppMenu(store, windows, openLogs)
  startAttention(store, windows)

  windows.restore()
  // The dock icon brings Welcome back when no project is open, even while pop-outs are.
  app.on('activate', () => {
    if (!windows.hasMainWindow()) windows.welcome()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
