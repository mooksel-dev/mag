import { Menu, Notification, app } from 'electron'
import type { Store } from './store'
import type { Inbox } from './core/services/inbox/index.ts'
import type { Windows } from './windows'
import { attentionItems, newAttention } from './attention-items'
import { rebuildOnChange, recentProjects } from './menu'

/** The store changes on every chat delta; look at the inbox at most this often. */
const THROTTLE_MS = 250

/**
 * What waits on the user while their project's window is closed or in the background: the dock badge (the workspace
 * inbox), a system notification per new inbox item, and the dock menu with recent projects.
 */
export function startAttention(store: Store, windows: Windows, inbox: Inbox) {
  /** Inbox items per project of the recent ones. */
  const recentWaiting = () => {
    const items = inbox.items()
    return recentProjects(store).map((p) => ({ p, n: items.filter((i) => i.projectId === p.id).length }))
  }

  // Items already waiting on start are not news.
  const seen = new Set<string>()
  newAttention(seen, attentionItems(inbox.items(), store.data.projects, store.data.tasks))
  // Electron drops click handlers of notifications that are garbage-collected.
  const shown = new Set<Notification>()

  let badge: string | null = null
  const check = () => {
    const items = inbox.items()
    const next = items.length ? String(items.length) : ''
    if (next !== badge) app.dock?.setBadge((badge = next))
    if (!Notification.isSupported()) return
    for (const item of newAttention(seen, attentionItems(items, store.data.projects, store.data.tasks))) {
      if (windows.focusedProject() === item.projectId) continue
      const n = new Notification({ title: item.title, body: item.body })
      shown.add(n)
      n.on('click', () => {
        shown.delete(n)
        try {
          windows.focusTask(item.taskId)
        } catch {
          // the task is gone
        }
      })
      n.on('close', () => shown.delete(n))
      n.show()
    }
  }
  let timer: NodeJS.Timeout | null = null
  check()
  store.onChange(() => {
    timer ??= setTimeout(() => {
      timer = null
      check()
    }, THROTTLE_MS)
  })

  if (!app.dock) return
  const dock = app.dock
  rebuildOnChange(
    store,
    () => recentWaiting().map(({ p, n }) => `${p.id}:${p.name}:${n}`).join('|'),
    () => {
      const recent = recentWaiting().map(({ p, n }) => ({ label: n ? `${p.name} (${n} waiting)` : p.name, click: () => void windows.openProject(p.id) }))
      dock.setMenu(
        Menu.buildFromTemplate([
          ...recent,
          ...(recent.length ? [{ type: 'separator' as const }] : []),
          { label: 'Open Project…', click: () => windows.showPicker('open') },
          { label: 'New Project…', click: () => windows.showPicker('new') },
        ]),
      )
    },
  )
}
