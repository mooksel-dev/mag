import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { AppState, WindowTarget } from '../preload/api'
import type { Store } from './store'
import { onSomeDisplay } from './bounds'

const POPOUT_SIZE = { width: 1100, height: 800 }

const targetId = (t: WindowTarget) => (t.kind === 'architecture' ? t.projectId : t.kind === 'canvas' ? t.canvasId : t.taskId)

/** The main window and the pop-out windows that show one artifact each (architecture, canvas, task doc). */
export function createWindows(store: Store) {
  let main: BrowserWindow | null = null
  const popouts = new Map<string, BrowserWindow>()

  const load = (win: BrowserWindow, hash?: string) => {
    if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''))
    else win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }

  const webPreferences = { preload: join(__dirname, '../preload/index.js') }

  function createMainWindow() {
    const win = new BrowserWindow({ width: 1400, height: 900, title: 'mag PoC', webPreferences })
    main = win
    load(win)
    win.on('closed', () => {
      if (main === win) main = null
    })
    return win
  }

  /** Opens the target in its own window; one window per artifact, so a second call focuses it. */
  function openPopout(target: WindowTarget) {
    const id = targetId(target)
    const key = `${target.kind}:${id}`
    const open = popouts.get(key)
    if (open) {
      if (open.isMinimized()) open.restore()
      open.focus()
      return
    }
    const saved = store.windowBounds(target.kind)
    const bounds = saved && onSomeDisplay(saved, screen.getAllDisplays().map((d) => d.workArea)) ? saved : POPOUT_SIZE
    const win = new BrowserWindow({ ...bounds, title: 'mag', webPreferences })
    popouts.set(key, win)
    load(win, `popout?${new URLSearchParams({ kind: target.kind, id })}`)
    win.on('close', () => store.saveWindowBounds(target.kind, win.getNormalBounds()))
    win.on('closed', () => popouts.delete(key))
  }

  /** Shows the task in the main window, opening the window if it was closed. */
  function focusTask(taskId: string) {
    const task = store.task(taskId)
    const send = (win: BrowserWindow) => win.webContents.send('open-task', task.projectId, task.id)
    if (main) {
      if (main.isMinimized()) main.restore()
      main.focus()
      send(main)
      return
    }
    const win = createMainWindow()
    win.webContents.once('did-finish-load', () => send(win))
  }

  /** Every window shows the same state, so pop-outs update live. */
  function broadcast(state: AppState) {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('state', state)
  }

  return { createMainWindow, openPopout, focusTask, broadcast, hasMainWindow: () => !!main }
}
