import { app, crashReporter, dialog, ipcMain, net, protocol, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { basename, extname, join, normalize } from 'node:path'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { SUBTASK_STATUSES, bundleFileName, canApprove, isLegacy, isReview, subtaskStatusChanges, subtasksOf, ticketRef, withTicket, type Attachment, type ChatRef, type ChildRole, type LocalChoice, type DirectionChoice, type PrVerdict, type Project, type ReviewFormat, type ReviewPage, type SubtaskStatus, type Task } from '@mag/core'
import { claudeCode } from '@mag/agents'
import type { HunkRef } from '@mag/diff'
import type { AppState, NewTask, RendererCrash, WindowTarget } from '../preload/api'
import { Store } from './store'
import { createTools, type ToolActions } from './tools'
import { startApi } from './api'
import { Orchestrator } from './orchestrator'
import { Approvals } from './approvals'
import { startScheduler } from './scheduler'
import { prChecks, prDetails, repoInfo } from './git'
import { factView, reviewDiff, reviewFactView, reviewHunk, stepHunk } from './fact'
import { exportReview, importReview } from './core/services/review-export/index.ts'
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
  const actions: ToolActions = { groom: () => {}, architect: () => {}, cancel: async () => {}, completeStep: async () => {}, addRepo: async () => { throw new Error('Not ready') }, setReview: () => { throw new Error('Not ready') }, reopen: () => { throw new Error('Not ready') }, askOwner: () => false, answerDeveloper: async () => { throw new Error('Not ready') }, startChild: () => { throw new Error('Not ready') }, sessionInTree: () => { throw new Error('Not ready') }, stop: async () => {}, reviewPr: async () => { throw new Error('Not ready') }, reviewFact: async () => { throw new Error('Not ready') }, exportReview: async () => { throw new Error('Not ready') }, setPrReview: () => { throw new Error('Not ready') }, decideDirection: () => { throw new Error('Not ready') }, approve: () => { throw new Error('Not ready') }, develop: async () => { throw new Error('Not ready') }, approveAndStart: async () => { throw new Error('Not ready') }, startStep: async () => { throw new Error('Not ready') }, restartReview: async () => { throw new Error('Not ready') }, agentOf: () => null, messageStepAgent: async () => { throw new Error('Not ready') }, send: async () => { throw new Error('Not ready') }, stopAgents: async () => [], closeChat: async () => { throw new Error('Not ready') }, closeWork: () => { throw new Error('Not ready') }, deleteChat: async () => { throw new Error('Not ready') }, deleteWork: async () => { throw new Error('Not ready') }, restore: () => { throw new Error('Not ready') } }
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
  // Naming first, then the archive's summaries: one cheap run at a time.
  void orch
    .nameUntitled()
    .catch((e) => log.warn('agent', 'naming untitled topics failed', e))
    .then(() => orch.summarizeArchived())
    .catch((e) => log.warn('agent', 'summarizing the archive failed', e))
  actions.groom = (id) => orch.groom(id)
  actions.architect = (id) => orch.architect(id)
  actions.cancel = (id, reason) => orch.cancel(id, reason)
  actions.closeChat = (id) => orch.closeChat(id)
  actions.closeWork = (id) => orch.closeWork(id)
  actions.deleteChat = (id) => orch.deleteChat(id)
  actions.deleteWork = (id) => orch.deleteWork(id)
  actions.restore = (kind, id) => orch.restore(kind, id)
  actions.completeStep = (id) => orch.completeStep(id)
  actions.addRepo = (id, ref, worktree) => orch.addRepo(id, ref, worktree)
  actions.setReview = (id, verdict, findings, report) => orch.setReview(id, verdict, findings, report)
  actions.failedChecks = async (url) => (await prChecks(url)).filter((c) => c.bucket === 'fail').map((c) => (c.link ? `${c.name} (${c.link})` : c.name))
  actions.reopen = (id, what, by) => orch.reopen(id, what, by)
  actions.askOwner = (id, question) => orch.askOwner(id, question)
  actions.answerDeveloper = (id, text) => orch.answerDeveloper(id, text)
  actions.startChild = (parentId, brief, role, fork) => orch.startChild(parentId, brief, role, fork)
  actions.sessionInTree = (callerId, targetId) => orch.sessionInTree(callerId, targetId)
  actions.stop = (id) => orch.stop(id)
  actions.reviewPr = (projectId, url, by, format) => orch.reviewPr(projectId, url, by, format)
  actions.reviewFact = (id) => orch.reviewFactOf(id)
  actions.setPrReview = (id, sessionId, review) => orch.setPrReview(id, sessionId, review)
  actions.decideDirection = (id, decision) => orch.decideDirection(id, decision)
  actions.approve = (id) => orch.approve(id)
  actions.develop = (id, localRepos) => orch.develop(id, undefined, localRepos)
  actions.approveAndStart = (id, localRepos) => orch.approveAndStart(id, localRepos)
  actions.startStep = (id) => orch.startStep(id)
  actions.restartReview = (id) => orch.reviewTask(id)
  actions.agentOf = (id, role) => orch.agentOf(id, role)
  actions.messageStepAgent = (id, text) => orch.messageStepAgent(id, text)
  actions.send = (sessionId, text, job) => orch.send(sessionId, text, [], job)
  actions.stopAgents = (id, except) => orch.stopAgents(id, except)

  // A review's archive (review-v2-part-2-v1-2.3): a window renders the review window static, main adds the PR and zips.
  const importsDir = join(userData, 'imports')
  const renders = new Map<number, { done: (page: ReviewPage) => void; fail: (e: Error) => void }>()
  let renderNo = 0
  handle('review:rendered', (_, n: number, page: ReviewPage | { error: string }) => {
    const r = renders.get(n)
    renders.delete(n)
    if ('error' in page) r?.fail(new Error(page.error))
    else r?.done(page)
  })
  const renderReview = (taskId: string, via?: WebContents) =>
    new Promise<ReviewPage>((done, fail) => {
      const task = store.task(taskId)
      const wc = via ?? windows.rendererFor(task.projectId, taskId)
      if (!wc) return fail(new Error(`Open the project window of ${task.key}: mag renders the review's page there`))
      const n = ++renderNo
      const timer = setTimeout(() => (renders.delete(n), fail(new Error('The window did not render the review in time'))), 120_000)
      renders.set(n, { done: (p) => (clearTimeout(timer), done(p)), fail: (e) => (clearTimeout(timer), fail(e)) })
      wc.send('review:render', n, taskId)
    })
  const doExport = (taskId: string, dest: string, via?: WebContents) =>
    exportReview(
      {
        review: (id) => {
          const task = store.task(id)
          return { task, doc: store.data.docs[id] ?? '', canvases: Object.values(store.data.canvases), from: store.project(task.projectId).name }
        },
        prDiff: (task) => reviewDiff(store.project(task.projectId), task),
        prDetails: async (task) => task.imported?.pr ?? prDetails(task.prReview!.pr.url),
        render: (id) => renderReview(id, via),
        isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
        write: (p, bytes) => writeFileSync(p, bytes),
      },
      taskId,
      dest,
    ).then((file) => (log.info('app', `${store.task(taskId).key}: review exported to ${file}`), file))
  actions.exportReview = (id, path) => doExport(id, path ?? app.getPath('downloads'))

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
      const ready = patch.status === 'ready' && !task.parentId ? canApprove(task, projectTasks(task.projectId)) : { ok: true }
      if (!ready.ok) throw new Error(`${task.key} cannot be approved: ${ready.reason}`)
    }
    store.updateTask(id, patch)
  })
  handle('task:approve', (_, id: string) => orch.approve(id))
  handle('task:approveAndStart', (_, id: string, localRepos?: string[]) => orch.approveAndStart(id, localRepos))
  // A link that is not one is an answer for the field, not a failure to log.
  const answer = (f: () => unknown) => {
    try {
      f()
      return { ok: true as const }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }
  // A ticket link opens a topic; its agent reads the ticket and asks what to do (roles-start-only-when-asked.1).
  handle('task:fromTicket', async (_, projectId: string, url: string) => {
    try {
      return { topicId: await orch.topicFromTicket(projectId, url) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })
  handle('task:addTicket', (_, id: string, url: string) =>
    answer(() => {
      const task = store.task(id)
      if (task.parentId) throw new Error(`${task.key} is a step; add the ticket to its work`)
      store.updateTask(id, { tickets: withTicket(task.tickets, ticketRef(url)) })
    }),
  )
  handle('task:removeTicket', (_, id: string, url: string) => store.updateTask(id, { tickets: (store.task(id).tickets ?? []).filter((t) => t.url !== url) }))
  handle('task:reopen', (_, id: string, what: string) => void orch.reopen(id, what))
  handle('idea:add', (_, projectId: string, text: string) => store.parkTopic(projectId, text).id)
  handle('task:groom', (_, id: string) => orch.groom(id))
  handle('task:startStep', (_, id: string) => orch.startStep(id))
  handle('task:review', (_, id: string) => orch.reviewTask(id))
  handle('task:cancel', (_, id: string, reason: string | null) => orch.cancel(id, reason))
  handle('task:setSubtaskStatus', (_, id: string, status: SubtaskStatus) => {
    const sub = store.task(id)
    if (!sub.parentId || !SUBTASK_STATUSES.includes(status)) throw new Error(`Cannot set ${sub.key} to ${status}`)
    if (!legacyParent(sub)) throw new Error(`${sub.key} is a step: its status follows its lifecycle`)
    for (const c of subtaskStatusChanges(sub, status, store.data.tasks)) store.updateTask(c.id, { status: c.status })
  })
  handle('task:reorderSubtasks', (_, parentId: string, ids: string[]) => {
    // Steps that started (done, current) keep their places at the front; a legacy checklist moves freely.
    const locked = isLegacy(store.task(parentId)) ? [] : subtasksOf(parentId, store.data.tasks).filter((s) => s.status !== 'todo')
    if (locked.some((s, i) => ids[i] !== s.id)) throw new Error(`${locked.map((s) => s.key).join(', ')} started; they keep their places`)
    store.reorderSubtasks(parentId, ids)
  })
  handle('task:develop', (_, id: string, localRepos?: string[]) => orch.develop(id, undefined, localRepos))
  handle('task:resolveLocal', (_, stepId: string, repo: string, choice: LocalChoice) => orch.resolveLocal(stepId, repo, choice))
  handle('pr:checkNow', () => scheduler.pollNow())
  handle('shell:open', (_, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
    return shell.openPath(url)
  })
  handle('arch:run', (_, projectId: string) => orch.architect(projectId))
  handle('agents:list', () => orch.agents())
  handle('repo:info', (_, path: string) => repoInfo(path))
  handle('session:send', (_, sid: string, text: string, attachments?: Attachment[], refs?: ChatRef[]) => orch.send(sid, text, attachments, undefined, refs))
  handle('chat:new', (_, projectId: string) => orch.newChat(projectId))
  handle('session:start-child', (_, parentId: string, brief: string, role: ChildRole | null, fork?: boolean) => orch.startChild(parentId, brief, role, !!fork, 'user'))
  handle('chat:rename', (_, sessionId: string, title: string) => orch.renameChat(sessionId, title))
  handle('chat:delete', (_, sessionId: string) => orch.deleteChat(sessionId))
  handle('chat:close', (_, sessionId: string) => orch.closeChat(sessionId))
  handle('task:delete', (_, id: string) => orch.deleteWork(id))
  handle('task:close', (_, id: string) => orch.closeWork(id))
  handle('sidebar:restore', (_, kind: 'work' | 'topic', id: string) => orch.restore(kind, id))
  handle('canvas:get', (_, id: string) => {
    const c = store.data.canvases[id]
    return c ? { kind: c.kind, html: c.html, diagram: c.diagram } : null
  })
  // A review of a teammate's PR shows its fact the way a step does.
  handle('step:fact', (_, stepId: string) => {
    const step = store.task(stepId)
    const canvases = Object.values(store.data.canvases)
    // A step's fact recorded by an older compare (a merged one's too) is recorded again as it is read.
    return isReview(step)
      ? reviewFactView(store.project(step.projectId), step, canvases)
      : factView(store.project(step.projectId), step, canvases, (fact) => store.updateTask(step.id, { fact }))
  })
  handle('step:hunk', (_, stepId: string, repo: string, base: string, head: string, hunk: HunkRef) => {
    const step = store.task(stepId)
    return isReview(step) ? reviewHunk(step, repo, base, head, hunk) : stepHunk(step, repo, base, head, hunk)
  })
  // Reviews of teammates' PRs (reviews-ahent-reviuit-pr-timeitiv.2).
  handle('review:start', async (_, projectId: string, url: string, format?: ReviewFormat) => {
    try {
      const { taskId, sessionId } = await orch.reviewPr(projectId, url, undefined, format)
      return { taskId, sessionId }
    } catch (e) {
      return { error: (e as Error).message.split('\n')[0] }
    }
  })
  handle('review:again', async (_, id: string) => {
    const { sessionId } = await orch.rereview(id)
    return sessionId
  })
  handle('review:run', async (_, id: string, format: ReviewFormat) => void (await orch.runReviewFormat(id, format)))
  handle('review:show', (_, id: string, format: ReviewFormat) => orch.showReviewResult(id, format))
  handle('review:close', (_, id: string) => orch.closeReview(id))
  handle('review:decide', (_, id: string, decision: { choice: DirectionChoice; option?: string; principle?: string }) => void orch.decideDirection(id, decision))
  handle('review:discuss', async (_, id: string) => (await orch.discussDirection(id)).sessionId)
  handle('review:delete', (_, id: string) => orch.deleteReview(id))
  // Publishing is the user's button only (reviews-ahent-reviuit-pr-timeitiv.3, Decision 7): mag posts, not an agent.
  handle('review:publish', async (_, id: string, verdict: PrVerdict, picks: number[]) => {
    try {
      return { url: await orch.publishReview(id, verdict, picks) }
    } catch (e) {
      return { error: (e as Error).message.split('\n')[0] }
    }
  })
  handle('review:connect', async (_, id: string) => {
    const r = await dialog.showOpenDialog({ title: `A checkout of ${store.task(id).prReview?.pr.repo ?? 'the repository'}`, properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      return { sessionId: (await orch.connectReviewRepo(id, r.filePaths[0])).sessionId }
    } catch (e) {
      return { error: (e as Error).message.split('\n')[0] }
    }
  })
  handle('review:checks', (_, id: string) => {
    const pr = store.task(id).prReview?.pr
    if (!pr) throw new Error('Not a review of a PR')
    return prChecks(pr.url)
  })
  // The user's Export review: a save dialog, then the archive; null when they cancel.
  handle('review:export', async (e, id: string) => {
    const review = store.task(id).prReview
    if (!review) throw new Error('Not a review of a PR')
    const r = await dialog.showSaveDialog({ title: 'Export review', defaultPath: join(app.getPath('downloads'), bundleFileName(review)), filters: [{ name: 'Review archive', extensions: ['zip'] }] })
    if (r.canceled || !r.filePath) return null
    return doExport(id, r.filePath, e.sender)
  })
  // The user's Import review: a dropped .zip, else one picked; a read-only review work, done. null when they cancel.
  handle('review:import', async (_, projectId: string, zipPath?: string) => {
    let path = zipPath
    if (!path) {
      const r = await dialog.showOpenDialog({ title: 'Import review', properties: ['openFile'], filters: [{ name: 'Review archive', extensions: ['zip'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      path = r.filePaths[0]
    }
    try {
      const task = importReview(
        {
          read: (p) => readFileSync(p),
          newId: () => randomUUID().slice(0, 8),
          saveDiff: (text) => {
            mkdirSync(importsDir, { recursive: true })
            const file = join(importsDir, `${randomUUID().slice(0, 8)}.diff`)
            writeFileSync(file, text)
            return file
          },
          create: (pid, review) => store.createImportedReview(pid, review),
        },
        projectId,
        path,
      )
      log.info('app', `${task.key}: review imported from ${path}`)
      return { taskId: task.id }
    } catch (e) {
      return { error: (e as Error).message.split('\n')[0] }
    }
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
  handle('integration:enable', (_, sid: string, itemId: string, mode: 'ask' | 'auto') => orch.enableIntegration(sid, itemId, mode))
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
