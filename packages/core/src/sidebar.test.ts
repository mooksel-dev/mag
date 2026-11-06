import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addGroup,
  cardFilter,
  cardRef,
  groupKey,
  moveRef,
  placeNew,
  removeGroup,
  renameGroup,
  sidebarRows,
  toggleGroup,
  workCards,
  type AgentSession,
  type SidebarNode,
  type SidebarRows,
  type Task,
} from './index.ts'

const NOW = 100 * 24 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

const task = (id: string, createdAt: number, patch: Partial<Task> = {}): Task => ({
  id, projectId: 'p', key: id, parentId: null, title: id, type: 'dev', status: 'planning', description: '', rank: 0,
  needsInput: null, work: null, nextSubNo: 1, createdAt, updatedAt: NOW - DAY, ...patch,
})
const topic = (id: string, createdAt: number, patch: Partial<AgentSession> = {}): AgentSession => ({
  id, projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], createdAt, ...patch,
})
const rows = (layout: SidebarNode[], tasks: Task[], sessions: AgentSession[] = [], filter?: Parameters<typeof sidebarRows>[2]) =>
  sidebarRows(layout, workCards('p', tasks, sessions, NOW), filter)
/** The main list as text: "a", "[g: a b]" for a group, "–" before the closed ones. */
const text = (r: SidebarRows) => [
  ...r.entries.map((e) => (e.kind === 'row' ? e.card.id : `[${e.group.name}${e.group.collapsed ? '▸' : ''}:${e.group.rows.map((c) => ` ${c.id}`).join('')}]`)),
  ...(r.closed.length ? ['–', ...r.closed.map((c) => c.id)] : []),
].join(' ')

test('sidebarRows: items not in the layout go on top, newest created first; then the layout order', () => {
  const tasks = [task('a', 1), task('b', 2), task('c', 3), task('d', 4)]
  assert.equal(text(rows([], tasks)), 'd c b a')
  assert.equal(text(rows([{ kind: 'item', ref: 'work:a' }, { kind: 'item', ref: 'work:c' }], tasks)), 'd b a c')
})

test('sidebarRows: a change of state (waiting, working, done, new activity) never moves a row', () => {
  const layout: SidebarNode[] = ['work:a', 'topic:t', 'work:b', 'work:c'].map((ref) => ({ kind: 'item', ref }))
  const before = rows(layout, [task('a', 1), task('b', 2), task('c', 3, { status: 'ready' })], [topic('t', 0)])
  // a: an agent starts; b: done; c: waits on the user; t: a new message.
  const after = rows(
    layout,
    [task('a', 1, { status: 'in_progress', updatedAt: NOW }), task('b', 2, { status: 'done', updatedAt: NOW }), task('c', 3, { needsInput: 'Plan ready', updatedAt: NOW })],
    [topic('t', 0, { items: [{ kind: 'user', text: 'hi', at: NOW }] }), topic('dev', 0, { taskId: 'a', role: 'developer', status: 'running', runStartedAt: NOW })],
  )
  assert.equal(text(before), 'a t b c')
  assert.equal(text(after), 'a t b c')
  assert.deepEqual((after.entries[2] as { card: { dot: string; move: { text: string } } }).card.move.text, 'Done')
})

test('sidebarRows: refs of removed items drop; a chat keeps its slot and its works are its children', () => {
  const layout: SidebarNode[] = ['work:gone', 'work:a', 'topic:t', 'work:b'].map((ref) => ({ kind: 'item', ref }))
  const r = rows(layout, [task('a', 1), task('b', 2), task('w', 9, { ownerSessionId: 't' })], [topic('t', 0)])
  assert.equal(text(r), 'a t b')
  assert.deepEqual((r.entries[1] as { card: { children: { id: string }[] } }).card.children.map((c) => c.id), ['w'])
  assert.deepEqual(r.layout, ['work:a', 'topic:t', 'work:b'].map((ref) => ({ kind: 'item', ref })))
})

test('sidebarRows: a layout that listed a child work in its chat\'s slot shows the chat there, once', () => {
  const tasks = [task('a', 1), task('w', 9, { ownerSessionId: 't' }), task('v', 10, { ownerSessionId: 't' })]
  const r = rows(['work:a', 'work:w', 'work:v'].map((ref): SidebarNode => ({ kind: 'item', ref })), tasks, [topic('t', 0)])
  assert.equal(text(r), 'a t')
  assert.deepEqual(r.layout, ['work:a', 'topic:t'].map((ref) => ({ kind: 'item', ref })))
})

test('sidebarRows: Closed apart in layout order; a done work stays in place; filters and search only hide', () => {
  const layout: SidebarNode[] = [{ kind: 'item', ref: 'topic:x' }, { kind: 'item', ref: 'work:done' }, { kind: 'group', id: 'g', name: 'G', collapsed: false, items: ['work:rev', 'work:c', 'work:w'] }]
  const tasks = [
    task('done', 1, { status: 'done' }),
    task('rev', 2, { type: 'review', status: 'done', title: 'app#1: Fix', closedAt: NOW }),
    task('c', 3, { status: 'canceled' }),
    task('w', 4, { status: 'ready' }),
  ]
  const sessions = [topic('x', 0, { closedAt: NOW })]
  assert.equal(text(rows(layout, tasks, sessions)), 'done [G: w] – x rev c')
  const waiting = (c: Parameters<NonNullable<Parameters<typeof sidebarRows>[2]>>[0]) => cardFilter([c], 'waiting').length > 0
  assert.equal(text(rows(layout, tasks, sessions, waiting)), '[G: w]')
  assert.equal(text(rows(layout, tasks, sessions, (c) => c.id === 'done')), 'done')
})

test('sidebarRows: a closed done work goes to Closed and, restored, comes back to its slot; done without closedAt stays', () => {
  const layout: SidebarNode[] = ['work:a', 'work:d', 'work:b'].map((ref) => ({ kind: 'item', ref }))
  const tasks = (closedAt: number | null) => [task('a', 1), task('d', 2, { status: 'done', closedAt }), task('b', 3)]
  assert.equal(text(rows(layout, tasks(null))), 'a d b')
  const closed = rows(layout, tasks(NOW))
  assert.equal(text(closed), 'a b – d')
  assert.equal(text(rows(closed.layout, tasks(null))), 'a d b')
})

test('moveRef: reorder at the top level and into / out of a group; a group moves as one', () => {
  const r = rows([], [task('a', 3), task('b', 2), task('c', 1)])
  let layout = moveRef(r.layout, 'work:c', null, 0)
  assert.equal(text(rows(layout, [task('a', 3), task('b', 2), task('c', 1)])), 'c a b')
  layout = addGroup(layout, 'Later', 'g')
  layout = moveRef(layout, 'work:a', 'g', 0)
  layout = moveRef(layout, 'work:b', 'g', 0)
  const tasks = [task('a', 3), task('b', 2), task('c', 1)]
  assert.equal(text(rows(layout, tasks)), '[Later: b a] c')
  layout = moveRef(layout, groupKey('g'), null, 9)
  assert.equal(text(rows(layout, tasks)), 'c [Later: b a]')
  layout = moveRef(layout, 'work:a', null, 0)
  assert.equal(text(rows(layout, tasks)), 'a c [Later: b]')
  assert.throws(() => moveRef(layout, groupKey('g'), 'g', 0), /cannot go into a group/)
  assert.throws(() => moveRef(layout, 'work:a', 'nope', 0), /No group/)
})

test('groups: none by default; create, rename, collapse; delete keeps its rows in its place', () => {
  const tasks = [task('a', 3), task('b', 2), task('c', 1)]
  let layout: SidebarNode[] = rows([], tasks).layout
  assert.ok(rows(layout, tasks).entries.every((e) => e.kind === 'row'))
  layout = moveRef(addGroup(layout, '  ', 'g'), 'work:b', 'g', 0)
  layout = moveRef(layout, groupKey('g'), null, 1)
  assert.equal(text(rows(layout, tasks)), 'a [New group: b] c')
  layout = toggleGroup(renameGroup(layout, 'g', ' Ideas  later '), 'g')
  assert.equal(text(rows(layout, tasks)), 'a [Ideas later▸: b] c')
  assert.equal(renameGroup(layout, 'g', '  '), layout)
  layout = removeGroup(layout, 'g')
  assert.equal(text(rows(layout, tasks)), 'a b c')
  assert.throws(() => addGroup(addGroup([], 'x', 'g'), 'y', 'g'), /exists/)
})

test('placeNew: an item created from a group\'s + is first in that group; without a group it goes on top', () => {
  const tasks = [task('a', 1), task('b', 2)]
  let layout = moveRef(addGroup(rows([], tasks).layout, 'G', 'g'), 'work:a', 'g', 0)
  layout = placeNew(layout, 'topic:new', 'g')
  const withNew = rows(layout, tasks, [topic('new', 5)])
  assert.equal(text(withNew), '[G: new a] b')
  assert.equal(cardRef((withNew.entries[0] as { group: { rows: { kind: 'topic'; id: string }[] } }).group.rows[0]), 'topic:new')
  assert.equal(placeNew(layout, 'work:x', null), layout)
  assert.equal(text(rows(placeNew(layout, 'work:x', null), [...tasks, task('x', 9)], [topic('new', 5)])), 'x [G: new a] b')
  assert.equal(placeNew(layout, 'work:x', 'missing'), layout)
})
