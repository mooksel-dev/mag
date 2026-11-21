import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoutines, RUNS_KEPT, TRIGGER_RULES, type FollowUp, type Routine, type RoutineRecords, type RoutineRun, type RoutineTrigger } from './index.ts'

/** Rows that outlive one service instance: a restart is a new createRoutines over the same rows. */
function memoryRecords(): RoutineRecords & { rows: { routines: Routine[]; runs: RoutineRun[]; followUps: FollowUp[] } } {
  const rows = { routines: [] as Routine[], runs: [] as RoutineRun[], followUps: [] as FollowUp[] }
  const put = <T extends { id: string }>(list: T[], x: T) => {
    const i = list.findIndex((y) => y.id === x.id)
    if (i >= 0) list[i] = structuredClone(x)
    else list.push(structuredClone(x))
  }
  return {
    rows,
    routines: () => rows.routines,
    putRoutine: (r) => put(rows.routines, r),
    removeRoutine: (id) => void (rows.routines = rows.routines.filter((r) => r.id !== id)),
    runs: () => rows.runs,
    putRun: (r) => put(rows.runs, r),
    removeRuns: (ids) => void (rows.runs = rows.runs.filter((r) => !ids.includes(r.id))),
    followUps: () => rows.followUps,
    putFollowUp: (f) => put(rows.followUps, f),
  }
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
// 2026-11-19 is a Thursday.
const THU_9 = at(2026, 11, 19, 9)
const NEXT_THU_9 = at(2026, 11, 26, 9)

function setup(start = at(2026, 11, 17, 12), records = memoryRecords()) {
  const clock = { t: start }
  const routines = createRoutines({ records, now: () => clock.t })
  return { clock, records, routines, restart: () => createRoutines({ records, now: () => clock.t }) }
}

const cron = (c: string): RoutineTrigger => ({ kind: 'schedule', cron: c })
const weekly = { workspaceId: 'w1', name: 'Weekly update', trigger: cron('0 9 * * thu'), prompt: 'Draft the weekly update.' }

test('save: a name, a trigger and a prompt; the cron is validated, nextAt computed; disabled has none', () => {
  const { routines } = setup()
  assert.throws(() => routines.save({ ...weekly, trigger: cron('0 9 * *') }), /Schedule: A schedule has 5 fields/)
  assert.throws(() => routines.save({ ...weekly, name: ' ' }), /needs a name/)
  assert.throws(() => routines.save({ ...weekly, prompt: ' ' }), /needs a prompt/)
  assert.throws(() => routines.save({ ...weekly, trigger: { kind: 'slack' } as unknown as RoutineTrigger }), /Unknown trigger: slack/)
  assert.throws(() => routines.save({ ...weekly, workspaceId: undefined }), /needs its workspace/)
  const r = routines.save({ ...weekly, trigger: cron(' 0  9 * * thu ') })
  assert.deepEqual([r.nextAt, r.trigger, r.projectId], [THU_9, cron('0 9 * * thu'), null])
  assert.equal(routines.save({ id: r.id, projectId: 'p1' }).projectId, 'p1')
  assert.equal(routines.save({ id: r.id, prompt: 'Other' }).projectId, 'p1')
  assert.equal(routines.save({ id: r.id, projectId: null }).projectId, null)
  assert.equal(routines.save({ id: r.id, enabled: false }).nextAt, null)
  assert.equal(routines.save({ id: r.id, enabled: true }).nextAt, THU_9)
  assert.equal(routines.save({ id: r.id, trigger: cron('30 8 * * fri') }).nextAt, at(2026, 11, 20, 8, 30))
  assert.deepEqual(routines.list('w1').map((x) => x.id), [r.id])
  assert.deepEqual(routines.list('w2'), [])
})

test('no routine ships by default: a new store has none', () => {
  const { routines } = setup()
  assert.deepEqual(routines.list('w1'), [])
  assert.deepEqual(routines.due(Number.MAX_SAFE_INTEGER), [])
})

test('a second trigger kind is a TriggerRule: due and runs work for it unchanged', () => {
  const records = memoryRecords()
  const clock = { t: at(2026, 11, 17, 12) }
  const hourly: typeof TRIGGER_RULES.schedule = { error: () => null, next: (_, t) => Math.floor(t / 3_600_000 + 1) * 3_600_000 }
  const routines = createRoutines({ records, triggers: { ...TRIGGER_RULES, hourly }, now: () => clock.t })
  const r = routines.save({ ...weekly, trigger: { kind: 'hourly' } as unknown as RoutineTrigger })
  clock.t = r.nextAt!
  assert.deepEqual(routines.due(clock.t).map((x) => x.id), [r.id])
  const run = routines.startRun(r.id, 'slot')
  assert.equal(routines.finishRun(run.id, { status: 'done', summary: 'ok', deliverableRef: null }).status, 'done')
  assert.equal(routines.get(r.id).nextAt, clock.t + 3_600_000)
})

test('rows of .1 read as a trigger and a prompt; a drafted run reads as done', () => {
  const records = memoryRecords()
  const old = { id: 'r1', workspaceId: 'w1', title: 'Ups', schedule: '0 9 * * thu', kind: 'report', brief: 'Per epic', sources: ['jira:PRVP'], destination: null, labels: [], enabled: true, nextAt: THU_9, createdAt: 1, updatedAt: 1 }
  records.rows.routines.push(old as unknown as Routine)
  records.rows.runs.push({ id: 'u1', routineId: 'r1', slot: null, startedAt: 1, endedAt: 2, status: 'drafted', sessionId: null, deliverableRef: 'a:dlv:b', error: null } as unknown as RoutineRun)
  const routines = createRoutines({ records, now: () => at(2026, 11, 17, 12) })
  const r = routines.get('r1')
  assert.deepEqual([r.name, r.trigger, r.prompt, r.projectId, r.nextAt], ['Ups', cron('0 9 * * thu'), 'Ups\nPer epic\n\nSources:\n- jira:PRVP', null, THU_9])
  assert.equal(routines.runs('r1')[0].status, 'done')
})

test('attachDraft and runOfSession: the draft of the running run of a session', () => {
  const { routines } = setup()
  const r = routines.save(weekly)
  const run = routines.attachSession(routines.startRun(r.id, 'now').id, 's1')
  assert.equal(routines.runOfSession('s1')?.id, run.id)
  routines.attachDraft(run.id, 'a:dlv:x')
  const done = routines.finishRun(run.id, { status: 'done', summary: 'Drafted', deliverableRef: null })
  assert.deepEqual([done.deliverableRef, done.summary], ['a:dlv:x', 'Drafted'])
  assert.equal(routines.runOfSession('s1'), null)
  assert.throws(() => routines.attachDraft(run.id, 'a:dlv:y'), /ended already/)
})

test('save: an edit that keeps the schedule keeps a slot that is due', () => {
  const { routines, clock } = setup()
  const r = routines.save(weekly)
  clock.t = THU_9 + 30_000
  routines.save({ id: r.id, name: 'Weekly' })
  assert.deepEqual(routines.due(clock.t).map((x) => x.id), [r.id])
})

test('due + startRun: a slot runs exactly once; the next slot is the next week', () => {
  const { routines, clock } = setup()
  const r = routines.save(weekly)
  assert.deepEqual(routines.due(clock.t), [])
  clock.t = THU_9
  assert.deepEqual(routines.due(clock.t).map((x) => x.id), [r.id])
  const run = routines.startRun(r.id, 'slot')
  assert.equal(run.slot, THU_9)
  assert.equal(routines.get(r.id).nextAt, NEXT_THU_9)
  // Running: not due, no second run of any kind.
  assert.deepEqual(routines.due(clock.t), [])
  assert.throws(() => routines.startRun(r.id, 'slot'), /running already/)
  assert.throws(() => routines.startRun(r.id, 'now'), /running already/)
  routines.finishRun(run.id, { status: 'done', summary: null, deliverableRef: 'acme:dlv:ups-downs' })
  clock.t = THU_9 + 60_000
  assert.deepEqual(routines.due(clock.t), [])
  assert.throws(() => routines.startRun(r.id, 'slot'), /not due/)
  clock.t = NEXT_THU_9
  assert.deepEqual(routines.due(clock.t).map((x) => x.id), [r.id])
})

test('slot lock: a run recorded for the slot blocks it, also after a restart', () => {
  const { records, clock, restart } = setup()
  const first = restart()
  const r = first.save(weekly)
  clock.t = THU_9
  const run = first.startRun(r.id, 'slot')
  // A crash before nextAt was written would leave the slot pending; the run row still locks it.
  records.putRoutine({ ...records.routines()[0], nextAt: THU_9 })
  const again = restart()
  assert.deepEqual(again.recover().map((x) => [x.id, x.status, x.error]), [[run.id, 'failed', 'mag was closed during the run']])
  assert.deepEqual(again.due(clock.t), [])
  assert.throws(() => again.startRun(r.id, 'slot'), /ran for this slot already/)
})

test('a slot missed while mag was closed runs once on start, not once per missed slot', () => {
  const { clock, restart } = setup()
  const r = restart().save(weekly)
  // Closed for three Thursdays.
  clock.t = at(2026, 12, 8, 10)
  const started = restart()
  assert.deepEqual(started.due(clock.t).map((x) => x.id), [r.id])
  started.startRun(r.id, 'slot')
  assert.equal(started.get(r.id).nextAt, at(2026, 12, 10, 9))
  assert.deepEqual(started.due(clock.t), [])
})

test('Run now: no slot, nextAt unchanged; finishRun ends a run once; runs newest first, the oldest dropped', () => {
  const { routines, clock } = setup()
  const r = routines.save(weekly)
  const run = routines.startRun(r.id, 'now')
  assert.equal(run.slot, null)
  assert.equal(routines.get(r.id).nextAt, THU_9)
  assert.equal(routines.attachSession(run.id, 's1').sessionId, 's1')
  clock.t += 5_000
  const failed = routines.finishRun(run.id, { status: 'failed', error: 'timed out' })
  assert.deepEqual([failed.status, failed.error, failed.endedAt! - failed.startedAt, failed.sessionId], ['failed', 'timed out', 5_000, 's1'])
  assert.throws(() => routines.finishRun(run.id, { status: 'done', summary: null, deliverableRef: 'x:dlv:y' }), /ended already/)
  for (let i = 0; i < RUNS_KEPT + 2; i++) {
    clock.t += 1_000
    routines.finishRun(routines.startRun(r.id, 'now').id, { status: 'done', summary: null, deliverableRef: `x:dlv:r${i}` })
  }
  const runs = routines.runs(r.id)
  assert.equal(runs.length, RUNS_KEPT)
  assert.equal(runs[0].deliverableRef, `x:dlv:r${RUNS_KEPT + 1}`)
})

test('remove: the routine and its runs go; not while it runs', () => {
  const { routines, records } = setup()
  const r = routines.save(weekly)
  const running = routines.startRun(r.id, 'now')
  assert.throws(() => routines.remove(r.id), /is running/)
  routines.finishRun(running.id, { status: 'done', summary: null, deliverableRef: 'x:dlv:y' })
  routines.finishRun(routines.startRun(r.id, 'now').id, { status: 'failed', error: 'x' })
  routines.remove(r.id)
  assert.deepEqual([records.rows.routines.length, records.rows.runs.length], [0, 0])
  assert.throws(() => routines.get(r.id), /No routine/)
})

test('choice: an optional agent, model and effort, checked; null is the defaults; an edit keeps it', () => {
  const { routines } = setup()
  const r = routines.save({ ...weekly, choice: { agent: 'claude-code', model: ' claude-sonnet-5-5 ', effort: 'low' } })
  assert.deepEqual(r.choice, { agent: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low' })
  assert.deepEqual(routines.save({ id: r.id, prompt: 'Other' }).choice, r.choice)
  assert.equal(routines.save({ id: r.id, choice: null }).choice, null)
  assert.equal(routines.save(weekly).choice, null)
  assert.throws(() => routines.save({ ...weekly, choice: { agent: 'gemini', model: null, effort: null } as never }), /choice.agent must be one of claude-code, codex/)
  assert.throws(() => routines.save({ ...weekly, choice: { agent: 'codex', model: null, effort: 'huge' } as never }), /effort must be one of/)
})

const ask = { workspaceId: 'w1', who: ' Ana ', what: 'Send  the numbers', dueAt: THU_9, sourceRef: 'https://slack.com/x' }

test('addFollowUp: who, what and due checked; open until due; the same source and who again adds nothing (routines-scheduled-drafts-and-a.3)', () => {
  const { routines } = setup()
  assert.throws(() => routines.addFollowUp({ ...ask, who: ' ' }), /who it is with/)
  assert.throws(() => routines.addFollowUp({ ...ask, what: '' }), /what to follow up on/)
  assert.throws(() => routines.addFollowUp({ ...ask, dueAt: NaN }), /due date/)
  assert.throws(() => routines.addFollowUp({ ...ask, workspaceId: '' }), /workspace/)
  const { followUp: f, added } = routines.addFollowUp(ask)
  assert.deepEqual([added, f.who, f.what, f.status, f.projectId, f.sourceRef], [true, 'Ana', 'Send the numbers', 'open', null, 'https://slack.com/x'])
  assert.deepEqual(routines.addFollowUp({ ...ask, who: 'ana', what: 'Other words' }), { followUp: f, added: false })
  assert.equal(routines.addFollowUp({ ...ask, who: 'Bo' }).added, true)
  assert.equal(routines.addFollowUp({ ...ask, workspaceId: 'w2' }).added, true)
  // Without a source nothing is the same.
  assert.equal(routines.addFollowUp({ ...ask, sourceRef: null }).added, true)
  assert.equal(routines.addFollowUp({ ...ask, sourceRef: null }).added, true)
  assert.equal(routines.followUps('w1').length, 4)
})

test('dueFollowUps: open ones due at now, soonest first; surfaced once; closed is done and frees its source (routines-scheduled-drafts-and-a.3)', () => {
  const { routines, restart, clock } = setup()
  const late = routines.addFollowUp({ ...ask, dueAt: NEXT_THU_9 }).followUp
  const soon = routines.addFollowUp({ ...ask, who: 'Bo', dueAt: THU_9 }).followUp
  assert.deepEqual(routines.dueFollowUps(THU_9 - 1), [])
  assert.deepEqual(routines.dueFollowUps(NEXT_THU_9).map((f) => f.id), [soon.id, late.id])
  assert.equal(routines.surfaceFollowUp(soon.id).status, 'surfaced')
  assert.deepEqual(restart().dueFollowUps(NEXT_THU_9).map((f) => f.id), [late.id])
  assert.throws(() => routines.surfaceFollowUp('nope'), /No follow-up nope/)
  clock.t = THU_9 + 60_000
  const closed = routines.closeFollowUp(soon.id)!
  assert.deepEqual([closed.status, closed.closedAt], ['done', THU_9 + 60_000])
  clock.t += 60_000
  assert.equal(routines.closeFollowUp(soon.id)!.closedAt, THU_9 + 60_000)
  assert.equal(routines.closeFollowUp('nope'), null)
  assert.equal(routines.surfaceFollowUp(soon.id).status, 'done')
  assert.deepEqual(routines.followUps('w1').map((f) => f.id), [late.id])
  assert.equal(routines.addFollowUp({ ...ask, who: 'Bo' }).added, true)
})
