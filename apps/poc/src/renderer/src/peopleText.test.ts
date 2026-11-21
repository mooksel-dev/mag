import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterPeople, handleLabels, syncReportText } from './peopleText.ts'

test('syncReportText: counts, then the failed directories', () => {
  assert.equal(syncReportText({ workspaceId: 'w', at: 1, matched: 3, new: 2, unmatched: 1, errors: [] }), '3 matched · 2 new · 1 unmatched')
  assert.equal(syncReportText({ workspaceId: 'w', at: 1, matched: 0, new: 0, unmatched: 0, errors: ['Slack: auth'] }), '0 matched · 0 new · 0 unmatched; Slack: auth')
})

test('handleLabels and filterPeople', () => {
  const p = { name: 'Ievgen Bezpaly', email: null, title: 'Engineer', handles: [{ system: 'github' as const, handle: 'bezpaluy89', source: 'override' as const }, { system: 'slack' as const, handle: 'U1', source: 'directory' as const }, { system: 'atlassian' as const, handle: '712020:a', name: 'Ievgen B', source: 'email' as const }] }
  assert.deepEqual(handleLabels(p), ['slack:U1', 'atlassian:Ievgen B', 'github:bezpaluy89'])
  assert.deepEqual(filterPeople([p], 'BEZPALUY'), [p])
  assert.deepEqual(filterPeople([p], 'engin'), [p])
  assert.deepEqual(filterPeople([p], 'olena'), [])
  assert.deepEqual(filterPeople([p], ' '), [p])
})
