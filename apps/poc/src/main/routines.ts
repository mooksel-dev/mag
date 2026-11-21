import { ipcMain } from 'electron'
import { workspaceFolder } from './core/services/deliverables/index.ts'
import type { Inbox } from './core/services/inbox/index.ts'
import { createRoutines, type RoutineInput, type Routines } from './core/services/routines/index.ts'
import type { Orchestrator } from './orchestrator'
import { createRoutineRunner, failedItem } from './routine-run.ts'
import { startRoutineSchedule } from './scheduler.ts'
import type { Store } from './store'

/**
 * Routines (routines-scheduled-drafts-and-a.1, .2): the service over the store, runs left by a closed mag failed (each
 * in the Inbox with Retry), the runner the orchestrator composes runs with, the schedule's tick and the Routines
 * view's save, remove and Run now.
 */
export function startRoutines(deps: { store: Store; orch: Orchestrator; inbox: Inbox }): Routines {
  const { store, orch, inbox } = deps
  const routines = createRoutines({ records: store.routineRecords() })
  const folder = (workspaceId: string) => workspaceFolder(store.workspace(workspaceId).name)
  for (const run of routines.recover()) {
    const r = routines.get(run.routineId)
    inbox.add(failedItem(r, folder(r.workspaceId), run.error ?? 'failed'))
  }
  orch.routineRunner = createRoutineRunner({
    routines,
    inbox,
    folder,
    startDrafter: (routine, run, prompt) => orch.startDrafter(routine, run, prompt),
    stop: (sessionId) => orch.stop(sessionId),
  })
  ipcMain.handle('routine:save', (_, input: RoutineInput) => routines.save(input))
  ipcMain.handle('routine:remove', (_, id: string) => routines.remove(id))
  ipcMain.handle('routine:run', (_, id: string) => orch.runRoutine(id, 'now'))
  startRoutineSchedule(routines, (id) => orch.runRoutine(id, 'slot'))
  return routines
}
