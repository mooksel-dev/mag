import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canMoveInPlan, canMoveSubtask, findRepoWork, nextPlanRank, planQueue, prRollup, repoDirNames, repoWorkName, subtaskProgress, subtaskStatusChanges, todoTasks, type RepoWork, type Task, type TaskStatus, type TaskWork } from './index.ts'

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
  nextSubNo: 1,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})
const sub = (id: string, parentId: string, status: TaskStatus, rank: number, patch: Partial<Task> = {}) =>
  task(id, status, rank, { parentId, ...patch })
const repo = (path: string, worktree: string): RepoWork => ({ repo: path, branch: 'b', worktree, prUrl: null, prState: null })

test('planQueue: top-level todo and in-progress tasks by rank', () => {
  const tasks = [task('b', 'todo', 2), task('a', 'in_progress', 1), task('d', 'done', 0), task('c', 'grooming', 0), sub('s', 'b', 'todo', 0)]
  assert.deepEqual(planQueue(tasks).map((t) => t.id), ['a', 'b'])
})

test('nextPlanRank: after the last queued task, ignoring the rest and subtasks', () => {
  assert.equal(nextPlanRank([]), 1)
  assert.equal(nextPlanRank([task('c', 'grooming', 9)]), 1)
  const tasks = [task('a', 'done', 5), task('b', 'todo', 3), task('c', 'backlog', 9), sub('s', 'b', 'todo', 7)]
  assert.equal(nextPlanRank(tasks), 4)
})

test('todoTasks: top-level todo tasks by rank, wherever in-progress tasks sit', () => {
  const tasks = [task('c', 'todo', 3), task('run', 'in_progress', 2), task('a', 'todo', 1), task('d', 'done', 0), sub('s', 'a', 'todo', 0)]
  assert.deepEqual(todoTasks(tasks).map((t) => t.id), ['a', 'c'])
  assert.deepEqual(todoTasks([]), [])
})

test('subtaskProgress', () => {
  const tasks = [task('t', 'in_progress', 0), sub('a', 't', 'done', 0), sub('b', 't', 'in_progress', 1), sub('c', 'x', 'done', 0)]
  assert.deepEqual(subtaskProgress('t', tasks), { done: 1, total: 2 })
  assert.deepEqual(subtaskProgress('none', tasks), { done: 0, total: 0 })
})

test('subtaskStatusChanges: one step in progress at a time', () => {
  const tasks = [task('t', 'in_progress', 0), sub('a', 't', 'in_progress', 0), sub('b', 't', 'todo', 1), sub('c', 't', 'done', 2), sub('o', 'x', 'in_progress', 0)]
  const t = (id: string) => tasks.find((x) => x.id === id)!
  assert.deepEqual(subtaskStatusChanges(t('b'), 'in_progress', tasks), [{ id: 'a', status: 'todo' }, { id: 'b', status: 'in_progress' }])
  assert.deepEqual(subtaskStatusChanges(t('a'), 'done', tasks), [{ id: 'a', status: 'done' }])
  assert.deepEqual(subtaskStatusChanges(t('a'), 'in_progress', tasks), [{ id: 'a', status: 'in_progress' }], 'already the one')
  assert.deepEqual(subtaskStatusChanges(t('c'), 'in_progress', tasks), [{ id: 'a', status: 'todo' }, { id: 'c', status: 'in_progress' }], 'reopening a done step')
})

test('repoDirNames: base names, unique within the task', () => {
  assert.deepEqual(repoDirNames(['/a/app', '/b/app/', '/c/api', '/d/app']), ['app', 'app-2', 'api', 'app-3'])
})

test('findRepoWork: by name, repo path or worktree path', () => {
  const work: TaskWork = { dir: '/w/T-1', feedbackSeenAt: 0, repos: [repo('/src/app', '/w/T-1/app'), repo('/src/api', '/w/T-1/api')] }
  assert.equal(findRepoWork(work, 'api')?.repo, '/src/api')
  assert.equal(findRepoWork(work, '/src/app/')?.repo, '/src/app')
  assert.equal(findRepoWork(work, '/w/T-1/api')?.repo, '/src/api')
  assert.equal(findRepoWork(work, 'web'), undefined)
  const legacy: TaskWork = { dir: '/w/T-1', feedbackSeenAt: 0, repos: [repo('/src/app', '/w/T-1')] }
  assert.equal(repoWorkName(legacy, legacy.repos[0]), 'app', 'a pre-T-22 worktree is named after its repo')
  assert.equal(findRepoWork(legacy, 'app')?.repo, '/src/app')
})

test('prRollup', () => {
  const w = (...repos: RepoWork[]): TaskWork => ({ dir: 'd', feedbackSeenAt: 0, repos })
  const a = repo('a', 'd/a')
  const b = repo('b', 'd/b')
  const pr = (r: RepoWork, prState: RepoWork['prState']) => ({ ...r, prUrl: `https://github.com/o/${r.repo}/pull/1`, prState })
  assert.equal(prRollup(w(a, b), ['a']), null, 'no PR yet')
  assert.equal(prRollup(w(pr(a, 'open'), b), ['a']), 'review', 'the only changed repo has a PR')
  assert.equal(prRollup(w(pr(a, 'open'), b), ['a', 'b']), null, 'b has commits but no PR')
  assert.equal(prRollup(w(pr(a, 'open'), pr(b, 'open')), ['a', 'b']), 'review')
  assert.equal(prRollup(w(pr(a, 'merged'), pr(b, 'open')), ['a', 'b']), 'review', 'waits for every PR')
  assert.equal(prRollup(w(pr(a, 'merged'), pr(b, 'merged')), []), 'done')
  assert.equal(prRollup(w(pr(a, 'merged'), pr(b, 'closed')), []), 'closed', 'closed without merge')
})

test('canMoveInPlan: only between not-started todo tasks', () => {
  const work: TaskWork = { dir: 'w', feedbackSeenAt: 0, repos: [repo('r', 'w/r')] }
  const tasks = [
    task('run', 'in_progress', 0, { work }),
    task('a', 'todo', 1, { work }),
    task('b', 'todo', 2),
    task('c', 'todo', 3),
    task('x', 'grooming', 4),
  ]
  const t = (id: string) => tasks.find((x) => x.id === id)!
  assert.equal(canMoveInPlan(t('c'), tasks, 'up'), true)
  assert.equal(canMoveInPlan(t('b'), tasks, 'down'), true)
  assert.equal(canMoveInPlan(t('c'), tasks, 'down'), false, 'last one')
  assert.equal(canMoveInPlan(t('b'), tasks, 'up'), false, 'a has started work')
  assert.equal(canMoveInPlan(t('a'), tasks, 'down'), false, 'a has started work')
  assert.equal(canMoveInPlan(t('run'), tasks, 'down'), false)
  assert.equal(canMoveInPlan(t('x'), tasks, 'up'), false, 'not todo')
})

test('canMoveInPlan: in-progress tasks between todo tasks do not block reordering', () => {
  const tasks = [task('a', 'todo', 1), task('run', 'in_progress', 2), task('b', 'todo', 3)]
  const t = (id: string) => tasks.find((x) => x.id === id)!
  assert.equal(canMoveInPlan(t('b'), tasks, 'up'), true)
  assert.equal(canMoveInPlan(t('a'), tasks, 'down'), true)
  assert.equal(canMoveInPlan(t('a'), tasks, 'up'), false, 'first todo')
})

test('canMoveSubtask: a legacy checklist moves freely, done or not', () => {
  const tasks = [task('p', 'in_progress', 0, { work: { repos: [], dir: 'd', feedbackSeenAt: 0 } }), sub('s1', 'p', 'done', 0), sub('s2', 'p', 'todo', 1), sub('s3', 'p', 'todo', 2), sub('o', 'other', 'todo', 0)]
  const t = (id: string) => tasks.find((x) => x.id === id)!
  assert.equal(canMoveSubtask(t('s2'), tasks, 'up'), true, 'past a done one')
  assert.equal(canMoveSubtask(t('s1'), tasks, 'down'), true)
  assert.equal(canMoveSubtask(t('s3'), tasks, 'down'), false, 'last one')
  assert.equal(canMoveSubtask(t('o'), tasks, 'up'), false, 'first of its parent')
  assert.equal(canMoveSubtask(t('p'), tasks, 'down'), false, 'not a subtask')
})

test('canMoveSubtask: steps that started keep their place', () => {
  const tasks = [task('p', 'in_progress', 0), sub('s1', 'p', 'done', 0), sub('s2', 'p', 'in_progress', 1), sub('s3', 'p', 'todo', 2), sub('s4', 'p', 'todo', 3)]
  const t = (id: string) => tasks.find((x) => x.id === id)!
  assert.equal(canMoveSubtask(t('s3'), tasks, 'up'), false, 'past the current step')
  assert.equal(canMoveSubtask(t('s2'), tasks, 'down'), false, 'the current step')
  assert.equal(canMoveSubtask(t('s3'), tasks, 'down'), true)
  assert.equal(canMoveSubtask(t('s4'), tasks, 'up'), true)
})
