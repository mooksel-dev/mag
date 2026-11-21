import { BrowserWindow, app, screen, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { join } from 'node:path'
import type { AppState, PickerMode, WindowTarget } from '../preload/api'
import type { Store } from './store'
import { onSomeDisplay, type Bounds } from './bounds'
import { resolveView, viewHash, viewShows, type WindowView, type WorkspaceWindow } from './windowViews'

const MAIN_SIZE = { width: 1400, height: 900 }
const WELCOME_SIZE = { width: 720, height: 560 }
const POPOUT_SIZE = { width: 1100, height: 800 }
/** The review window is one long page with a chat drawer at its side. */
const REVIEW_SIZE = { width: 1400, height: 950 }
/** Offset of each new main window from the focused one, so they don't stack exactly. */
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
 * Every window of the app: main windows, each showing a workspace (several at once, more than one of a workspace too)
 * or one project of it (slack-like-shell-rail-resizable.2), with the view in the URL hash; the Welcome window shown
 * when none is open; and pop-outs that show one artifact each (architecture, canvas, task doc, review).
 */
export function createWindows(store: Store) {
  /** Main windows and what each shows, in opening order. */
  const mains = new Map<BrowserWindow, WindowView>()
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
    const list: WorkspaceWindow[] = [...mains].map(([win, view]) => ({ ...view, bounds: win.getNormalBounds() }))
    store.setWorkspaceWindows(list)
  }

  let boundsTimer: NodeJS.Timeout | null = null
  const saveSoon = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (!quitting) saveOpen()
    }, 500)
  }

  /** Bounds for a new main window: saved ones, else next to the focused main window, else centered. */
  function newBounds(saved?: Bounds): Partial<Bounds> {
    const ok = usable(saved)
    if (ok) return ok
    const near = BrowserWindow.getFocusedWindow()
    if (near && mains.has(near)) {
      const b = near.getNormalBounds()
      const next = { ...b, x: b.x + CASCADE, y: b.y + CASCADE }
      if (usable(next)) return next
    }
    return MAIN_SIZE
  }

  const titleOf = (view: WindowView) => (view.projectId ? store.project(view.projectId).name : store.workspace(view.workspaceId).name)

  /** A new main window showing `view`. */
  function openView(view: WindowView, saved?: Bounds): BrowserWindow {
    const win = new BrowserWindow({ ...MAIN_SIZE, ...newBounds(saved), title: titleOf(view), ...base })
    mains.set(win, view)
    load(win, viewHash(view))
    win.on('move', saveSoon)
    win.on('resize', saveSoon)
    // Closing a window asks nothing and stops no agent: chats and tasks go on in the main process.
    win.on('closed', () => {
      mains.delete(win)
      if (!quitting) saveOpen()
      changed()
    })
    if (!quitting) saveOpen()
    changed()
    return win
  }

  /** A new window of the workspace, its column whole; always a new one, so a workspace can be open twice. */
  function openWorkspace(workspaceId: string, saved?: Bounds): BrowserWindow {
    store.workspace(workspaceId)
    return openView({ workspaceId, projectId: null }, saved)
  }

  /** The first main window matching `fn`, in opening order. */
  const findMain = (fn: (view: WindowView) => boolean) => [...mains].find(([, v]) => fn(v))?.[0]

  /** Focuses the window filtered to the project, or opens one: a workspace window with its column filtered to it. */
  function openProject(projectId: string): BrowserWindow {
    const p = store.project(projectId)
    store.touchRecent(projectId)
    const open = findMain((v) => v.projectId === projectId)
    if (open) {
      focusWin(open)
      return open
    }
    return openView({ workspaceId: p.workspaceId, projectId })
  }

  /** The Welcome window closes once a main window opens from it. */
  const closeWelcomeFrom = (sender: WebContents) => {
    if (welcomeWin && sender === welcomeWin.webContents) welcomeWin.close()
  }

  function openProjectFrom(sender: WebContents, projectId: string) {
    openProject(projectId)
    closeWelcomeFrom(sender)
  }

  /** ⌘⇧N and the workspace menu's Open in new window: a new window of the workspace (else the focused window's). */
  function openWorkspaceFrom(sender: WebContents | null, workspaceId?: string) {
    const focused = BrowserWindow.getFocusedWindow()
    const wid = workspaceId ?? (focused && mains.get(focused)?.workspaceId) ?? [...mains.values()].at(-1)?.workspaceId ?? store.workspaces()[0]?.id
    if (!wid) return
    openWorkspace(wid)
    if (sender) closeWelcomeFrom(sender)
  }

  /** The sender's window shows workspace `workspaceId` whole from now on; it reloads with the new view. */
  function switchWorkspace(sender: WebContents, workspaceId: string) {
    store.workspace(workspaceId)
    const win = BrowserWindow.fromWebContents(sender)
    if (!win || !mains.has(win)) return
    const view = { workspaceId, projectId: null }
    mains.set(win, view)
    win.setTitle(titleOf(view))
    load(win, viewHash(view))
    saveOpen()
    changed()
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

  /**
   * Reopens the main windows of the last run with their bounds (old project windows as windows filtered to their
   * project), skipping what was deleted; Welcome when there are none.
   */
  function restore() {
    const place = { workspaces: store.workspaces(), projects: store.data.projects }
    for (const w of store.workspaceWindows()) {
      const view = resolveView(w, place)
      if (view) openView(view, w.bounds)
    }
    if (!mains.size) welcome()
  }

  /** Whether the focused window is a main window that shows the project. */
  function focusedShows(projectId: string): boolean {
    const win = BrowserWindow.getFocusedWindow()
    const view = win && mains.get(win)
    const p = store.data.projects.find((x) => x.id === projectId)
    return !!(view && p && viewShows(view, p))
  }

  /** The focused main window, else the most recent one. */
  const currentMain = () => {
    const win = BrowserWindow.getFocusedWindow()
    return win && mains.has(win) ? win : [...mains.keys()].at(-1)
  }

  /** Shows the project picker (or the new-project form) in the current main window; Welcome when none is open. */
  function showPicker(mode: PickerMode) {
    const win = currentMain() ?? welcome()
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

  /**
   * A main window that shows the project: the focused one if it does, else the one filtered to it, else a window of its
   * workspace; null when none is open.
   */
  function windowShowing(projectId: string): BrowserWindow | null {
    const p = store.project(projectId)
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focusedShows(projectId)) return focused
    return findMain((v) => v.projectId === projectId) ?? findMain((v) => viewShows(v, p)) ?? null
  }

  /** Shows the task in a window that shows its project, else in a new window filtered to its project. */
  function focusTask(taskId: string) {
    const task = store.task(taskId)
    const open = windowShowing(task.projectId)
    if (open) focusWin(open)
    sendWhenLoaded(open ?? openProject(task.projectId), 'open-task', task.projectId, task.id)
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
    const win = popouts.get(`review:${taskId}`) ?? windowShowing(projectId)
    return win && !win.isDestroyed() ? win.webContents : null
  }

  return {
    openProject,
    openWorkspace,
    openWorkspaceFrom,
    switchWorkspace,
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
    focusedShows,
    /** Projects that have a window filtered to them, in opening order. */
    openProjects: () => [...new Set([...mains.values()].flatMap((v) => v.projectId ?? []))],
    /** Workspaces that have a window of their own (not filtered to a project), in opening order. */
    openWorkspaces: () => [...new Set([...mains.values()].flatMap((v) => (v.projectId ? [] : v.workspaceId)))],
    /** A main or Welcome window is open (pop-outs alone don't count). */
    hasMainWindow: () => mains.size > 0 || !!welcomeWin,
    /** Called when a main window opens, closes or changes its view. */
    onChange: (fn: () => void) => void listeners.push(fn),
  }
}

export type Windows = ReturnType<typeof createWindows>
