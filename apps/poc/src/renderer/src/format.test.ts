import { test } from 'node:test'
import assert from 'node:assert/strict'
import { threadTime } from './format.ts'

test('threadTime: now, minutes and hours today, yesterday, then a date', () => {
  const now = new Date(2026, 9, 28, 15, 0).getTime()
  assert.equal(threadTime(now - 20_000, now), 'now')
  assert.equal(threadTime(now - 5 * 60_000, now), '5m')
  assert.equal(threadTime(new Date(2026, 9, 28, 12, 30).getTime(), now), '2h')
  assert.equal(threadTime(new Date(2026, 9, 27, 23, 0).getTime(), now), 'yesterday')
  assert.equal(threadTime(new Date(2026, 9, 3, 9, 0).getTime(), now), new Date(2026, 9, 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
})
