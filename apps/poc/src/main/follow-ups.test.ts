import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InboxItem } from '@mag/core'
import { createInbox, type AddedItem, type InboxState } from './core/services/inbox/index.ts'
import { createRoutines, type FollowUp } from './core/services/routines/index.ts'
import { followUpKey } from './core/services/routines/refs.ts'
import { addFollowUp, doneInboxItem } from './follow-ups.ts'
import { followUpTick } from './scheduler.ts'

const DUE = new Date(2026, 10, 24, 9).getTime()

function setup(derived: InboxItem[] = []) {
  const rows = { states: [] as InboxState[], added: [] as AddedItem[], followUps: [] as FollowUp[] }
  const put = <T extends { id: string }>(list: T[], x: T) => {
    const i = list.findIndex((y) => y.id === x.id)
    if (i >= 0) list[i] = x
    else list.push(x)
  }
  const clock = { t: new Date(2026, 10, 21, 12).getTime() }
  const inbox = createInbox({
    store: { states: () => rows.states, putState: (s) => put(rows.states, s), removeStates: (keys) => void (rows.states = rows.states.filter((s) => !keys.includes(s.key))), added: () => rows.added, putAdded: (a) => put(rows.added, a) },
    derived: () => derived,
    workspaceOf: () => 'w1',
    now: () => clock.t,
  })
  const routines = createRoutines({
    now: () => clock.t,
    records: { routines: () => [], putRoutine: () => {}, removeRoutine: () => {}, runs: () => [], putRun: () => {}, removeRuns: () => {}, followUps: () => rows.followUps, putFollowUp: (f) => put(rows.followUps, f) },
  })
  const keys = () => inbox.items().map((e) => e.key)
  return { rows, clock, inbox, routines, keys }
}

test('a follow-up from an Inbox item: the item is Done; on its date it comes back once as who: what; Done closes it (routines-scheduled-drafts-and-a.3)', () => {
  const { rows, clock, inbox, routines, keys } = setup([{ key: 'q', projectId: 'p1', task: null, kind: 'question', text: 'Numbers?', activityAt: 5 }])
  const f = addFollowUp({ routines, inbox }, { workspaceId: 'w1', projectId: 'p1', who: 'Ana', what: 'Send the numbers', dueAt: DUE, sourceRef: 'work:t1', fromKey: 'q' })
  assert.deepEqual(keys(), [])
  followUpTick(routines, inbox, clock.t)
  assert.deepEqual(keys(), [])
  clock.t = DUE
  followUpTick(routines, inbox, clock.t)
  const [e] = inbox.items()
  assert.deepEqual([e.key, e.kind, e.text, e.ref, e.projectId, e.workspaceId, e.dueAt, e.labels], [followUpKey(f.id), 'follow_up', 'Ana: Send the numbers', 'work:t1', 'p1', 'w1', DUE, ['p1']])
  // Snoozed, a later tick doesn't bring it back as new activity.
  inbox.snooze(e.key, DUE + 3_600_000)
  clock.t += 60_000
  followUpTick(routines, inbox, clock.t)
  assert.deepEqual(keys(), [])
  clock.t = DUE + 3_600_000
  assert.deepEqual(keys(), [followUpKey(f.id)])
  doneInboxItem({ routines, inbox }, e.key)
  assert.deepEqual(keys(), [])
  assert.equal(rows.followUps[0].status, 'done')
  assert.notEqual(rows.added.find((a) => a.key === e.key)?.resolvedAt, null)
})

test('the Inbox\'s Done of other items hides them as before; of a follow-up mag no longer has, too', () => {
  const { inbox, routines, keys } = setup([{ key: 'q', projectId: 'p1', task: null, kind: 'question', text: 'x', activityAt: 5 }])
  inbox.add({ key: followUpKey('gone'), kind: 'follow_up', text: 'Ana: x' })
  doneInboxItem({ routines, inbox }, 'q')
  doneInboxItem({ routines, inbox }, followUpKey('gone'))
  doneInboxItem({ inbox }, 'q')
  assert.deepEqual(keys(), [])
})

test('followUpTick: one that fails to surface is logged, the others still go', () => {
  const { routines, clock } = setup()
  routines.addFollowUp({ workspaceId: 'w1', who: 'A', what: 'a', dueAt: clock.t })
  routines.addFollowUp({ workspaceId: 'w1', who: 'B', what: 'b', dueAt: clock.t })
  const added: string[] = []
  followUpTick(routines, { add: (i) => { if (i.text.startsWith('A')) throw new Error('boom'); added.push(i.text) } }, clock.t)
  assert.deepEqual(added, ['B: b'])
  assert.deepEqual(routines.dueFollowUps(clock.t).map((f) => f.who), ['A'])
})
