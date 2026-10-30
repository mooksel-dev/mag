import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentState, canMoveToTodo, currentStep, inbox, isLegacy, openPrs, projectState, stepBranch, stepDir, stepRollup, taskChangeEvents, taskPrs, type RepoWork, type Task, type TaskStatus, type TaskWork } from './index.ts'

const task = (id: string, status: TaskStatus, patch: Partial<Task> = {}): Task => ({
  id,
  projectId: 'p',
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
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})
const step = (id: string, status: TaskStatus, rank: number, patch: Partial<Task> = {}) => task(id, status, { parentId: 'T', key: `T.${rank}`, rank, ...patch })
const work = (...repos: Partial<RepoWork>[]): TaskWork => ({
  repos: repos.map((r, i) => ({ repo: `r${i}`, branch: 'b', worktree: `d/r${i}`, prUrl: null, prState: null, ...r })),
  dir: 'd',
  feedbackSeenAt: 0,
})

test('currentStep: the first step not done, in order', () => {
  const tasks = [task('T', 'in_progress'), step('b', 'todo', 2), step('a', 'done', 1), step('c', 'todo', 3)]
  assert.equal(currentStep('T', tasks)?.id, 'b')
  assert.equal(currentStep('T', tasks.map((t) => ({ ...t, status: 'done' }))), null)
  assert.equal(currentStep('x', tasks), null, 'no steps')
})

test('canMoveToTodo: at least one step', () => {
  assert.deepEqual(canMoveToTodo(task('T', 'grooming'), []), { ok: false, reason: 'Add at least one step' })
  assert.deepEqual(canMoveToTodo(task('T', 'grooming'), [step('a', 'todo', 1)]), { ok: true })
  assert.equal(canMoveToTodo(step('a', 'todo', 1), []).ok, false)
})

test('stepBranch and stepDir', () => {
  assert.equal(stepBranch('T-41.3'), 'mag/t-41-3')
  assert.equal(stepDir('/w/', 'p1', 'T-41.3'), '/w/p1/T-41.3')
})

test('isLegacy: a top-level task with work of its own', () => {
  assert.equal(isLegacy(task('T', 'in_progress', { work: work({}) })), true)
  assert.equal(isLegacy(task('T', 'in_progress')), false)
  assert.equal(isLegacy(step('a', 'in_progress', 1, { work: work({}) })), false)
})

test('stepRollup: prRollup of the step work', () => {
  assert.equal(stepRollup(step('a', 'todo', 1), []), null)
  assert.equal(stepRollup(step('a', 'in_progress', 1, { work: work({ prUrl: 'u', prState: 'merged' }) }), ['r0']), 'done')
  assert.equal(stepRollup(step('a', 'in_progress', 1, { work: work({ prUrl: 'u', prState: 'open' }, {}) }), ['r0', 'r1']), null)
})

test('taskPrs / openPrs collect the steps PRs', () => {
  const tasks = [task('T', 'in_progress'), step('a', 'done', 1, { work: work({ prUrl: 'u1', prState: 'merged' }) }), step('b', 'in_progress', 2, { work: work({ prUrl: 'u2', prState: 'open' }) })]
  assert.deepEqual(taskPrs(tasks[0], tasks).map((r) => r.prUrl), ['u1', 'u2'])
  assert.deepEqual(openPrs(tasks[0], tasks).map((r) => r.prUrl), ['u2'])
  assert.deepEqual(taskPrs(tasks[0]), [], 'without tasks: only its own')
})

test('agentState / inbox: the current step waits for merge or for Start', () => {
  const T = task('T', 'in_progress')
  const merging = [T, step('a', 'done', 1), step('b', 'in_progress', 2, { work: work({ prUrl: 'u', prState: 'open' }) })]
  assert.deepEqual(agentState(T, [], merging), { kind: 'waiting', reason: 'T.2: PR waits for merge' })
  assert.deepEqual(inbox('p', merging, []).map((i) => [i.task?.id, i.kind, i.text]), [['T', 'ready_to_merge', 'T.2: PR is ready to merge']])
  assert.equal(projectState('p', merging, [{ id: 's', projectId: 'p', taskId: 'T', role: 'developer', agent: 'claude-code', nativeSessionId: null, status: 'running', items: [], createdAt: 0 }]), 'in_review')

  const starting = [T, step('a', 'done', 1), step('b', 'todo', 2, { startManually: true })]
  assert.deepEqual(agentState(T, [], starting), { kind: 'waiting', reason: 'T.2 waits for Start' })
  assert.deepEqual(inbox('p', starting, []).map((i) => i.kind), ['ready_to_start'])

  const auto = [T, step('a', 'done', 1), step('b', 'todo', 2)]
  assert.equal(agentState(T, [], auto), null, 'the next step starts on its own')
  assert.deepEqual(inbox('p', auto, []), [])
})

test('inbox: a step PR check failure shows on its task once', () => {
  const tasks = [task('T', 'in_progress'), step('a', 'in_progress', 1, { work: work({ prUrl: 'u', prState: 'open', checkError: 'gh failed' }) })]
  assert.deepEqual(inbox('p', tasks, []).map((i) => [i.task?.id, i.kind]), [['T', 'check_failed']])
})

test('taskChangeEvents: a step merged is logged, other step status changes are not', () => {
  const s = step('a', 'in_progress', 1, { work: work({ prUrl: 'u', prState: 'merged' }) })
  assert.deepEqual(taskChangeEvents(s, { ...s, status: 'done' }).map((e) => e.text), ['merged'])
  assert.deepEqual(taskChangeEvents({ ...s, status: 'todo', work: null }, { ...s, work: null }), [])
})
