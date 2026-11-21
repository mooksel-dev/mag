import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoutines, RUNS_KEPT, type Routine, type RoutineRecords, type RoutineRun } from './index.ts'

/** Rows that outlive one service instance: a restart is a new createRoutines over the same rows. */
function memoryRecords(): RoutineRecords & { rows: { routines: Routine[]; runs: RoutineRun[] } } {
  const rows = { routines: [] as Routine[], runs: [] as RoutineRun[] }
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
  }
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
// 2026-11-19 is a Thursday.
const THU_9 = at(2026, 11, 19, 9)
const NEXT_THU_9 = at(2026, 11, 26, 9)

function setup(start = at(2026, 11, 17, 12), records = memoryRecords()) {
  const clock = { t: start }
  const routines = createRoutines({ records, kinds: ['report', 'reply'], now: () => clock.t })
  return { clock, records, routines, restart: () => createRoutines({ records, kinds: ['report', 'reply'], now: () => clock.t }) }
}

const weekly = { workspaceId: 'w1', title: 'Ups & Downs', schedule: '0 9 * * thu', kind: 'report' }

test('save: validates the schedule and kind, computes nextAt; disabled has none', () => {
  const { routines } = setup()
  assert.throws(() => routines.save({ ...weekly, schedule: '0 9 * *' }), /Schedule: A schedule has 5 fields/)
  assert.throws(() => routines.save({ ...weekly, kind: 'poem' }), /kind must be one of report, reply/)
  assert.throws(() => routines.save({ ...weekly, title: ' ' }), /needs a title/)
  assert.throws(() => routines.save({ ...weekly, workspaceId: undefined }), /needs its workspace/)
  const r = routines.save({ ...weekly, sources: [' jira:PRVP ', 'jira:PRVP', ''], labels: ['l1'] })
  assert.equal(r.nextAt, THU_9)
  assert.deepEqual(r.sources, ['jira:PRVP'])
  assert.equal(routines.save({ id: r.id, enabled: false }).nextAt, null)
  assert.equal(routines.save({ id: r.id, enabled: true }).nextAt, THU_9)
  assert.equal(routines.save({ id: r.id, schedule: '30 8 * * fri' }).nextAt, at(2026, 11, 20, 8, 30))
  assert.deepEqual(routines.list('w1').map((x) => x.id), [r.id])
  assert.deepEqual(routines.list('w2'), [])
})

test('save: an edit that keeps the schedule keeps a slot that is due', () => {
  const { routines, clock } = setup()
  const r = routines.save(weekly)
  clock.t = THU_9 + 30_000
  routines.save({ id: r.id, title: 'Ups and Downs' })
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
  routines.finishRun(run.id, { status: 'drafted', deliverableRef: 'acme:dlv:ups-downs' })
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
  assert.throws(() => routines.finishRun(run.id, { status: 'drafted', deliverableRef: 'x:dlv:y' }), /ended already/)
  for (let i = 0; i < RUNS_KEPT + 2; i++) {
    clock.t += 1_000
    routines.finishRun(routines.startRun(r.id, 'now').id, { status: 'drafted', deliverableRef: `x:dlv:r${i}` })
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
  routines.finishRun(running.id, { status: 'drafted', deliverableRef: 'x:dlv:y' })
  routines.finishRun(routines.startRun(r.id, 'now').id, { status: 'failed', error: 'x' })
  routines.remove(r.id)
  assert.deepEqual([records.rows.routines.length, records.rows.runs.length], [0, 0])
  assert.throws(() => routines.get(r.id), /No routine/)
})
