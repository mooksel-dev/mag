import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InboxItem } from '@mag/core'
import { createInbox, type AddedItem, type InboxState, type InboxStore } from './index.ts'

function memoryStore(): InboxStore & { rows: { states: InboxState[]; added: AddedItem[] } } {
  const rows = { states: [] as InboxState[], added: [] as AddedItem[] }
  const put = <T extends { key: string }>(list: T[], x: T) => {
    const i = list.findIndex((y) => y.key === x.key)
    if (i >= 0) list[i] = x
    else list.push(x)
  }
  return {
    rows,
    states: () => rows.states,
    putState: (s) => put(rows.states, s),
    removeStates: (keys) => void (rows.states = rows.states.filter((s) => !keys.includes(s.key))),
    added: () => rows.added,
    putAdded: (a) => put(rows.added, a),
  }
}

const item = (key: string, activityAt = 0, projectId = 'p'): InboxItem => ({ key, projectId, task: null, kind: 'question', text: key, activityAt })

function setup(derived: InboxItem[] = []) {
  const store = memoryStore()
  const clock = { t: 1000 }
  const src = { derived }
  const inbox = createInbox({ store, derived: () => src.derived, workspaceOf: (p) => (p === 'p' ? 'w1' : null), now: () => clock.t })
  const keys = () => inbox.items().map((e) => e.key)
  return { store, clock, src, inbox, keys }
}

test('items: derived items as entries with their workspace, ids instead of objects', () => {
  const { inbox } = setup([item('a', 5)])
  assert.deepEqual(inbox.items(), [{ key: 'a', kind: 'question', text: 'a', projectId: 'p', workspaceId: 'w1', taskId: null, sessionId: null, labels: [], activityAt: 5, added: false }])
})

test('add: an item with no source of its own shows until resolve; the same key replaces it', () => {
  const { inbox, keys, store, clock } = setup([item('a')])
  inbox.add({ key: 'routine:r1:draft', kind: 'draft', text: 'Weekly update', projectId: 'p', labels: ['team-a'] })
  assert.deepEqual(keys(), ['a', 'routine:r1:draft'])
  const added = inbox.items()[1]
  assert.deepEqual([added.added, added.workspaceId, added.labels, added.activityAt], [true, 'w1', ['team-a'], 1000])
  clock.t = 2000
  inbox.add({ key: 'routine:r1:draft', kind: 'draft', text: 'Weekly update v2' })
  assert.equal(store.rows.added.length, 1, 'one row per key')
  assert.equal(inbox.items()[1].text, 'Weekly update v2')
  inbox.resolve('routine:r1:draft')
  assert.deepEqual(keys(), ['a'])
  assert.equal(store.rows.added[0].resolvedAt, 2000)
  assert.throws(() => inbox.add({ key: ' ', kind: 'other', text: 'x' }))
})

test('snooze until a time hides an item until then, or until its source has new activity', () => {
  const { inbox, keys, clock, src } = setup([item('a', 5), item('b')])
  inbox.snooze('a', 5000)
  assert.deepEqual(keys(), ['b'])
  clock.t = 4999
  assert.deepEqual(keys(), ['b'])
  clock.t = 5000
  assert.deepEqual(keys(), ['a', 'b'], 'the time is reached')
  inbox.snooze('a', 9000)
  src.derived = [item('a', 6), item('b')]
  assert.deepEqual(keys(), ['a', 'b'], 'new activity wakes it early')
})

test('snooze until activity hides an item until its activity time grows', () => {
  const { inbox, keys, clock, src } = setup([item('a', 5)])
  inbox.snooze('a', 'activity')
  clock.t = 1e12
  assert.deepEqual(keys(), [], 'time alone does not wake it')
  src.derived = [item('a', 5)]
  assert.deepEqual(keys(), [])
  src.derived = [item('a', 7)]
  assert.deepEqual(keys(), ['a'])
})

test('done hides an item until new activity; an added one wakes when added again', () => {
  const { inbox, keys, clock, src } = setup([item('a', 5)])
  inbox.add({ key: 'x', kind: 'inbound', text: 'Can you look?' })
  inbox.done('a')
  inbox.done('x')
  clock.t = 1e12
  assert.deepEqual(keys(), [])
  src.derived = [item('a', 8)]
  inbox.add({ key: 'x', kind: 'inbound', text: 'Ping' })
  assert.deepEqual(keys(), ['a', 'x'])
})

test('an item whose source cleared drops its state, so it comes back as new', () => {
  const { inbox, keys, src, store } = setup([item('a')])
  inbox.done('a')
  assert.deepEqual(keys(), [])
  src.derived = []
  assert.deepEqual(keys(), [])
  assert.deepEqual(store.rows.states, [], 'resolved')
  src.derived = [item('a')]
  assert.deepEqual(keys(), ['a'])
  inbox.snooze('a', 'activity')
  inbox.resolve('a')
  assert.deepEqual(keys(), ['a'], 'resolve drops the user state of a derived key')
})

test('snooze and done need an item that waits, and a time', () => {
  const { inbox } = setup([item('a')])
  assert.throws(() => inbox.snooze('nope', 'activity'), /No inbox item nope/)
  assert.throws(() => inbox.done('nope'), /No inbox item nope/)
  assert.throws(() => inbox.snooze('a', NaN))
})
