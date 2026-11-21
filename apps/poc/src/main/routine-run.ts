// A routine's run (routines-scheduled-drafts-and-a.1, .2), composed in the app layer since services never use services:
// routines (the slot lock), a headless session on the routine's prompt, then one Inbox item with what it did. The
// session reads what the CLI can; its writes go through Publish.
import type { Inbox, NewInboxItem } from './core/services/inbox/index.ts'
import { failedKey, routineRef, runKey } from './core/services/routines/refs.ts'
import type { Routine, RoutineRun, Routines } from './core/services/routines/index.ts'

export { failedKey, runKey, runOfKey } from './core/services/routines/refs.ts'

/** How long a run may take before it is stopped and fails. */
export const DRAFTER_TIMEOUT_MS = 30 * 60_000

/** A run's session as the orchestrator starts it: its id, and when it ends, its error (null: fine) and last reply. */
export interface DrafterRun {
  sessionId: string
  done: Promise<{ error: string | null; summary: string | null }>
}

export interface RoutineRunnerDeps {
  routines: Routines
  inbox: Pick<Inbox, 'add' | 'resolve'>
  /** The workspace's folder: refs start with it. */
  folder(workspaceId: string): string
  /** Starts the headless session of a run on `prompt`, in the routine's workspace and project. */
  startDrafter(routine: Routine, run: RoutineRun, prompt: string): DrafterRun
  /** Stops a session that ran out of time. */
  stop(sessionId: string): Promise<void>
  timeoutMs?: number
}

export interface RoutineRunner {
  /**
   * Starts a run (its due slot, or Run now): `run` as started, `done` once it ended. Throws, starting nothing, while it
   * runs or when its slot is not due or already ran.
   */
  run(routineId: string, trigger: 'slot' | 'now'): { run: RoutineRun; done: Promise<RoutineRun> }
  /** A deliverable saved by a session: the draft of its run, when it is a routine's. */
  saved(sessionId: string, deliverableRef: string): void
}

const labelsOf = (r: Routine) => (r.projectId ? [r.projectId] : [])

/** A routine's failure in the Inbox, with its error; its ref is what Retry runs. */
export const failedItem = (r: Routine, folder: string, error: string): NewInboxItem => ({
  key: failedKey(r.id),
  kind: 'other',
  text: `${r.name} failed: ${error}`,
  workspaceId: r.workspaceId,
  projectId: r.projectId,
  ref: routineRef(folder, r.id),
  labels: labelsOf(r),
})

/** A run's outcome in the Inbox: its summary, about its draft when it made one, else the routine. */
export const ranItem = (r: Routine, run: RoutineRun, folder: string): NewInboxItem => ({
  key: runKey(r.id, run.id),
  kind: run.deliverableRef ? 'draft' : 'other',
  text: `${r.name} ran: ${run.summary?.trim() || (run.deliverableRef ? 'made a draft' : 'done')}`,
  workspaceId: r.workspaceId,
  projectId: r.projectId,
  ref: run.deliverableRef ?? routineRef(folder, r.id),
  labels: labelsOf(r),
})

/** The run's first message: the routine's prompt, and how a headless run ends. */
export function drafterPrompt(routine: Routine): string {
  return `This is a run of your routine "${routine.name}" in mag. Nobody reads this chat while it runs, so don't ask: decide, and say what you could not check.

${routine.prompt}

How a run ends:
- Something for the user to read, review or send: save it with save_deliverable; it is a draft the user reviews.
- Something that needs the user (a decision, a reply, a blocker): add_inbox_item, one per thing.
- Don't write outside mag (a post, a comment, a doc edit): put the text in the draft; the user publishes it.
- Your last message is one line on what this run did: the user sees it in the Inbox.`
}

/** The last line of a reply, cut to fit an Inbox row. */
const lastLine = (text: string | null) => {
  const line = text?.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  return line ? (line.length > 300 ? `${line.slice(0, 299)}…` : line) : null
}

export function createRoutineRunner(deps: RoutineRunnerDeps): RoutineRunner {
  const { routines, inbox } = deps
  const timeoutMs = deps.timeoutMs ?? DRAFTER_TIMEOUT_MS

  const fail = (r: Routine, run: RoutineRun, error: string) => {
    const ended = routines.finishRun(run.id, { status: 'failed', error })
    inbox.add(failedItem(r, deps.folder(r.workspaceId), error))
    return ended
  }

  const drive = async (r: Routine, run: RoutineRun): Promise<RoutineRun> => {
    try {
      const drafter = deps.startDrafter(r, run, drafterPrompt(r))
      routines.attachSession(run.id, drafter.sessionId)
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<'timeout'>((done) => (timer = setTimeout(() => done('timeout'), timeoutMs)))
      const end = await Promise.race([drafter.done, timedOut])
      clearTimeout(timer)
      if (end === 'timeout') {
        await deps.stop(drafter.sessionId).catch(() => {})
        return fail(r, run, `timed out after ${Math.round(timeoutMs / 60_000)} min`)
      }
      if (end.error) return fail(r, run, end.error)
      const ended = routines.finishRun(run.id, { status: 'done', summary: lastLine(end.summary), deliverableRef: null })
      inbox.add(ranItem(r, ended, deps.folder(r.workspaceId)))
      inbox.resolve(failedKey(r.id))
      return ended
    } catch (e) {
      return fail(r, run, (e as Error).message ?? String(e))
    }
  }

  return {
    run(routineId, trigger) {
      const run = routines.startRun(routineId, trigger)
      return { run, done: drive(routines.get(routineId), run) }
    },
    saved(sessionId, ref) {
      const run = routines.runOfSession(sessionId)
      if (run) routines.attachDraft(run.id, ref)
    },
  }
}
