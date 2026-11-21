import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LabelGroupView } from '@mag/core'
import { kindName, rowLabels, storedFilter } from './libraryView.ts'

test('kindName: a deliverable kind capitalized, change as a merged change', () => {
  assert.deepEqual([kindName('report'), kindName('decision'), kindName('change')], ['Report', 'Decision', 'Merged change'])
})

test('rowLabels: the workspace\'s labels of a row, Project first; unknown ids are left out', () => {
  const label = (id: string, groupId: string) => ({ id, groupId, name: id, color: '#000', rules: [] })
  const view: LabelGroupView[] = [
    { group: { id: 'p', workspaceId: 'w', name: 'Project', exclusive: true, system: 'project', createdAt: 0 }, labels: [label('p1', 'p')] },
    { group: { id: 'g', workspaceId: 'w', name: 'Team', exclusive: false, system: null, createdAt: 0 }, labels: [label('aura', 'g'), label('core', 'g')] },
  ]
  assert.deepEqual(rowLabels({ labelIds: ['core', 'gone', 'p1'] }, view).map((l) => l.id), ['p1', 'core'])
})

test('storedFilter: keeps what still exists; null project means none; junk is an empty filter', () => {
  assert.deepEqual(storedFilter(JSON.stringify({ kind: 'report', projectId: 'p1', labelId: 'aura', people: true }), ['p1'], ['aura']), { kind: 'report', projectId: 'p1', labelId: 'aura', people: true })
  assert.deepEqual(storedFilter(JSON.stringify({ kind: 'nope', projectId: 'gone', labelId: 'gone', people: 'yes' }), ['p1'], ['aura']), {})
  assert.deepEqual(storedFilter(JSON.stringify({ projectId: null }), [], []), { projectId: null })
  assert.deepEqual(storedFilter('{bad', [], []), {})
  assert.deepEqual(storedFilter(null, [], []), {})
})
