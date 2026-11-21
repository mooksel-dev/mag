// Routines (routines-scheduled-drafts-and-a.1): a schedule, a deliverable kind (its pack), sources, labels and a
// destination, run headless into a draft. The service owns routines and their runs: when one is due, and that a slot
// runs once (a run per slot is its lock), across restarts too. What a run does is composed in the app layer.
import { randomUUID } from 'node:crypto'
import { cronError, nextSlot } from '../../lib/cron/index.ts'
import type { Routine, RoutineInput, RoutineRecords, RoutineRun, RunResult } from './types.ts'

export type * from './types.ts'

export interface Routines {
  /** A workspace's routines, by title. */
  list(workspaceId: string): Routine[]
  get(id: string): Routine
  /** Creates or edits a routine: the schedule is validated and nextAt computed; throws with what is wrong. */
  save(input: RoutineInput): Routine
  /** Removes a routine with its runs; not while it runs. */
  remove(id: string): void
  /** Routines whose slot is due at `now`: enabled, nextAt <= now, not running, no run for that slot yet. */
  due(now: number): Routine[]
  /**
   * Starts a run: of its due slot (`slot`, the lock; nextAt moves to the first slot after now, so slots missed while
   * mag was closed run once), or Run now. Throws while one runs, or when the slot is not due or already ran.
   */
  startRun(id: string, trigger: 'slot' | 'now'): RoutineRun
  /** The run's headless session, once started. */
  attachSession(runId: string, sessionId: string): RoutineRun
  /** Ends a running run with its draft or its error. */
  finishRun(runId: string, result: RunResult): RoutineRun
  /** A routine's runs, newest first. */
  runs(routineId: string): RoutineRun[]
  /** At start: runs left running by a mag that closed end as failed; returns them. */
  recover(): RoutineRun[]
}

/** Runs kept per routine. */
export const RUNS_KEPT = 30

const clean = (list: string[] | undefined) => [...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))]

/** `kinds`: the deliverable kinds a routine may draft. */
export function createRoutines(deps: { records: RoutineRecords; kinds: readonly string[]; now?: () => number }): Routines {
  const { records, kinds } = deps
  const now = deps.now ?? Date.now
  const id = () => randomUUID().slice(0, 8)
  const runsOf = (routineId: string) => records.runs().filter((r) => r.routineId === routineId)
  const running = (routineId: string) => runsOf(routineId).some((r) => r.status === 'running')
  const runById = (runId: string) => {
    const r = records.runs().find((x) => x.id === runId)
    if (!r) throw new Error(`No routine run ${runId}`)
    return r
  }
  const slotAfter = (r: Pick<Routine, 'schedule' | 'enabled'>, t: number) => (r.enabled ? nextSlot(r.schedule, t) : null)

  const self: Routines = {
    list: (workspaceId) => records.routines().filter((r) => r.workspaceId === workspaceId).sort((a, b) => a.title.localeCompare(b.title)),
    get(rid) {
      const r = records.routines().find((x) => x.id === rid)
      if (!r) throw new Error(`No routine ${rid}`)
      return r
    },
    save(input) {
      const old = input.id ? self.get(input.id) : null
      const title = (input.title ?? old?.title ?? '').replace(/\s+/g, ' ').trim()
      if (!title) throw new Error('A routine needs a title')
      const schedule = (input.schedule ?? old?.schedule ?? '').trim().replace(/\s+/g, ' ')
      const bad = cronError(schedule)
      if (bad) throw new Error(`Schedule: ${bad}`)
      const kind = input.kind ?? old?.kind ?? ''
      if (!kinds.includes(kind)) throw new Error(`kind must be one of ${kinds.join(', ')}`)
      const workspaceId = old?.workspaceId ?? input.workspaceId
      if (!workspaceId) throw new Error('A new routine needs its workspace')
      if (old && input.workspaceId && input.workspaceId !== old.workspaceId) throw new Error('A routine stays in its workspace')
      const t = now()
      const r: Routine = {
        id: old?.id ?? id(),
        workspaceId,
        title,
        schedule,
        kind,
        brief: (input.brief ?? old?.brief ?? '').trim(),
        sources: input.sources ? clean(input.sources) : (old?.sources ?? []),
        destination: input.destination !== undefined ? input.destination : (old?.destination ?? null),
        labels: input.labels ? clean(input.labels) : (old?.labels ?? []),
        enabled: input.enabled ?? old?.enabled ?? true,
        nextAt: null,
        createdAt: old?.createdAt ?? t,
        updatedAt: t,
      }
      // The same schedule keeps its pending slot: an edit must not skip a run that is due.
      const same = old && old.enabled && r.enabled && old.schedule === r.schedule && old.nextAt !== null
      r.nextAt = same ? old.nextAt : slotAfter(r, t)
      records.putRoutine(r)
      return r
    },
    remove(rid) {
      const r = self.get(rid)
      if (running(rid)) throw new Error(`${r.title} is running: stop its run first`)
      records.removeRuns(runsOf(rid).map((r) => r.id))
      records.removeRoutine(rid)
    },
    due(t) {
      return records.routines().filter((r) => r.enabled && r.nextAt !== null && r.nextAt <= t && !running(r.id) && !runsOf(r.id).some((x) => x.slot === r.nextAt))
    },
    startRun(rid, trigger) {
      const r = self.get(rid)
      if (running(rid)) throw new Error(`${r.title} is running already`)
      const t = now()
      let slot: number | null = null
      if (trigger === 'slot') {
        slot = r.nextAt
        if (!r.enabled || slot === null || slot > t) throw new Error(`${r.title} is not due`)
        const ran = slot
        if (runsOf(rid).some((x) => x.slot === ran)) throw new Error(`${r.title} ran for this slot already`)
        records.putRoutine({ ...r, nextAt: slotAfter(r, t), updatedAt: t })
      }
      const run: RoutineRun = { id: id(), routineId: rid, slot, startedAt: t, endedAt: null, status: 'running', sessionId: null, deliverableRef: null, error: null }
      records.putRun(run)
      const old = runsOf(rid).sort((a, b) => b.startedAt - a.startedAt).slice(RUNS_KEPT)
      if (old.length) records.removeRuns(old.map((x) => x.id))
      return run
    },
    attachSession(runId, sessionId) {
      const run = { ...runById(runId), sessionId }
      records.putRun(run)
      return run
    },
    finishRun(runId, result) {
      const run = runById(runId)
      if (run.status !== 'running') throw new Error(`Run ${runId} has ended already (${run.status})`)
      const done: RoutineRun =
        result.status === 'drafted'
          ? { ...run, status: 'drafted', endedAt: now(), deliverableRef: result.deliverableRef, error: null }
          : { ...run, status: 'failed', endedAt: now(), deliverableRef: result.deliverableRef ?? run.deliverableRef, error: result.error }
      records.putRun(done)
      return done
    },
    runs: (rid) => runsOf(rid).sort((a, b) => b.startedAt - a.startedAt),
    recover() {
      const left = records.runs().filter((r) => r.status === 'running')
      return left.map((r) => self.finishRun(r.id, { status: 'failed', error: 'mag was closed during the run' }))
    },
  }
  return self
}
