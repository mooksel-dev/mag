import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueAtOf, followUpKey, followUpOfKey } from './refs.ts'

test('dueAtOf: a day at 9:00 local, a local time, an ISO time with its zone; anything else throws', () => {
  assert.equal(dueAtOf('2026-11-24'), new Date(2026, 10, 24, 9).getTime())
  assert.equal(dueAtOf(' 2026-11-24 14:30 '), new Date(2026, 10, 24, 14, 30).getTime())
  assert.equal(dueAtOf('2026-11-24T14:30'), new Date(2026, 10, 24, 14, 30).getTime())
  assert.equal(dueAtOf('2026-11-24T14:30:00Z'), Date.UTC(2026, 10, 24, 14, 30))
  for (const bad of ['2026-02-30', '2026-11-24 24:00', '2026-11-24 10:60', 'tomorrow', '24.11.2026', '', 'Nov 24 2026']) assert.throws(() => dueAtOf(bad), /Not a date/, bad)
})

test('followUpKey: a follow-up\'s inbox key and back; other keys are not one', () => {
  assert.equal(followUpOfKey(followUpKey('ab-12')), 'ab-12')
  assert.equal(followUpOfKey('routine:x:failed'), null)
  assert.equal(followUpOfKey('agent:follow_up:x'), null)
})
