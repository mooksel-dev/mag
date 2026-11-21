// Routines (routines-scheduled-drafts-and-a.1, .2): a trigger and a prompt, run headless. The service owns routines and
// their runs: when one is due, and that a slot runs once (a run per slot is its lock), across restarts too. What a
// trigger kind means is its TriggerRule; what a run does is composed in the app layer. It also keeps follow-ups (.3):
// who, what and when, due once.
import { randomUUID } from 'node:crypto'
import { EFFORTS, type ModelChoice } from '@mag/core'
import { cronError, nextSlot } from '../../lib/cron/index.ts'
import type { FollowUp, FollowUpInput, Routine, RoutineInput, RoutineRecords, RoutineRun, RoutineTrigger, RunResult } from './types.ts'

export type * from './types.ts'

export interface Routines {
  /** A workspace's routines, by name. */
  list(workspaceId: string): Routine[]
  get(id: string): Routine
  /** Creates or edits a routine: the trigger is validated and nextAt computed; throws with what is wrong. */
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
  /** The draft a running run saved (its last one wins). */
  attachDraft(runId: string, deliverableRef: string): RoutineRun
  /** The running run of a session, if any. */
  runOfSession(sessionId: string): RoutineRun | null
  /** Ends a running run with its summary or its error. */
  finishRun(runId: string, result: RunResult): RoutineRun
  /** A routine's runs, newest first. */
  runs(routineId: string): RoutineRun[]
  /** At start: runs left running by a mag that closed end as failed; returns them. */
  recover(): RoutineRun[]
  /**
   * Adds a follow-up; throws with what is wrong. One not done of the same workspace, source and who is returned as it
   * is (`added: false`), so a routine that finds the same ask again adds nothing.
   */
  addFollowUp(input: FollowUpInput): { followUp: FollowUp; added: boolean }
  /** A workspace's follow-ups not done yet, soonest first. */
  followUps(workspaceId: string): FollowUp[]
  /** Open follow-ups due at `now`, soonest first: the ones to put in the Inbox. */
  dueFollowUps(now: number): FollowUp[]
  /** It is in the Inbox now: not due again. */
  surfaceFollowUp(id: string): FollowUp
  /** Closes it (Done); null when there is no such follow-up. Closing a closed one keeps it as it was. */
  closeFollowUp(id: string): FollowUp | null
}

/** What a trigger kind means: what is wrong with one (null: fine) and when it fires next after `t`. */
export interface TriggerRule {
  error(trigger: { kind: string }): string | null
  next(trigger: { kind: string }, t: number): number | null
}

export const TRIGGER_RULES: Record<RoutineTrigger['kind'], TriggerRule> = {
  schedule: {
    error: (t) => {
      const cron = (t as RoutineTrigger).cron
      return typeof cron === 'string' ? cronError(cron) : 'A schedule needs its cron'
    },
    next: (t, after) => nextSlot((t as RoutineTrigger).cron, after),
  },
}

/** Runs kept per routine. */
export const RUNS_KEPT = 30

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A row as .1 stored it (title, schedule, brief, sources), read as a trigger and a prompt. */
function readRoutine(raw: Routine): Routine {
  const old = raw as Routine & { title?: string; schedule?: string; brief?: string; sources?: string[] }
  if (old.trigger && typeof old.prompt === 'string' && old.name !== undefined) return raw.choice === undefined ? { ...raw, choice: null } : raw
  const sources = old.sources?.length ? `\n\nSources:\n${old.sources.map((s) => `- ${s}`).join('\n')}` : ''
  return {
    id: old.id,
    workspaceId: old.workspaceId,
    name: old.name ?? old.title ?? 'Routine',
    trigger: old.trigger ?? { kind: 'schedule', cron: old.schedule ?? '' },
    prompt: old.prompt ?? `${[old.title, old.brief].filter(Boolean).join('\n')}${sources}`,
    projectId: old.projectId ?? null,
    choice: old.choice ?? null,
    enabled: old.enabled,
    nextAt: old.nextAt,
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
  }
}

const AGENTS = ['claude-code', 'codex']

/** A model choice as given, checked; null: the defaults. */
function choiceOf(c: ModelChoice | null): ModelChoice | null {
  if (c === null) return null
  if (!c || typeof c !== 'object' || !AGENTS.includes(c.agent)) throw new Error(`choice.agent must be one of ${AGENTS.join(', ')}`)
  const model = typeof c.model === 'string' && c.model.trim() ? c.model.trim() : null
  if (c.effort != null && !EFFORTS.includes(c.effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`)
  return { agent: c.agent, model, effort: c.effort ?? null }
}

const readRun = (r: RoutineRun): RoutineRun => ((r.status as string) === 'drafted' ? { ...r, status: 'done' } : r)

/** `triggers`: the trigger kinds and their rules (default TRIGGER_RULES). */
export function createRoutines(deps: { records: RoutineRecords; triggers?: Record<string, TriggerRule>; now?: () => number }): Routines {
  const { records } = deps
  const triggers = deps.triggers ?? TRIGGER_RULES
  const now = deps.now ?? Date.now
  const id = () => randomUUID().slice(0, 8)
  const all = () => records.routines().map(readRoutine)
  const allRuns = () => records.runs().map(readRun)
  const runsOf = (routineId: string) => allRuns().filter((r) => r.routineId === routineId)
  const running = (routineId: string) => runsOf(routineId).some((r) => r.status === 'running')
  const runById = (runId: string) => {
    const r = allRuns().find((x) => x.id === runId)
    if (!r) throw new Error(`No routine run ${runId}`)
    return r
  }
  const ruleOf = (t: RoutineTrigger) => {
    const rule = triggers[t.kind]
    if (!rule) throw new Error(`Unknown trigger: ${t.kind}`)
    return rule
  }
  const nextOf = (r: Pick<Routine, 'trigger' | 'enabled'>, t: number) => (r.enabled ? ruleOf(r.trigger).next(r.trigger, t) : null)
  const sameTrigger = (a: RoutineTrigger, b: RoutineTrigger) => JSON.stringify(a) === JSON.stringify(b)

  const self: Routines = {
    list: (workspaceId) => all().filter((r) => r.workspaceId === workspaceId).sort((a, b) => a.name.localeCompare(b.name)),
    get(rid) {
      const r = all().find((x) => x.id === rid)
      if (!r) throw new Error(`No routine ${rid}`)
      return r
    },
    save(input) {
      const old = input.id ? self.get(input.id) : null
      const name = oneLine(input.name ?? old?.name ?? '')
      if (!name) throw new Error('A routine needs a name')
      const prompt = (input.prompt ?? old?.prompt ?? '').trim()
      if (!prompt) throw new Error('A routine needs a prompt: what it does when it runs')
      const given = input.trigger ?? old?.trigger
      if (!given || typeof given !== 'object') throw new Error('A routine needs a trigger')
      const trigger: RoutineTrigger = given.kind === 'schedule' ? { kind: 'schedule', cron: oneLine(String(given.cron ?? '')) } : given
      const bad = ruleOf(trigger).error(trigger)
      if (bad) throw new Error(`${trigger.kind === 'schedule' ? 'Schedule' : 'Trigger'}: ${bad}`)
      const workspaceId = old?.workspaceId ?? input.workspaceId
      if (!workspaceId) throw new Error('A new routine needs its workspace')
      if (old && input.workspaceId && input.workspaceId !== old.workspaceId) throw new Error('A routine stays in its workspace')
      const t = now()
      const r: Routine = {
        id: old?.id ?? id(),
        workspaceId,
        name,
        trigger,
        prompt,
        projectId: input.projectId !== undefined ? input.projectId || null : (old?.projectId ?? null),
        choice: input.choice !== undefined ? choiceOf(input.choice) : (old?.choice ?? null),
        enabled: input.enabled ?? old?.enabled ?? true,
        nextAt: null,
        createdAt: old?.createdAt ?? t,
        updatedAt: t,
      }
      // The same trigger keeps its pending slot: an edit must not skip a run that is due.
      const same = old && old.enabled && r.enabled && sameTrigger(old.trigger, r.trigger) && old.nextAt !== null
      r.nextAt = same ? old.nextAt : nextOf(r, t)
      records.putRoutine(r)
      return r
    },
    remove(rid) {
      const r = self.get(rid)
      if (running(rid)) throw new Error(`${r.name} is running: stop its run first`)
      records.removeRuns(runsOf(rid).map((x) => x.id))
      records.removeRoutine(rid)
    },
    due(t) {
      return all().filter((r) => r.enabled && r.nextAt !== null && r.nextAt <= t && !running(r.id) && !runsOf(r.id).some((x) => x.slot === r.nextAt))
    },
    startRun(rid, trigger) {
      const r = self.get(rid)
      if (running(rid)) throw new Error(`${r.name} is running already`)
      const t = now()
      let slot: number | null = null
      if (trigger === 'slot') {
        slot = r.nextAt
        if (!r.enabled || slot === null || slot > t) throw new Error(`${r.name} is not due`)
        const ran = slot
        if (runsOf(rid).some((x) => x.slot === ran)) throw new Error(`${r.name} ran for this slot already`)
        records.putRoutine({ ...r, nextAt: nextOf(r, t), updatedAt: t })
      }
      const run: RoutineRun = { id: id(), routineId: rid, slot, startedAt: t, endedAt: null, status: 'running', sessionId: null, deliverableRef: null, summary: null, error: null }
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
    attachDraft(runId, deliverableRef) {
      const run = runById(runId)
      if (run.status !== 'running') throw new Error(`Run ${runId} has ended already (${run.status})`)
      const next = { ...run, deliverableRef }
      records.putRun(next)
      return next
    },
    runOfSession: (sessionId) => allRuns().find((r) => r.sessionId === sessionId && r.status === 'running') ?? null,
    finishRun(runId, result) {
      const run = runById(runId)
      if (run.status !== 'running') throw new Error(`Run ${runId} has ended already (${run.status})`)
      const done: RoutineRun =
        result.status === 'done'
          ? { ...run, status: 'done', endedAt: now(), deliverableRef: result.deliverableRef ?? run.deliverableRef, summary: result.summary, error: null }
          : { ...run, status: 'failed', endedAt: now(), deliverableRef: result.deliverableRef ?? run.deliverableRef, error: result.error }
      records.putRun(done)
      return done
    },
    runs: (rid) => runsOf(rid).sort((a, b) => b.startedAt - a.startedAt),
    recover() {
      const left = allRuns().filter((r) => r.status === 'running')
      return left.map((r) => self.finishRun(r.id, { status: 'failed', error: 'mag was closed during the run' }))
    },
    addFollowUp(input) {
      const who = oneLine(input.who ?? '')
      if (!who) throw new Error('A follow-up needs who it is with')
      const what = oneLine(input.what ?? '')
      if (!what) throw new Error('A follow-up needs what to follow up on')
      if (typeof input.dueAt !== 'number' || !Number.isFinite(input.dueAt)) throw new Error('A follow-up needs its due date')
      if (!input.workspaceId) throw new Error('A follow-up needs its workspace')
      const sourceRef = input.sourceRef?.trim() || null
      const same = sourceRef && records.followUps().find((f) => f.status !== 'done' && f.workspaceId === input.workspaceId && f.sourceRef === sourceRef && f.who.toLowerCase() === who.toLowerCase())
      if (same) return { followUp: same, added: false }
      const f: FollowUp = { id: id(), workspaceId: input.workspaceId, projectId: input.projectId || null, who, what, dueAt: input.dueAt, sourceRef, status: 'open', createdAt: now(), closedAt: null }
      records.putFollowUp(f)
      return { followUp: f, added: true }
    },
    followUps: (workspaceId) => records.followUps().filter((f) => f.workspaceId === workspaceId && f.status !== 'done').sort((a, b) => a.dueAt - b.dueAt),
    dueFollowUps: (t) => records.followUps().filter((f) => f.status === 'open' && f.dueAt <= t).sort((a, b) => a.dueAt - b.dueAt),
    surfaceFollowUp(fid) {
      const f = records.followUps().find((x) => x.id === fid)
      if (!f) throw new Error(`No follow-up ${fid}`)
      if (f.status !== 'open') return f
      const next: FollowUp = { ...f, status: 'surfaced' }
      records.putFollowUp(next)
      return next
    },
    closeFollowUp(fid) {
      const f = records.followUps().find((x) => x.id === fid)
      if (!f) return null
      if (f.status === 'done') return f
      const next: FollowUp = { ...f, status: 'done', closedAt: now() }
      records.putFollowUp(next)
      return next
    },
  }
  return self
}
