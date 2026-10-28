import { Menu, Notification, app } from 'electron'
import { waitingTotal } from '@mag/core'
import type { Store } from './store'
import type { Windows } from './windows'
import { attentionItems, newAttention } from './attention-items'
import { rebuildOnChange, recentProjects } from './menu'

/** The store changes on every chat delta; look at the inbox at most this often. */
const THROTTLE_MS = 250

/**
 * What waits on the user while their project's window is closed or in the background: the dock badge (inbox items
 * across all projects), a system notification per new inbox item, and the dock menu with recent projects.
 */
export function startAttention(store: Store, windows: Windows) {
  const waitingIn = (projectId: string) => waitingTotal([{ id: projectId }], store.data.tasks, store.data.sessions)

  // Items already waiting on start are not news.
  const seen = new Set<string>()
  newAttention(seen, attentionItems(store.data.projects, store.data.tasks, store.data.sessions))
  // Electron drops click handlers of notifications that are garbage-collected.
  const shown = new Set<Notification>()

  let badge: string | null = null
  const check = () => {
    const { projects, tasks, sessions } = store.data
    const total = waitingTotal(projects, tasks, sessions)
    const next = total ? String(total) : ''
    if (next !== badge) app.dock?.setBadge((badge = next))
    if (!Notification.isSupported()) return
    for (const item of newAttention(seen, attentionItems(projects, tasks, sessions))) {
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
    () => recentProjects(store).map((p) => `${p.id}:${p.name}:${waitingIn(p.id)}`).join('|'),
    () => {
      const recent = recentProjects(store).map((p) => {
        const n = waitingIn(p.id)
        return { label: n ? `${p.name} (${n} waiting)` : p.name, click: () => void windows.openProject(p.id) }
      })
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
