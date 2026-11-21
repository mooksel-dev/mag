import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARK_END, MARK_START } from '../../main/core/services/search/types.ts'
import { countText, headingIndex, hitTarget, labelQuery, snippetParts, sourceLine } from './searchView.ts'

const deliverables = [{ id: 'd1', folder: 'aura', slug: 'weekly', workspaceId: 'w1', topicId: 't1' }]
const ctx = {
  workspaceId: 'w1',
  sessions: [{ id: 't1', taskId: null }, { id: 'dev', taskId: 'step' }],
  tasks: [{ id: 'work', parentId: null }, { id: 'step', parentId: 'work' }],
  deliverables,
}

test('hitTarget: a topic at its message, a work agent\'s message opens its work, a doc section, decisions, a meeting line, a deliverable version, a person', () => {
  assert.deepEqual(hitTarget('w1:topic:t1#7', 'T', ctx), { kind: 'topic', id: 't1', item: 7 })
  assert.deepEqual(hitTarget('w1:topic:t1', 'T', ctx), { kind: 'topic', id: 't1' })
  assert.deepEqual(hitTarget('w1:topic:dev#3', 'T', ctx), { kind: 'work', id: 'work' })
  assert.deepEqual(hitTarget('w1:doc:step#plan', 'T', ctx), { kind: 'work', id: 'work', section: 'plan' })
  assert.deepEqual(hitTarget('w1:dec:work#2', 'T', ctx), { kind: 'work', id: 'work', decisions: true })
  assert.deepEqual(hitTarget('w1:work:work', 'T', ctx), { kind: 'work', id: 'work' })
  assert.deepEqual(hitTarget('mtg:m1@00:01:02', 'T', ctx), { kind: 'meeting', id: 'm1', at: '00:01:02' })
  assert.deepEqual(hitTarget('aura:dlv:weekly@2', 'T', ctx), { kind: 'deliverable', id: 'd1', topicId: 't1', version: 2 })
  assert.deepEqual(hitTarget('w1:person:olena-k', 'Olena K', ctx), { kind: 'person', id: 'olena-k', name: 'Olena K' })
})

test('hitTarget: another workspace opens there; what is gone is null', () => {
  assert.deepEqual(hitTarget('w2:topic:x#1', 'T', ctx), { kind: 'elsewhere', workspaceId: 'w2' })
  assert.deepEqual(hitTarget('aura:dlv:weekly', 'T', { ...ctx, workspaceId: 'w9' }), { kind: 'elsewhere', workspaceId: 'w1' })
  assert.equal(hitTarget('w1:topic:gone', 'T', ctx), null)
  assert.equal(hitTarget('w1:doc:gone#x', 'T', ctx), null)
  assert.equal(hitTarget('aura:dlv:gone', 'T', ctx), null)
  assert.equal(hitTarget('nonsense', 'T', ctx), null)
})

test('sourceLine: kind, another workspace by name, label and project names; countText at the limit', () => {
  const s = { workspaceId: 'w1', workspaces: [{ id: 'w1', name: 'Aura' }, { id: 'w2', name: 'Personal' }], projects: [{ id: 'p1', name: 'Data Removal' }], labels: [{ id: 'l1', name: 'Privacy' }], deliverables }
  assert.equal(sourceLine({ ref: 'w1:topic:t1#0', kind: 'topic', labels: ['p1', 'l1', 'gone'] }, s), 'Topic · Data Removal · Privacy')
  assert.equal(sourceLine({ ref: 'w2:doc:x#a', kind: 'doc', labels: [] }, s), 'Doc · Personal')
  assert.equal(sourceLine({ ref: 'mtg:m1', kind: 'meeting', labels: [] }, s), 'Meeting')
  assert.equal(countText(3, 50), '3')
  assert.equal(countText(50, 50), '50+')
})

test('labelQuery: one group per label group, any of its picked labels; none picked is no filter', () => {
  const groups = [{ group: { id: 'project' }, labels: [{ id: 'p1' }, { id: 'p2' }] }, { group: { id: 'area' }, labels: [{ id: 'l1' }] }]
  assert.deepEqual(labelQuery(['p1', 'p2', 'l1'], groups), [['p1', 'p2'], ['l1']])
  assert.deepEqual(labelQuery(['l1'], groups), [['l1']])
  assert.equal(labelQuery([], groups), undefined)
})

test('snippetParts: the marked words as hits, whitespace folded; headingIndex: a section slug or §Decisions among the rendered headings', () => {
  assert.deepEqual(snippetParts(`…the ${MARK_START}DBR${MARK_END} queue\n${MARK_START}stalls${MARK_END}`), [
    { text: '…the ', hit: false }, { text: 'DBR', hit: true }, { text: ' queue ', hit: false }, { text: 'stalls', hit: true },
  ])
  const doc = 'intro\n# Problem\nx\n```\n# no\n```\n## Decisions\n- a\n# Plan\n## Decisions\n- b'
  assert.equal(headingIndex(doc, 'plan'), 2)
  assert.equal(headingIndex(doc, 'decisions-2'), 3)
  assert.equal(headingIndex(doc, undefined, true), 1)
  assert.equal(headingIndex(doc, 'nope'), -1)
})
