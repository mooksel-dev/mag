import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canMoveInPlan, canMoveSubtask, findRepoWork, nextPlanRank, nextWork, planBlockers, planQueue, prRollup, repoDirNames, repoWorkName, subtaskProgress, type RepoWork, type Task, type TaskStatus, type TaskWork } from './index.ts'

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
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})
const sub = (id: string, parentId: string, status: TaskStatus, rank: number, patch: Partial<Task> = {}) =>
  task(id, status, rank, { parentId, ...patch })
const repo = (path: string, worktree: string): RepoWork => ({ repo: path, branch: 'b', worktree, prUrl: null, prState: null })

test('planQueue: top-level plan tasks by rank', () => {
  const tasks = [task('b', 'planned', 2), task('a', 'done', 1), task('c', 'groomed', 0), sub('s', 'b', 'todo', 0)]
  assert.deepEqual(planQueue(tasks).map((t) => t.id), ['a', 'b'])
})

test('nextPlanRank: after the last plan task, ignoring backlog and subtasks', () => {
  assert.equal(nextPlanRank([]), 1)
  assert.equal(nextPlanRank([task('c', 'groomed', 9)]), 1)
  const tasks = [task('a', 'done', 1), task('b', 'planned', 3), task('c', 'groomed', 9), sub('s', 'b', 'todo', 7)]
  assert.equal(nextPlanRank(tasks), 4)
})

test('planBlockers', () => {
  assert.deepEqual(planBlockers(task('a', 'groomed', 0)), [])
  assert.deepEqual(planBlockers(task('a', 'backlog', 0, { needsInput: 'q' })), ['not groomed yet', 'agent is waiting for input'])
  assert.deepEqual(planBlockers(sub('s', 'a', 'todo', 0)), ['subtasks are planned with their task', 'not groomed yet'])
})

test('nextWork: the unit is the task, never a subtask', () => {
  const tasks = [
    task('t1', 'done', 0),
    task('t2', 'planned', 1),
    sub('s2', 't2', 'todo', 1),
    sub('s1', 't2', 'todo', 0),
    task('t3', 'planned', 2),
  ]
  assert.equal(nextWork(tasks)?.id, 't2')
  assert.equal(nextWork([task('t1', 'planned', 1), task('t0', 'planned', 0)])?.id, 't0')
})

test('nextWork: one task at a time, whatever its subtasks say', () => {
  assert.equal(nextWork([task('t1', 'in_review', 0), task('t2', 'planned', 1)]), null)
  assert.equal(nextWork([task('t1', 'in_progress', 0), sub('s1', 't1', 'done', 0), task('t2', 'planned', 1)]), null)
})

test('nextWork moves on once the task is done', () => {
  assert.equal(nextWork([task('t1', 'done', 0), sub('s1', 't1', 'todo', 0), task('t2', 'planned', 1)])?.id, 't2')
})

test('nextWork waits on a task that needs input', () => {
  assert.equal(nextWork([task('t1', 'planned', 0, { needsInput: 'x' }), task('t2', 'planned', 1)]), null)
})

test('nextWork: empty or finished plan', () => {
  assert.equal(nextWork([]), null)
  assert.equal(nextWork([task('t1', 'done', 0), task('b', 'groomed', 1)]), null)
})

test('subtaskProgress', () => {
  const tasks = [task('t', 'in_progress', 0), sub('a', 't', 'done', 0), sub('b', 't', 'todo', 1), sub('c', 'x', 'done', 0)]
  assert.deepEqual(subtaskProgress('t', tasks), { done: 1, total: 2 })
  assert.deepEqual(subtaskProgress('none', tasks), { done: 0, total: 0 })
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
  assert.equal(prRollup(w(pr(a, 'open'), b), ['a']), 'in_review', 'the only changed repo has a PR')
  assert.equal(prRollup(w(pr(a, 'open'), b), ['a', 'b']), null, 'b has commits but no PR')
  assert.equal(prRollup(w(pr(a, 'open'), pr(b, 'open')), ['a', 'b']), 'in_review')
  assert.equal(prRollup(w(pr(a, 'merged'), pr(b, 'open')), ['a', 'b']), 'in_review', 'waits for every PR')
  assert.equal(prRollup(w(pr(a, 'merged'), pr(b, 'merged')), []), 'done')
  assert.equal(prRollup(w(pr(a, 'merged'), pr(b, 'closed')), []), 'in_progress', 'closed without merge')
})

test('canMoveInPlan: only between not-started tasks', () => {
  const work: TaskWork = { dir: 'w', feedbackSeenAt: 0, repos: [repo('r', 'w/r')] }
  const tasks = [
    task('done', 'done', 0),
    task('a', 'planned', 1, { work }),
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

test('canMoveSubtask: any step of the checklist, done or not', () => {
  const tasks = [task('p', 'in_progress', 0), sub('s1', 'p', 'done', 0), sub('s2', 'p', 'todo', 1), sub('s3', 'p', 'todo', 2), sub('o', 'other', 'todo', 0)]
  const t = (id: string) => tasks.find((x) => x.id === id)!
  assert.equal(canMoveSubtask(t('s2'), tasks, 'up'), true, 'past a done one')
  assert.equal(canMoveSubtask(t('s1'), tasks, 'down'), true)
  assert.equal(canMoveSubtask(t('s3'), tasks, 'down'), false, 'last one')
  assert.equal(canMoveSubtask(t('o'), tasks, 'up'), false, 'first of its parent')
  assert.equal(canMoveSubtask(t('p'), tasks, 'down'), false, 'not a subtask')
})
