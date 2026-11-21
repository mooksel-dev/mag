import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import type { AgentSession } from '@mag/core'
import { createWorkspaceFiles } from './core/clients/workspace-files/index.ts'
import type { Deliverables } from './core/services/deliverables/index.ts'
import { workspaceFolder } from './core/services/deliverables/index.ts'
import { createPacks } from './core/services/packs/index.ts'
import { deliverableOrigin } from './tools.ts'
import { createPackPrompts, type PackPrompts } from './pack-tools.ts'
import { log } from './log'
import type { Store } from './store'

/**
 * Workflow packs (deliverables-library-claims-review-and.3): per kind in ~/Documents/mag/<workspace>/packs, the defaults
 * seeded in every workspace on start; the propose_rule card's Accept and Reject.
 */
export function startPacks(store: Store, deliverables: Deliverables): PackPrompts {
  const packs = createPacks({ files: createWorkspaceFiles(() => join(app.getPath('documents'), 'mag')) })
  for (const ws of store.workspaces()) {
    try {
      packs.seedDefaults(workspaceFolder(ws.name))
    } catch (e) {
      log.warn('packs', `seeding the packs of ${ws.name} failed`, e)
    }
  }
  const originOf = (session: AgentSession) => deliverableOrigin(store, store.sessionScope(session), { sessionId: session.id })
  const prompts = createPackPrompts({ store, packs, deliverables: () => deliverables, originOf })
  ipcMain.handle('rule:answer', (_, sid: string, itemId: string, accept: boolean) => prompts.answerRule(sid, itemId, accept === true))
  return prompts
}
