import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { Project } from '@mag/core'
import type { Store } from './store'
import type { Windows } from './windows'

/** Projects of the recent list that still exist, most recent first. */
export function recentProjects(store: Store): Project[] {
  return store.recent().flatMap((id) => store.data.projects.filter((p) => p.id === id))
}

/** Calls `build` now and on every store change that alters `key`; the store changes on every chat delta. */
export function rebuildOnChange(store: Store, key: () => string, build: () => void) {
  let last: string | null = null
  const run = () => {
    const k = key()
    if (k === last) return
    last = k
    build()
  }
  run()
  store.onChange(run)
}

/** The application menu: File → New Project…, Open Project… (⌘O), Open Recent. */
export function startAppMenu(store: Store, windows: Windows, openLogs: () => void) {
  const build = () => {
    const recent = recentProjects(store)
    const file: MenuItemConstructorOptions[] = [
      { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => windows.showPicker('new') },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => windows.showPicker('open') },
      {
        label: 'Open Recent',
        submenu: recent.length
          ? recent.map((p) => ({ label: p.name, click: () => void windows.openProject(p.id) }))
          : [{ label: 'No recent projects', enabled: false }],
      },
      { type: 'separator' },
      { role: 'close' },
    ]
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { label: 'File', submenu: file },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        { role: 'help', submenu: [{ label: 'Open logs folder', click: () => void openLogs() }] },
      ]),
    )
  }
  rebuildOnChange(store, () => recentProjects(store).map((p) => `${p.id}:${p.name}`).join('|'), build)
}
