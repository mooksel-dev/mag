import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentState, canApprove, canReopen, currentStep, inbox, isLegacy, localCheckText, localHolder, localOptions, openLocalChecks, openPrs, projectRepo, projectState, repoNames, stepBranch, stepDir, stepRepoNames, stepRepos, stepRollup, taskChangeEvents, taskPrs, taskRepos, type RepoWork, type Task, type WorkState, type SubtaskStatus, type TaskWork } from './index.ts'

const task = (id: string, status: WorkState | SubtaskStatus, patch: Partial<Task> = {}): Task => ({
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
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})
const step = (id: string, status: WorkState | SubtaskStatus, rank: number, patch: Partial<Task> = {}) => task(id, status, { parentId: 'T', key: `T.${rank}`, rank, ...patch })
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

test('canApprove: at least one step', () => {
  assert.deepEqual(canApprove(task('T', 'planning'), []), { ok: false, reason: 'Add at least one step' })
  assert.deepEqual(canApprove(task('T', 'planning'), [step('a', 'todo', 1)]), { ok: true })
  assert.equal(canApprove(step('a', 'todo', 1), []).ok, false)
  // A reopened work (T-55.6) needs a step for what is left.
  assert.deepEqual(canApprove(task('T', 'planning'), [step('a', 'done', 1)]), { ok: false, reason: 'Every step is done: add a step for what is left' })
  assert.deepEqual(canApprove(task('T', 'planning'), [step('a', 'done', 1), step('b', 'todo', 2)]), { ok: true })
})

test('canReopen: a done work with steps; not a step, a legacy task or one not done (T-55.6)', () => {
  assert.equal(canReopen(task('T', 'done')), true)
  assert.equal(canReopen(task('T', 'canceled')), false)
  assert.equal(canReopen(task('T', 'in_progress')), false)
  assert.equal(canReopen(step('a', 'done', 1)), false)
  assert.equal(canReopen(task('T', 'done', { work: work({}) })), false)
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

test('stepRepos: the step\'s own repositories in project order, else every one; removed repositories are left out (T-50)', () => {
  const project = { repos: ['/w/app', '/w/api', '/x/app'] }
  assert.deepEqual(stepRepos(step('a', 'todo', 1), project), project.repos, 'an older step works in every repository')
  assert.deepEqual(stepRepos(step('a', 'todo', 1, { repos: [] }), project), [], 'a step without code')
  assert.deepEqual(stepRepos(step('a', 'todo', 1, { repos: ['/x/app', '/gone', '/w/app'] }), project), ['/w/app', '/x/app'])
  assert.deepEqual(stepRepoNames(step('a', 'todo', 1, { repos: ['/x/app', '/w/api'] }), project), ['api', 'app-2'])
  assert.equal(stepRepoNames(step('a', 'todo', 1), project), undefined)
})

test('projectRepo: a project repository by short name or path', () => {
  const project = { repos: ['/w/app', '/w/api', '/x/app'] }
  assert.deepEqual(repoNames(project), ['app', 'api', 'app-2'])
  assert.equal(projectRepo(project, ' api '), '/w/api')
  assert.equal(projectRepo(project, 'app-2'), '/x/app')
  assert.equal(projectRepo(project, '/x/app/'), '/x/app')
  assert.equal(projectRepo(project, 'web'), undefined)
})

test('taskRepos: repositories of the steps not done yet, in project order (T-50)', () => {
  const project = { repos: ['/w/app', '/w/api', '/w/web'] }
  const tasks = [task('T', 'ready'), step('a', 'done', 1, { repos: ['/w/web'] }), step('b', 'todo', 2, { repos: ['/w/api'] }), step('c', 'todo', 3, { repos: ['/w/app', '/w/api'] })]
  assert.deepEqual(taskRepos('T', tasks, project), ['/w/app', '/w/api'])
  assert.deepEqual(taskRepos('T', [task('T', 'ready'), step('a', 'todo', 1)], project), project.repos, 'an older step: every repository')
  assert.deepEqual(taskRepos('T', [task('T', 'ready'), step('a', 'todo', 1, { repos: [] })], project), [])
})

test('localOptions / localCheckText: the card of a local check (T-50)', () => {
  const check = { repo: '/w/app', busyBy: null, dirty: [] as string[], branch: null as string | null }
  assert.deepEqual(localOptions({ ...check, busyBy: 'T-2.1', dirty: ['a'] }), ['worktree', 'wait'], 'busy wins')
  assert.deepEqual(localOptions({ ...check, dirty: ['a'], branch: 'x' }), ['stash', 'ignore', 'worktree', 'discuss'])
  assert.deepEqual(localOptions({ ...check, branch: 'x' }), ['switch', 'worktree', 'discuss'])
  assert.deepEqual(localOptions(check), [])
  assert.equal(localCheckText({ ...check, busyBy: 'T-2.1' }, 'main'), 'app is used locally by T-2.1')
  assert.equal(localCheckText({ ...check, branch: 'x' }, 'main'), 'app is on branch x, not main')
  assert.equal(localCheckText({ ...check, dirty: ['a', 'b'], branch: 'x' }, 'main'), 'app has uncommitted changes: a, b; it is on branch x')
  assert.equal(localCheckText({ ...check, dirty: ['1', '2', '3', '4', '5', '6', '7'] }, 'main'), 'app has uncommitted changes: 1, 2, 3, 4, 5 and 2 more')
  assert.deepEqual(openLocalChecks({ localChecks: [{ ...check, branch: 'x', discuss: true }, { ...check, repo: '/w/api', branch: 'y' }] }).map((c) => c.repo), ['/w/api'])
})

test('localHolder: a step working in the main checkout holds it until done or canceled (T-50)', () => {
  const local = work({ repo: '/w/app', worktree: '/w/app', local: true })
  const holding = step('a', 'in_progress', 1, { work: local })
  assert.equal(localHolder('/w/app', [task('T', 'in_progress'), holding])?.id, 'a')
  assert.equal(localHolder('/w/api', [task('T', 'in_progress'), holding]), null)
  assert.equal(localHolder('/w/app', [task('T', 'in_progress'), { ...holding, status: 'done' }]), null)
  assert.equal(localHolder('/w/app', [task('T', 'canceled'), holding]), null)
  assert.equal(localHolder('/w/app', [task('T', 'in_progress'), step('a', 'in_progress', 1, { work: work({ repo: '/w/app' }) })]), null, 'a worktree holds nothing')
  assert.equal(localHolder('/w/app', [task('T', 'in_progress'), { ...holding, waitingFor: { key: 'X', repo: '/w/app' } }]), null, 'a waiting step')
  const asking = { ...holding, localChecks: [{ repo: '/w/app', busyBy: null, dirty: ['f'], branch: null }] }
  assert.equal(localHolder('/w/app', [task('T', 'in_progress'), asking]), null, 'a step still asking about it')
})

test('agentState: a step waiting for another one\'s local repository (T-50)', () => {
  const T = task('T', 'in_progress')
  const tasks = [T, step('a', 'in_progress', 1, { waitingFor: { key: 'T-9.1', repo: '/w/app' } })]
  assert.deepEqual(agentState(T, [], tasks), { kind: 'waiting', reason: 'Waiting for T-9.1 (app)' })
})
