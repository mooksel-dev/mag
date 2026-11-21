import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronError, nextSlot, parseCron } from './index.ts'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

test('nextSlot: Thursday 9:00 local, strictly after the given time', () => {
  // 2026-11-19 is a Thursday.
  assert.equal(nextSlot('0 9 * * thu', at(2026, 11, 17, 12)), at(2026, 11, 19, 9))
  assert.equal(nextSlot('0 9 * * 4', at(2026, 11, 19, 9)), at(2026, 11, 26, 9))
  assert.equal(nextSlot('0 9 * * 4', at(2026, 11, 19, 8, 59) + 30_000), at(2026, 11, 19, 9))
})

test('nextSlot: steps, ranges and lists; working hours every 30 minutes', () => {
  const expr = '*/30 9-17 * * mon-fri'
  // Saturday 2026-11-21 → Monday 9:00.
  assert.equal(nextSlot(expr, at(2026, 11, 21, 10)), at(2026, 11, 23, 9))
  assert.equal(nextSlot(expr, at(2026, 11, 23, 9)), at(2026, 11, 23, 9, 30))
  assert.equal(nextSlot(expr, at(2026, 11, 23, 17, 30)), at(2026, 11, 24, 9))
  assert.equal(nextSlot('15,45 * * * *', at(2026, 1, 1, 0, 20)), at(2026, 1, 1, 0, 45))
})

test('nextSlot: month and year rollover; day of month or weekday when both are given', () => {
  assert.equal(nextSlot('0 0 1 * *', at(2026, 12, 15)), at(2027, 1, 1))
  assert.equal(nextSlot('0 0 29 2 *', at(2026, 3, 1)), at(2028, 2, 29))
  // The 13th or any Friday: 2026-11-27 is a Friday, before Dec 13.
  assert.equal(nextSlot('0 0 13 * fri', at(2026, 11, 21)), at(2026, 11, 27))
  assert.equal(nextSlot('0 0 * * 7', at(2026, 11, 21)), at(2026, 11, 22))
})

test('nextSlot: a schedule that never fires gives null', () => {
  assert.equal(nextSlot('0 0 31 2 *', at(2026, 1, 1)), null)
})

test('parseCron / cronError: what is wrong, in words', () => {
  assert.equal(cronError('0 9 * * thu'), null)
  assert.match(cronError('0 9 * *')!, /5 fields/)
  assert.match(cronError('60 9 * * *')!, /minute: 60 is outside 0-59/)
  assert.match(cronError('0 9 * * fun')!, /day of week: "fun" is not a number/)
  assert.match(cronError('*/0 * * * *')!, /step/)
  assert.match(cronError('0 17-9 * * *')!, /backwards/)
  assert.deepEqual([...parseCron('5/20 * * * *').minutes], [5, 25, 45])
})
