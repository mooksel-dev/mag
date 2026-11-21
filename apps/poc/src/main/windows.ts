import { BrowserWindow, app, screen, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { join } from 'node:path'
import type { AppState, PickerMode, WindowTarget } from '../preload/api'
import type { ProjectWindow, Store } from './store'
import { onSomeDisplay, type Bounds } from './bounds'

const PROJECT_SIZE = { width: 1400, height: 900 }
const WELCOME_SIZE = { width: 720, height: 560 }
const POPOUT_SIZE = { width: 1100, height: 800 }
/** The review window is one long page with a chat drawer at its side. */
const REVIEW_SIZE = { width: 1400, height: 950 }
/** Offset of each new project window from the focused one, so they don't stack exactly. */
const CASCADE = 28

/** Window icon (Windows, Linux) and dock icon (macOS). The app is not packaged, so it is read from the source tree next to `out/`. */
export const ICON = join(__dirname, '../../resources/icon.png')

const targetId = (t: WindowTarget) => (t.kind === 'architecture' ? t.projectId : t.kind === 'canvas' ? t.canvasId : t.taskId)

const focusWin = (win: BrowserWindow) => {
  if (win.isMinimized()) win.restore()
  win.focus()
}

/** Sends once the page has loaded, so a window opened for the message gets it. */
const sendWhenLoaded = (win: BrowserWindow, channel: string, ...args: unknown[]) => {
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send(channel, ...args))
  else win.webContents.send(channel, ...args)
}

/**
 * Every window of the app: one window per open project (the project lives in the URL hash), the Welcome window
 * shown when no project is open, and pop-outs that show one artifact each (architecture, canvas, task doc, review).
 */
export function createWindows(store: Store) {
  const projects = new Map<string, BrowserWindow>()
  const popouts = new Map<string, BrowserWindow>()
  let welcomeWin: BrowserWindow | null = null
  /** On quit the windows close one by one; the set that was open is kept for the next start. */
  let quitting = false
  const listeners: (() => void)[] = []
  const changed = () => listeners.forEach((fn) => fn())

  app.on('before-quit', () => {
    quitting = true
    saveOpen()
  })

  const load = (win: BrowserWindow, hash?: string) => {
    if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''))
    else win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }

  const base: BrowserWindowConstructorOptions = {
    icon: ICON,
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
    // The renderer draws the title bar, tinted with the project color.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
  }

  const workAreas = () => screen.getAllDisplays().map((d) => d.workArea)
  const usable = (b: Bounds | undefined) => (b && onSomeDisplay(b, workAreas()) ? b : undefined)

  function saveOpen() {
    const list: ProjectWindow[] = [...projects].map(([projectId, win]) => ({ projectId, bounds: win.getNormalBounds() }))
    store.setProjectWindows(list)
  }

  let boundsTimer: NodeJS.Timeout | null = null
  const saveSoon = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (!quitting) saveOpen()
    }, 500)
  }

  /** Bounds for a new project window: saved ones, else next to the focused window, else centered. */
  function newBounds(saved?: Bounds): Partial<Bounds> {
    const ok = usable(saved)
    if (ok) return ok
    const near = BrowserWindow.getFocusedWindow()
    if (near && [...projects.values()].includes(near)) {
      const b = near.getNormalBounds()
      const next = { ...b, x: b.x + CASCADE, y: b.y + CASCADE }
      if (usable(next)) return next
    }
    return PROJECT_SIZE
  }

  /** Focuses the project's window, or opens one. */
  function openProject(projectId: string, saved?: Bounds): BrowserWindow {
    store.project(projectId)
    const open = projects.get(projectId)
    store.touchRecent(projectId)
    if (open) {
      focusWin(open)
      return open
    }
    const win = new BrowserWindow({ ...PROJECT_SIZE, ...newBounds(saved), title: store.project(projectId).name, ...base })
    projects.set(projectId, win)
    load(win, `project=${encodeURIComponent(projectId)}`)
    win.on('move', saveSoon)
    win.on('resize', saveSoon)
    // Closing a window asks nothing and stops no agent: chats and tasks go on in the main process.
    win.on('closed', () => {
      if (projects.get(projectId) === win) projects.delete(projectId)
      if (!quitting) saveOpen()
      changed()
    })
    if (!quitting) saveOpen()
    changed()
    return win
  }

  /** Opens a project from a window; the Welcome window closes once a project opens from it. */
  function openProjectFrom(sender: WebContents, projectId: string) {
    openProject(projectId)
    if (welcomeWin && sender === welcomeWin.webContents) welcomeWin.close()
  }

  /** The one Welcome window: the project list for when no project is open. */
  function welcome(): BrowserWindow {
    if (welcomeWin) {
      focusWin(welcomeWin)
      return welcomeWin
    }
    const win = new BrowserWindow({ ...WELCOME_SIZE, title: 'mag', resizable: false, ...base })
    welcomeWin = win
    load(win, 'welcome')
    win.on('closed', () => {
      if (welcomeWin === win) welcomeWin = null
    })
    return win
  }

  /** Reopens the project windows from the last run, skipping deleted projects; Welcome when there are none. */
  function restore() {
    const known = new Set(store.data.projects.map((p) => p.id))
    const saved = store.projectWindows().filter((w) => known.has(w.projectId))
    for (const w of saved) openProject(w.projectId, w.bounds)
    if (!projects.size) welcome()
  }

  /** The project of the focused project window, if one is focused. */
  function focusedProject(): string | null {
    const win = BrowserWindow.getFocusedWindow()
    for (const [pid, w] of projects) if (w === win) return pid
    return null
  }

  /**
   * Shows the project picker (or the new-project form) in the focused project window, else in the most recent
   * project window; Welcome when no project is open.
   */
  function showPicker(mode: PickerMode) {
    const pid = focusedProject() ?? [...projects.keys()].at(-1)
    const win = pid ? projects.get(pid)! : welcome()
    focusWin(win)
    sendWhenLoaded(win, 'picker:open', mode)
  }

  /** Opens an artifact in its own window; one window per artifact, so a second call focuses it. */
  function openPopout(target: WindowTarget) {
    const id = targetId(target)
    const key = `${target.kind}:${id}`
    const open = popouts.get(key)
    if (open) {
      focusWin(open)
      return
    }
    const bounds = usable(store.windowBounds(target.kind)) ?? (target.kind === 'review' ? REVIEW_SIZE : POPOUT_SIZE)
    const win = new BrowserWindow({ ...bounds, title: 'mag', icon: ICON, webPreferences: base.webPreferences })
    popouts.set(key, win)
    load(win, `popout?${new URLSearchParams({ kind: target.kind, id })}`)
    win.on('close', () => store.saveWindowBounds(target.kind, win.getNormalBounds()))
    win.on('closed', () => popouts.delete(key))
  }

  /** Dev only (Develop → UI fixtures): the shared ui components in every state; one window, a second call focuses it. */
  function openUiFixtures() {
    const open = popouts.get('ui-fixtures')
    if (open) {
      focusWin(open)
      return
    }
    const win = new BrowserWindow({ ...POPOUT_SIZE, title: 'UI fixtures', icon: ICON, webPreferences: base.webPreferences })
    popouts.set('ui-fixtures', win)
    load(win, 'ui-fixtures')
    win.on('closed', () => popouts.delete('ui-fixtures'))
  }

  /** Shows the task in its project's window, opening the window if it is closed. */
  function focusTask(taskId: string) {
    const task = store.task(taskId)
    sendWhenLoaded(openProject(task.projectId), 'open-task', task.projectId, task.id)
  }

  /** Every window shows the same state, so pop-outs and other projects update live. */
  function broadcast(state: AppState) {
    sendAll('state', state)
  }

  function sendAll(channel: string, ...args: unknown[]) {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
  }

  /**
   * A window that can render a review for its archive (review-v2-part-2-v1-2.3): the review's own window when open, else
   * its project's; null when neither is.
   */
  function rendererFor(projectId: string, taskId: string): WebContents | null {
    const win = popouts.get(`review:${taskId}`) ?? projects.get(projectId)
    return win && !win.isDestroyed() ? win.webContents : null
  }

  return {
    openProject,
    rendererFor,
    openProjectFrom,
    welcome,
    restore,
    showPicker,
    openPopout,
    openUiFixtures,
    focusTask,
    broadcast,
    sendAll,
    focusedProject,
    /** Projects that have a window, in opening order. */
    openProjects: () => [...projects.keys()],
    /** A project or Welcome window is open (pop-outs alone don't count). */
    hasMainWindow: () => projects.size > 0 || !!welcomeWin,
    /** Called when a project window opens or closes. */
    onChange: (fn: () => void) => void listeners.push(fn),
  }
}

export type Windows = ReturnType<typeof createWindows>
