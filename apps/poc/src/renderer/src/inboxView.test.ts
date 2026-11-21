import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ItemLabel } from '@mag/core'
import type { InboxEntry } from '../../main/core/services/inbox/index.ts'
import { entryLabelIds, entryRef, inboxGroup, inboxMatches, openContext, openTarget, snoozePresets, workspaceInbox } from './inboxView.ts'

const entry = (patch: Partial<InboxEntry>): InboxEntry => ({
  key: 'k', kind: 'question', text: 'Which way?', projectId: 'p', workspaceId: 'w', taskId: null, sessionId: null, labels: [], activityAt: 0, added: false, ...patch,
})
const tasks = [{ id: 'work', parentId: null }, { id: 'step', parentId: 'work' }]
const sessions = [
  { id: 'topic', taskId: null, parentId: null },
  { id: 'sub', taskId: null, parentId: 'topic' },
  { id: 'dev', taskId: 'step', parentId: null },
]

test('inboxGroup: publish cards, drafts, PR activity and inbound apart from what needs you', () => {
  assert.equal(inboxGroup(entry({ kind: 'approval' })), 'needs')
  assert.equal(inboxGroup(entry({ kind: 'approval', destination: { kind: 'slack', target: '#a' } as InboxEntry['destination'] })), 'publish')
  assert.equal(inboxGroup(entry({ kind: 'draft' })), 'drafts')
  assert.equal(inboxGroup(entry({ kind: 'review_activity' })), 'pr')
  assert.equal(inboxGroup(entry({ kind: 'inbound' })), 'inbound')
  for (const kind of ['question', 'agent_failed', 'check_failed', 'review_look', 'ready_to_merge', 'review_ready', 'ready_to_start', 'follow_up', 'other'] as const) {
    assert.equal(inboxGroup(entry({ kind })), 'needs', kind)
  }
})

test('workspaceInbox: this workspace and items without one', () => {
  const list = [entry({ key: 'a' }), entry({ key: 'b', workspaceId: 'w2' }), entry({ key: 'c', workspaceId: null })]
  assert.deepEqual(workspaceInbox(list, 'w').map((e) => e.key), ['a', 'c'])
})

test('openTarget: a step opens its work, a task session its work, a topic itself, nothing a new topic', () => {
  assert.deepEqual(openTarget(entry({ taskId: 'step' }), tasks, sessions), { kind: 'work', id: 'work' })
  assert.deepEqual(openTarget(entry({ taskId: 'work' }), tasks, sessions), { kind: 'work', id: 'work' })
  assert.deepEqual(openTarget(entry({ sessionId: 'dev' }), tasks, sessions), { kind: 'work', id: 'work' })
  assert.deepEqual(openTarget(entry({ sessionId: 'sub' }), tasks, sessions), { kind: 'topic', id: 'sub' })
  assert.deepEqual(openTarget(entry({ added: true }), tasks, sessions), { kind: 'new' })
  assert.deepEqual(openTarget(entry({ taskId: 'gone', sessionId: 'gone' }), tasks, sessions), { kind: 'new' })
})

test('entryRef: a subtopic carries its topic\'s labels', () => {
  assert.equal(entryRef(entry({ sessionId: 'sub' }), tasks, sessions), 'topic:topic')
  assert.equal(entryRef(entry({ taskId: 'step' }), tasks, sessions), 'work:work')
  assert.equal(entryRef(entry({}), tasks, sessions), null)
})

test('entryLabelIds: project, own labels and the item\'s, once each; filters by any of them', () => {
  const itemLabels: ItemLabel[] = [
    { id: 'work:work|l1', itemRef: 'work:work', labelId: 'l1', by: 'user' },
    { id: 'work:work|l2', itemRef: 'work:work', labelId: 'l2', by: 'rule', removed: true },
    { id: 'topic:x|l3', itemRef: 'topic:x', labelId: 'l3', by: 'user' },
  ]
  const ids = entryLabelIds(entry({ labels: ['l1', 'l4'] }), 'work:work', itemLabels)
  assert.deepEqual(ids, ['p', 'l1', 'l4'])
  assert.deepEqual(entryLabelIds(entry({ projectId: null, labels: ['l4'] }), null, itemLabels), ['l4'])
  assert.ok(inboxMatches(ids, 'all'))
  assert.ok(inboxMatches(ids, 'p'))
  assert.ok(inboxMatches(ids, 'l4'))
  assert.ok(!inboxMatches(ids, 'l2'))
})

test('openContext: the item and what it is about', () => {
  assert.equal(openContext(entry({ kind: 'inbound', text: 'Ask from Ann', ref: 'w:message:1' })), 'From the Inbox (inbound): Ask from Ann\nAbout: w:message:1')
  assert.equal(openContext(entry({ kind: 'draft', text: 'Spec v2' })), 'From the Inbox (draft): Spec v2')
})

test('snoozePresets: 1 hour, tomorrow 9:00, the next Monday 9:00 ahead, on activity', () => {
  const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
  // Wednesday 2026-11-18 15:00.
  const wed = local(2026, 11, 18, 15)
  const [hour, tomorrow, monday, activity] = snoozePresets(wed)
  assert.equal(hour.until, wed + 3_600_000)
  assert.equal(tomorrow.until, local(2026, 11, 19, 9))
  assert.equal(monday.until, local(2026, 11, 23, 9))
  assert.equal(activity.until, 'activity')
  assert.equal(snoozePresets(local(2026, 11, 22, 23))[2].until, local(2026, 11, 23, 9), 'Sunday: tomorrow')
  assert.equal(snoozePresets(local(2026, 11, 23, 8))[2].until, local(2026, 11, 23, 9), 'Monday before 9: today')
  assert.equal(snoozePresets(local(2026, 11, 23, 9))[2].until, local(2026, 11, 30, 9), 'Monday at 9: next week')
  assert.equal(snoozePresets(local(2026, 12, 31, 12))[1].until, local(2027, 1, 1, 9), 'tomorrow across the year')
})
