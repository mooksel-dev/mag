import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { basename, extname, join, normalize } from 'node:path'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { canMoveInPlan, nextPlanRank, planBlockers, planQueue, subtaskStarted, subtasksOf, type Attachment, type Project, type Task } from '@mag/core'
import { claudeCode } from '@mag/agents'
import type { AppState, NewTask } from '../preload/api'
import { Store } from './store'
import { createTools, type ToolActions } from './tools'
import { startApi } from './api'
import { Orchestrator } from './orchestrator'
import { startScheduler } from './scheduler'
import { repoInfo } from './git'

let win: BrowserWindow | null = null

// Apps launched from Finder get a minimal PATH; take the login shell's so git, gh and claude resolve.
try {
  const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 })
  if (shellPath.trim()) process.env.PATH = shellPath.trim().split('\n').pop()
} catch {
  // keep the inherited PATH
}

// Serves attached files to the renderer: mag-file://att/<file name>
protocol.registerSchemesAsPrivileged([{ scheme: 'mag-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.html': 'text/html', '.csv': 'text/csv',
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'mag PoC',
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const store = new Store(join(userData, 'db.json'))
  const attachmentsDir = join(userData, 'attachments')
  mkdirSync(attachmentsDir, { recursive: true })
  const actions: ToolActions = { groom: () => {}, architect: () => {} }
  const api = await startApi(createTools(store, actions))
  const orch = new Orchestrator(store, api, {
    mcpScript: join(__dirname, 'task-mcp.js'),
    runsDir: join(userData, 'runs'),
    worktreesDir: join(userData, 'worktrees'),
    attachmentsDir,
  })
  actions.groom = (id) => orch.groom(id)
  actions.architect = (id) => orch.architect(id)

  protocol.handle('mag-file', (req) => {
    const file = normalize(join(attachmentsDir, decodeURIComponent(new URL(req.url).pathname)))
    if (!file.startsWith(attachmentsDir)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
  const scheduler = startScheduler(store, orch)
  const claudeBin = await claudeCode.detect()

  const snapshot = (): AppState => {
    const { canvases: _, ...data } = store.data
    return { ...data, canvases: store.canvasList(), claudeBin }
  }
  store.onChange(() => win?.webContents.send('state', snapshot()))
  app.on('browser-window-focus', () => void scheduler.pollNow())

  ipcMain.handle('state:get', () => snapshot())
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('project:create', (_, name: string) => store.createProject(name))
  ipcMain.handle('project:update', (_, id: string, patch: Partial<Project>) => store.updateProject(id, patch))
  ipcMain.handle('task:create', (_, t: NewTask) => store.createTask(t))
  ipcMain.handle('task:update', (_, id: string, patch: Partial<Task>) => store.updateTask(id, patch))
  ipcMain.handle('task:groom', (_, id: string) => orch.groom(id))
  const projectTasks = (projectId: string) => store.data.tasks.filter((t) => t.projectId === projectId)
  ipcMain.handle('task:addToPlan', (_, id: string) => {
    const task = store.task(id)
    const reasons = planBlockers(task)
    if (reasons.length) return { ok: false, reasons }
    const tasks = projectTasks(task.projectId)
    store.updateTask(id, { status: 'planned', rank: nextPlanRank(tasks) })
    for (const sub of subtasksOf(id, tasks)) store.updateTask(sub.id, { status: 'planned' })
    return { ok: true, reasons }
  })
  ipcMain.handle('task:move', (_, id: string, dir: 'up' | 'down') => {
    const task = store.task(id)
    const tasks = projectTasks(task.projectId)
    if (!canMoveInPlan(task, tasks, dir)) throw new Error(`${task.key} cannot move ${dir}`)
    const queue = planQueue(tasks)
    const other = queue[queue.indexOf(task) + (dir === 'up' ? -1 : 1)]
    const [a, b] = [task.rank, other.rank]
    store.updateTask(other.id, { rank: a })
    store.updateTask(task.id, { rank: b })
  })
  ipcMain.handle('task:reorderSubtasks', (_, parentId: string, ids: string[]) => {
    const subs = subtasksOf(parentId, store.data.tasks)
    const moved = subs.find((t, i) => subtaskStarted(t) && ids[i] !== t.id)
    if (moved) throw new Error(`${moved.key} has started; it keeps its place`)
    store.reorderSubtasks(parentId, ids)
  })
  ipcMain.handle('task:develop', (_, id: string) => orch.develop(id))
  ipcMain.handle('pr:checkNow', () => scheduler.pollNow())
  ipcMain.handle('shell:open', (_, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
    return shell.openPath(url)
  })
  ipcMain.handle('arch:run', (_, projectId: string) => orch.architect(projectId))
  ipcMain.handle('agents:list', () => orch.agents())
  ipcMain.handle('repo:info', (_, path: string) => repoInfo(path))
  ipcMain.handle('session:send', (_, sid: string, text: string, attachments?: Attachment[]) => orch.send(sid, text, attachments))
  ipcMain.handle('chat:new', (_, projectId: string) => orch.newChat(projectId))
  ipcMain.handle('canvas:get', (_, id: string) => store.data.canvases[id]?.html ?? null)
  ipcMain.handle('attach:save', (_, f: { name: string; bytes?: Uint8Array; path?: string }): Attachment => {
    const name = basename(f.name || (f.path ? basename(f.path) : 'file')).replace(/[^\w.-]+/g, '_') || 'file'
    const path = join(attachmentsDir, `${randomUUID().slice(0, 8)}-${name}`)
    if (f.bytes) writeFileSync(path, f.bytes)
    else if (f.path) copyFileSync(f.path, path)
    else throw new Error('Nothing to attach')
    return { name, path, mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' }
  })
  ipcMain.handle('session:stop', (_, sid: string) => orch.stop(sid))

  createWindow()
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
