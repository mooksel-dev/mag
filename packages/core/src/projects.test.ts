import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_COLORS, projectColor, projectState, waitingTotal, type Task, type TaskStatus } from './index.ts'

const task = (id: string, projectId: string, status: TaskStatus, patch: Partial<Task> = {}): Task => ({
  id,
  projectId,
  key: id,
  parentId: null,
  title: id,
  type: 'dev',
  status,
  description: '',
  rank: 0,
  needsInput: null,
  work: null,
  nextSubNo: 1,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})

test('projectColor: own color wins', () => {
  assert.equal(projectColor({ id: 'abc', color: '#123456' }), '#123456')
})

test('projectColor: from the palette, stable per id', () => {
  const c = projectColor({ id: 'a1b2c3d4' })
  assert.ok(PROJECT_COLORS.includes(c))
  assert.equal(projectColor({ id: 'a1b2c3d4', color: null }), c)
  const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => projectColor({ id })))
  assert.ok(spread.size > 1, 'different ids get different colors')
})

test('projectState: waiting, in review, idle', () => {
  assert.equal(projectState('p', [task('t', 'p', 'in_progress', { needsInput: 'Which one?' })], []), 'waiting')
  assert.equal(projectState('p', [task('t', 'p', 'in_review')], []), 'in_review')
  assert.equal(projectState('p', [task('t', 'p', 'in_progress')], []), 'idle')
  assert.equal(projectState('p', [task('t', 'q', 'in_review')], []), 'idle', 'other projects do not count')
})

test('waitingTotal sums the inbox of every project', () => {
  const tasks = [task('a', 'p', 'groomed'), task('b', 'p', 'backlog', { needsInput: '?' }), task('c', 'q', 'groomed'), task('d', 'gone', 'groomed')]
  assert.equal(waitingTotal([{ id: 'p' }, { id: 'q' }], tasks, []), 3)
})
