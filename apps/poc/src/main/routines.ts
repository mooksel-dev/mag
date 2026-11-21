import { ipcMain, shell } from 'electron'
import { workspaceLabels } from '@mag/core'
import { DELIVERABLE_KINDS, workspaceFolder, type Deliverables } from './core/services/deliverables/index.ts'
import type { Inbox } from './core/services/inbox/index.ts'
import { createRoutines, type RoutineInput, type Routines } from './core/services/routines/index.ts'
import type { Orchestrator } from './orchestrator'
import type { PackPrompts } from './pack-tools.ts'
import { createRoutineRunner, failedItem } from './routine-run.ts'
import { startRoutineSchedule } from './scheduler.ts'
import type { Store } from './store'

/**
 * Routines (routines-scheduled-drafts-and-a.1): the service over the store, runs left by a closed mag failed (each in
 * the Inbox with Retry), the runner the orchestrator composes runs with, the schedule's tick and the Routines section's
 * save, remove and Run now.
 */
export function startRoutines(deps: { store: Store; orch: Orchestrator; deliverables: Deliverables; packs: PackPrompts; inbox: Inbox }): Routines {
  const { store, orch, inbox } = deps
  const routines = createRoutines({ records: store.routineRecords(), kinds: DELIVERABLE_KINDS })
  const origin = (workspaceId: string) => ({ workspaceId, folder: workspaceFolder(store.workspace(workspaceId).name), projectId: null, topicId: null, taskId: null })
  for (const run of routines.recover()) {
    const r = routines.get(run.routineId)
    inbox.add(failedItem(r, origin(r.workspaceId).folder, run.error ?? 'failed'))
  }
  orch.routineRunner = createRoutineRunner({
    routines,
    deliverables: deps.deliverables,
    inbox,
    pack: (workspaceId, kind) => deps.packs.packAt(workspaceId, null, kind),
    origin,
    labelNames: (ids) => {
      const names = new Map(store.workspaces().flatMap((w) => workspaceLabels(w.id, store.data).flatMap((v) => v.labels.map((l) => [l.id, l.name] as const))))
      return ids.flatMap((id) => names.get(id) ?? [])
    },
    startDrafter: (routine, run, prompt) => orch.startDrafter(routine, run, prompt),
    stop: (sessionId) => orch.stop(sessionId),
  })
  ipcMain.handle('routine:save', (_, input: RoutineInput) => routines.save(input))
  ipcMain.handle('routine:remove', (_, id: string) => routines.remove(id))
  ipcMain.handle('routine:run', (_, id: string) => orch.runRoutine(id, 'now'))
  ipcMain.handle('routine:revealPack', (_, id: string) => {
    const r = routines.get(id)
    const pack = deps.packs.packAt(r.workspaceId, null, r.kind)
    const file = pack.rules[0] ?? pack.prompt ?? pack.template ?? pack.rubric
    if (!file) throw new Error(`The ${r.kind} pack has no files yet`)
    shell.showItemInFolder(file.path)
  })
  startRoutineSchedule(routines, (id) => orch.runRoutine(id, 'slot'))
  return routines
}
