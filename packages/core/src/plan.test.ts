import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canMoveInPlan, nextWork, planBlockers, planQueue, rollupStatus, type Task, type TaskStatus } from './index.ts'

const task = (id: string, status: TaskStatus, rank: number, patch: Partial<Task> = {}): Task => ({
  id,
  projectId: 'p',
  key: id,
  parentId: null,
  title: id,
  type: 'dev',
  status,
  description: '',
  rank,
  needsInput: null,
  work: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})
const sub = (id: string, parentId: string, status: TaskStatus, rank: number, patch: Partial<Task> = {}) =>
  task(id, status, rank, { parentId, ...patch })

test('planQueue: top-level plan tasks by rank', () => {
  const tasks = [task('b', 'planned', 2), task('a', 'done', 1), task('c', 'groomed', 0), sub('s', 'b', 'planned', 0)]
  assert.deepEqual(planQueue(tasks).map((t) => t.id), ['a', 'b'])
})

test('planBlockers', () => {
  assert.deepEqual(planBlockers(task('a', 'groomed', 0)), [])
  assert.deepEqual(planBlockers(task('a', 'backlog', 0, { needsInput: 'q' })), ['not groomed yet', 'agent is waiting for input'])
  assert.deepEqual(planBlockers(sub('s', 'a', 'groomed', 0)), ['subtasks are planned with their task'])
})

test('nextWork takes the first subtask of the first unfinished task', () => {
  const tasks = [
    task('t1', 'done', 0),
    task('t2', 'planned', 1),
    sub('s2', 't2', 'planned', 1),
    sub('s1', 't2', 'planned', 0),
    task('t3', 'planned', 2),
  ]
  assert.equal(nextWork(tasks)?.id, 's1')
})

test('nextWork takes the task itself when it has no subtasks', () => {
  assert.equal(nextWork([task('t1', 'planned', 1), task('t0', 'planned', 0)])?.id, 't0')
})

test('nextWork: one unit at a time', () => {
  assert.equal(nextWork([task('t1', 'in_review', 0), task('t2', 'planned', 1)]), null)
  const tasks = [task('t1', 'in_progress', 0), sub('s1', 't1', 'done', 0), sub('s2', 't1', 'in_progress', 1), sub('s3', 't1', 'planned', 2)]
  assert.equal(nextWork(tasks), null)
})

test('nextWork moves on after a merge', () => {
  const tasks = [task('t1', 'in_progress', 0), sub('s1', 't1', 'done', 0), sub('s2', 't1', 'planned', 1)]
  assert.equal(nextWork(tasks)?.id, 's2')
})

test('nextWork waits on a unit that needs input', () => {
  assert.equal(nextWork([task('t1', 'planned', 0, { needsInput: 'x' }), task('t2', 'planned', 1)]), null)
})

test('nextWork: empty or finished plan', () => {
  assert.equal(nextWork([]), null)
  assert.equal(nextWork([task('t1', 'done', 0), task('b', 'groomed', 1)]), null)
})

test('rollupStatus', () => {
  const s = (...st: TaskStatus[]) => st.map((x, i) => sub(`s${i}`, 'p', x, i))
  assert.equal(rollupStatus(s('done', 'done')), 'done')
  assert.equal(rollupStatus(s('done', 'in_review', 'planned')), 'in_review')
  assert.equal(rollupStatus(s('in_progress', 'planned')), 'in_progress')
  assert.equal(rollupStatus(s('done', 'planned')), 'in_progress')
  assert.equal(rollupStatus(s('planned', 'planned')), 'planned')
})

test('canMoveInPlan: only between not-started tasks', () => {
  const work = { repo: 'r', branch: 'b', worktree: 'w', prUrl: null, feedbackSeenAt: 0 }
  const tasks = [
    task('done', 'done', 0),
    task('a', 'planned', 1),
    sub('as', 'a', 'in_progress', 0, { work }),
    task('b', 'planned', 2),
    task('c', 'planned', 3),
    task('x', 'groomed', 4),
  ]
  const t = (id: string) => tasks.find((x) => x.id === id)!
  assert.equal(canMoveInPlan(t('c'), tasks, 'up'), true)
  assert.equal(canMoveInPlan(t('b'), tasks, 'down'), true)
  assert.equal(canMoveInPlan(t('c'), tasks, 'down'), false, 'last one')
  assert.equal(canMoveInPlan(t('b'), tasks, 'up'), false, 'a has started work')
  assert.equal(canMoveInPlan(t('a'), tasks, 'down'), false, 'a has started work')
  assert.equal(canMoveInPlan(t('done'), tasks, 'down'), false)
  assert.equal(canMoveInPlan(t('x'), tasks, 'up'), false, 'not in the plan')
})
