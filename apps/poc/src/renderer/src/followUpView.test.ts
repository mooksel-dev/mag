import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionItems, defaultDue } from './followUpView.ts'

test('actionItems: who and what under "## Action items" only; "None." and lines without a who are left out', () => {
  const summary = `## Decisions\n- **Ana**: not an action\n\n## Action items\n- **Ana**: send the numbers (by Monday)\n* **Bo:** review the plan\n- no who here\n- None.\n\n## Open questions\n- None.`
  assert.deepEqual(actionItems(summary), [{ who: 'Ana', what: 'send the numbers (by Monday)' }, { who: 'Bo', what: 'review the plan' }])
  assert.deepEqual(actionItems('## Action items\n- None.\n'), [])
  assert.deepEqual(actionItems('no sections'), [])
})

test('defaultDue: tomorrow, local, across a month end', () => {
  assert.equal(defaultDue(new Date(2026, 10, 30, 23, 30).getTime()), '2026-12-01')
})
