import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { createWorkspaceFiles } from './core/clients/workspace-files/index.ts'
import { createDeliverables, currentVersion, type Deliverable, type Deliverables } from './core/services/deliverables/index.ts'
import { log } from './log'
import type { Store } from './store'

/** What the topic gets on the user's Publish: post the final version where it goes; the Publish card does the rest. */
export function publishMessage(ref: string, d: Deliverable): string {
  const where = d.destination ? `to ${d.destination.label}` : 'where it is meant to go (ask the user in one line if that is not clear)'
  return `The user pressed Publish on ${ref} v${currentVersion(d)} (final). Post the text of read("${ref}") ${where} with your integration or CLI, unchanged. mag shows the user its Publish card; Allow posts it and marks the deliverable published.`
}

/**
 * Deliverables (deliverables-library-claims-review-and.1): versions in ~/Documents/mag/<workspace>/deliverables, the
 * records in the store; the artifact pane's Mark final, Show in Finder and Publish. Deliverables whose folder was
 * deleted are forgotten on start and whenever a window gets focus.
 */
export function startDeliverables(store: Store, send: (sessionId: string, text: string, job: string) => Promise<void>): Deliverables {
  const dlv = createDeliverables({ files: createWorkspaceFiles(() => join(app.getPath('documents'), 'mag')), records: store.deliverableRecords() })
  const prune = () => {
    try {
      dlv.prune()
    } catch (e) {
      log.warn('deliverables', 'pruning deleted deliverables failed', e)
    }
  }
  prune()
  app.on('browser-window-focus', prune)
  // A version file deleted by hand leaves the record; a read then fails with its reason, shown in the pane.
  ipcMain.handle('dlv:read', (_, id: string, n?: number) => dlv.read(id, typeof n === 'number' ? n : undefined))
  ipcMain.handle('dlv:markFinal', (_, id: string, n: number) => void dlv.markFinal(id, n))
  ipcMain.handle('dlv:reveal', (_, id: string) => dlv.reveal(id))
  ipcMain.handle('dlv:publish', async (_, id: string) => {
    const d = dlv.get(id)
    if (!d.topicId || !store.data.sessions.some((s) => s.id === d.topicId)) throw new Error(`${dlv.refOf(d)} has no topic to publish it from`)
    dlv.requestPublish(id, d.topicId)
    await send(d.topicId, publishMessage(dlv.refOf(d), d), 'Publish')
  })
  return dlv
}
