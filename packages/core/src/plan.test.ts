import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canMoveSubtask, devRunOutcome, findRepoWork, prRollup, prsMerged, repoDirNames, repoWorkName, subtaskProgress, subtaskStatusChanges, taskByKey, titleSlug, workKey, type RepoWork, type Task, type WorkState, type SubtaskStatus, type TaskWork } from './index.ts'

const task = (id: string, status: WorkState | SubtaskStatus, rank: number, patch: Partial<Task> = {}): Task => ({
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
const sub = (id: string, parentId: string, status: WorkState | SubtaskStatus, rank: number, patch: Partial<Task> = {}) =>
  task(id, status, rank, { parentId, ...patch })
const repo = (path: string, worktree: string): RepoWork => ({ repo: path, branch: 'b', worktree, prUrl: null, prState: null })

test('workKey: the first ticket key, else a slug of the title; taken keys get a suffix (T-55.7)', () => {
  assert.equal(workKey('Fix login', [{ url: 'https://x/browse/ABC-12', key: 'ABC-12' }], []), 'ABC-12')
  assert.equal(workKey('Fix login', [{ url: 'https://x/a' }, { url: 'https://x/b', key: 'XY-3' }], []), 'XY-3', 'the first ticket with a key')
  assert.equal(workKey('Fix the login page', [], []), 'fix-the-login-page')
  assert.equal(workKey('Fix login', [{ url: 'https://x/a' }], []), 'fix-login', 'a ticket without a key')
  assert.equal(workKey('Fix login', undefined, ['fix-login', 'FIX-LOGIN-2']), 'fix-login-3', 'taken in any case')
  assert.equal(workKey('x', [{ url: 'u', key: 'abc 1.2' }], []), 'abc-1-2', 'no dots or spaces: step keys and branches stay clean')
})

test('titleSlug: ASCII words, Cyrillic transliterated, short', () => {
  assert.equal(titleSlug('Remove task management!'), 'remove-task-management')
  assert.equal(titleSlug('Прибрати таск-менеджмент'), 'prybraty-task-menedzhment')
  assert.equal(titleSlug('one two three four five six seven'), 'one-two-three-four-five')
  assert.equal(titleSlug('a'.repeat(60)), 'a'.repeat(40))
  assert.equal(titleSlug('🙂 ?'), 'work')
})

test('taskByKey: any case', () => {
  const tasks = [task('ABC-12', 'ready', 0), task('fix-login', 'planning', 0)]
  assert.equal(taskByKey(tasks, 'abc-12')?.id, 'ABC-12')
  assert.equal(taskByKey(tasks, ' FIX-LOGIN ')?.id, 'fix-login')
  assert.equal(taskByKey(tasks, 'T-1'), undefined)
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

test('prsMerged', () => {
  const w = (...repos: RepoWork[]): TaskWork => ({ dir: 'd', feedbackSeenAt: 0, repos })
  const a = repo('a', 'd/a')
  const b = repo('b', 'd/b')
  const pr = (r: RepoWork, prState: RepoWork['prState']) => ({ ...r, prUrl: `https://github.com/o/${r.repo}/pull/1`, prState })
  assert.equal(prsMerged(w(a, b), []), false, 'no PR')
  assert.equal(prsMerged(w(pr(a, 'merged'), b), ['a']), true)
  assert.equal(prsMerged(w(pr(a, 'merged'), b), ['a', 'b']), false, 'b has commits but no PR')
  assert.equal(prsMerged(w(pr(a, 'merged'), pr(b, 'open')), ['a', 'b']), false, 'waits for every PR')
  assert.equal(prsMerged(w(pr(a, 'merged'), pr(b, 'closed')), ['a']), false, 'closed without merge')
})

test('devRunOutcome', () => {
  const w = (...repos: RepoWork[]): TaskWork => ({ dir: 'd', feedbackSeenAt: 0, repos })
  const a = repo('a', 'd/a')
  const b = repo('b', 'd/b')
  const pr = (r: RepoWork, prState: RepoWork['prState']) => ({ ...r, prUrl: `https://github.com/o/${r.repo}/pull/1`, prState })
  const needs = (reason: string) => ({ kind: 'needsInput', reason })
  // changedRepos counts a merged repo as changed even with nothing left on the branch.
  assert.deepEqual(devRunOutcome(w(pr(a, 'merged'), b), ['a'], false, true), { kind: 'complete' }, 'PR merged during the run')
  assert.deepEqual(devRunOutcome(w(pr(a, 'merged'), b), ['a'], true, true), { kind: 'complete' }, 'merged wins over a failed run')
  assert.deepEqual(devRunOutcome(w(pr(a, 'open'), pr(b, 'open')), ['a', 'b'], false, true), { kind: 'review' })
  assert.deepEqual(devRunOutcome(w(pr(a, 'merged'), b), ['a', 'b'], false, true), needs('Developer stopped without a PR for b'))
  assert.deepEqual(devRunOutcome(w(pr(a, 'open'), b), ['a'], true, true), needs('Developer agent failed; check the chat'))
  assert.deepEqual(devRunOutcome(w(a, b), ['a'], false, true), needs('Developer stopped without opening a PR or completing the step'))
  assert.deepEqual(devRunOutcome(null, [], false, false), needs('Developer stopped without opening a PR'))
  assert.deepEqual(devRunOutcome(w(pr(a, 'closed'), b), [], false, true), needs('Developer stopped without opening a PR'))
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
