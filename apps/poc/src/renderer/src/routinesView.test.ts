import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronOfPick, pickOfCron, routineNext, runDuration, runsOf, scheduleHint, slotText } from './routinesView.ts'

const NOW = new Date(2026, 10, 17, 12).getTime()

test('scheduleHint: the next 3 runs of a valid schedule, else what is wrong', () => {
  assert.deepEqual(scheduleHint('0 9 * * thu', NOW), { ok: true, text: 'Next: Thu 19 Nov 09:00, Thu 26 Nov 09:00, Thu 3 Dec 09:00' })
  assert.deepEqual(scheduleHint('30 8 * * 1-5', NOW), { ok: true, text: 'Next: Wed 18 Nov 08:30, Thu 19 Nov 08:30, Fri 20 Nov 08:30' })
  assert.equal(scheduleHint('0 9 * *', NOW).ok, false)
  assert.match(scheduleHint('0 9 * *', NOW).text, /5 fields/)
  assert.deepEqual(scheduleHint('0 0 31 2 *', NOW), { ok: false, text: 'This schedule never fires' })
})

test('routineNext, slotText: off, never, or the next slot; the year only when it differs', () => {
  assert.equal(routineNext({ enabled: false, nextAt: 5 }, NOW), 'Off')
  assert.equal(routineNext({ enabled: true, nextAt: null }, NOW), 'Never fires')
  assert.equal(slotText(new Date(2027, 0, 7, 8, 5).getTime(), NOW), 'Thu 7 Jan 2027 08:05')
})

test('schedule picker: daily, weekdays, weekly at a time or custom cron, both ways', () => {
  const base = { time: '10:05', day: 4, cron: '' }
  assert.equal(cronOfPick({ ...base, mode: 'daily' }), '5 10 * * *')
  assert.equal(cronOfPick({ ...base, mode: 'weekdays' }), '5 10 * * 1-5')
  assert.equal(cronOfPick({ ...base, mode: 'weekly' }), '5 10 * * 4')
  assert.equal(cronOfPick({ ...base, mode: 'custom', cron: ' */30 9-17 * * 1-5 ' }), '*/30 9-17 * * 1-5')
  for (const mode of ['daily', 'weekdays', 'weekly'] as const) {
    const back = pickOfCron(cronOfPick({ ...base, mode }))
    assert.deepEqual([back.mode, back.time, cronOfPick(back)], [mode, '10:05', cronOfPick({ ...base, mode })])
  }
  assert.equal(pickOfCron('0 9 * * thu').mode, 'custom')
  assert.equal(pickOfCron('0 25 * * *').mode, 'custom')
})

test('runDuration, runsOf', () => {
  assert.equal(runDuration({ startedAt: 0, endedAt: 42_000 }), '42 s')
  assert.equal(runDuration({ startedAt: 0, endedAt: 65 * 60_000 }), '1 h 5 min')
  assert.equal(runDuration({ startedAt: NOW - 180_000, endedAt: null }, NOW), '3 min')
  const run = (id: string, routineId: string, startedAt: number) => ({ id, routineId, startedAt, slot: null, endedAt: null, status: 'done' as const, sessionId: null, deliverableRef: null, error: null })
  assert.deepEqual(runsOf([run('a', 'r1', 1), run('b', 'r2', 2), run('c', 'r1', 3)], 'r1').map((r) => r.id), ['c', 'a'])
})
