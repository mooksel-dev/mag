import { test } from 'node:test'
import assert from 'node:assert/strict'
import { itemLabelIds, projectGroupId, workspaceLabels, type LabelGroup, type Project } from './index.ts'

const project = (id: string, workspaceId: string): Project => ({ id, name: id.toUpperCase(), workspaceId, repos: [], notes: '', enforceArchitecture: false, architecture: null, archRun: null, agents: {}, integrations: {}, createdAt: 0, color: '#123456' })
const group = (id: string, workspaceId: string, system: LabelGroup['system'] = null): LabelGroup => ({ id, workspaceId, name: id, exclusive: !!system, system, createdAt: 0 })

test('workspaceLabels: Project first, its labels the workspace’s projects with their stored rules', () => {
  const view = workspaceLabels('a', {
    labelGroups: [group('area', 'a'), group(projectGroupId('a'), 'a', 'project'), group('other', 'b')],
    labels: [{ id: 'p1', groupId: projectGroupId('a'), name: 'old', color: '#000000', rules: [{ kind: 'repo', value: 'x' }] }, { id: 'ui', groupId: 'area', name: 'UI', color: '#111111', rules: [] }],
    projects: [project('p1', 'a'), project('p2', 'b')],
  })
  assert.deepEqual(view.map((v) => [v.group.id, v.labels.map((l) => `${l.name}:${l.color}:${l.rules.length}`)]), [[projectGroupId('a'), ['P1:#123456:1']], ['area', ['UI:#111111:0']]])
})

test('itemLabelIds: the project first, then the item’s own labels', () => {
  const rows = [{ id: 'topic:t|ui', itemRef: 'topic:t' as const, labelId: 'ui', by: 'user' as const }, { id: 'topic:u|x', itemRef: 'topic:u' as const, labelId: 'x', by: 'rule' as const }]
  assert.deepEqual(itemLabelIds('topic:t', 'p', rows), ['p', 'ui'])
  assert.deepEqual(itemLabelIds('topic:t', null, rows), ['ui'])
})
