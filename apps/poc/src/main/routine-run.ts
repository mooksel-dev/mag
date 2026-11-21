// A routine's run (routines-scheduled-drafts-and-a.1), composed in the app layer since services never use services:
// routines (the slot lock), packs (prompt and rules), deliverables (the previous issue and the draft), a headless drafter
// session that writes the draft, then the inbox. Nothing is published.
import type { Deliverable, DeliverableKind, Deliverables, Origin } from './core/services/deliverables/index.ts'
import type { Inbox, NewInboxItem } from './core/services/inbox/index.ts'
import { packText, type Pack } from './core/services/packs/index.ts'
import { routineRef } from './core/services/routines/refs.ts'
import type { Routine, RoutineRun, Routines } from './core/services/routines/index.ts'

/** How long a drafter may run before it is stopped and the run fails. */
export const DRAFTER_TIMEOUT_MS = 30 * 60_000

/** A drafter session as the orchestrator starts it: its id, and when its run ends, its error (null: ended fine). */
export interface DrafterRun {
  sessionId: string
  done: Promise<{ error: string | null }>
}

export interface RoutineRunnerDeps {
  routines: Routines
  deliverables: Pick<Deliverables, 'draft' | 'lastFinal' | 'refOf' | 'get'>
  inbox: Pick<Inbox, 'add' | 'resolve'>
  /** The workspace's pack of `kind` (no project). */
  pack(workspaceId: string, kind: string): Pack
  /** Where a routine's draft is made: its workspace and folder, no project, topic or work. */
  origin(workspaceId: string): Origin
  /** Label names of label ids: deliverables carry names. */
  labelNames(ids: string[]): string[]
  /** Starts the headless drafter session of a run on `prompt`. */
  startDrafter(routine: Routine, run: RoutineRun, prompt: string): DrafterRun
  /** Stops a drafter that ran out of time. */
  stop(sessionId: string): Promise<void>
  timeoutMs?: number
}

export interface RoutineRunner {
  /**
   * Starts a run (its due slot, or Run now): `run` as started, `done` once it drafted or failed. Throws, starting
   * nothing, while it runs or when its slot is not due or already ran.
   */
  run(routineId: string, trigger: 'slot' | 'now'): { run: RoutineRun; done: Promise<RoutineRun> }
}

/** The inbox key of a routine's failure: one per routine, replaced by the next one, resolved by a run that drafts. */
export const failedKey = (routineId: string) => `routine:${routineId}:failed`

/** A routine's failure in the Inbox, with its error; its ref is what Retry runs. */
export const failedItem = (r: Routine, folder: string, error: string): NewInboxItem => ({ key: failedKey(r.id), kind: 'other', text: `${r.title} failed: ${error}`, workspaceId: r.workspaceId, ref: routineRef(folder, r.id), labels: r.labels })

/** The drafter's first message: what to draft, from what, by which pack, and how it ends. */
export function drafterPrompt(routine: Routine, ref: string, labels: string[], last: { ref: string; title: string } | null, pack: Pack): string {
  const sources = routine.sources.length ? routine.sources.map((s) => `- ${s}`).join('\n') : '- (none named: work from the brief and the pack)'
  const block = packText(pack)
  return `You draft "${routine.title}", a ${routine.kind} of a routine in mag. This is a headless run on its schedule: nobody reads this chat while it runs, so don't ask; decide and note what you could not check in the draft itself.

Draft: ${ref} (its v1 holds the brief). Save the whole text as its next version: save_deliverable(ref "${ref}", md${labels.length ? `, labels ${JSON.stringify(labels)}` : ''}).
${routine.brief ? `\nBrief: ${routine.brief}\n` : ''}
Sources, read-only, with your tools and CLIs:
${sources}

Previous issue: ${last ? `${last.ref} "${last.title}": read it with read("${last.ref}"); carry its format, don't repeat what it said.` : 'none yet.'}
${block ? `\n${block}\n` : ''}
Never publish, post or write anywhere outside mag: the user reviews the draft in the Inbox, marks it final and publishes it. End with one line on what the draft covers.`
}

export function createRoutineRunner(deps: RoutineRunnerDeps): RoutineRunner {
  const { routines, deliverables: dlv, inbox } = deps
  const timeoutMs = deps.timeoutMs ?? DRAFTER_TIMEOUT_MS

  const fail = (r: Routine, run: RoutineRun, error: string, ref: string | null) => {
    const ended = routines.finishRun(run.id, { status: 'failed', error, deliverableRef: ref })
    inbox.add(failedItem(r, deps.origin(r.workspaceId).folder, error))
    return ended
  }

  const drafted = (r: Routine, run: RoutineRun, d: Deliverable) => {
    const ref = dlv.refOf(d)
    const ended = routines.finishRun(run.id, { status: 'drafted', deliverableRef: ref })
    inbox.add({ key: `routine:${r.id}:draft:${run.id}`, kind: 'draft', text: `Draft to review: ${r.title}`, workspaceId: r.workspaceId, ref, labels: r.labels })
    inbox.resolve(failedKey(r.id))
    return ended
  }

  /** The draft has a version past the brief, saved by the drafter. */
  const written = (id: string): Deliverable | null => {
    try {
      const d = dlv.get(id)
      return d.versions.length > 1 ? d : null
    } catch {
      return null
    }
  }

  const drive = async (r: Routine, run: RoutineRun): Promise<RoutineRun> => {
    let ref: string | null = null
    try {
      const labels = deps.labelNames(r.labels)
      const pack = deps.pack(r.workspaceId, r.kind)
      const last = dlv.lastFinal(r.kind as DeliverableKind, labels, r.workspaceId)
      const lastRef = last ? dlv.refOf(last) : null
      const d = dlv.draft(r.kind as DeliverableKind, [r.title, r.brief].filter(Boolean).join('\n'), [...r.sources, ...(lastRef ? [lastRef] : [])], deps.origin(r.workspaceId), labels)
      ref = dlv.refOf(d)
      const drafter = deps.startDrafter(r, run, drafterPrompt(r, ref, labels, last && lastRef ? { ref: lastRef, title: last.title } : null, pack))
      routines.attachSession(run.id, drafter.sessionId)
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<'timeout'>((done) => (timer = setTimeout(() => done('timeout'), timeoutMs)))
      const end = await Promise.race([drafter.done, timedOut])
      clearTimeout(timer)
      if (end === 'timeout') {
        await deps.stop(drafter.sessionId).catch(() => {})
        return fail(r, run, `timed out after ${Math.round(timeoutMs / 60_000)} min`, ref)
      }
      const saved = written(d.id)
      if (saved) return drafted(r, run, saved)
      return fail(r, run, end.error ?? 'the drafter ended without saving the draft', ref)
    } catch (e) {
      return fail(r, run, (e as Error).message ?? String(e), ref)
    }
  }

  return {
    run(routineId, trigger) {
      const run = routines.startRun(routineId, trigger)
      return { run, done: drive(routines.get(routineId), run) }
    },
  }
}
