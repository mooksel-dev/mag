import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inbox, pipelineCounts, queueHead, taskChangeEvents, type AgentSession, type Task, type TaskStatus, type TaskWork } from './index.ts'

const task = (id: string, status: TaskStatus, rank = 0, patch: Partial<Task> = {}): Task => ({
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
const sub = (id: string, parentId: string, status: TaskStatus, rank: number) => task(id, status, rank, { parentId })
const work = (patch: Partial<TaskWork> = {}): TaskWork => ({ repo: 'r', branch: 'b', worktree: 'w', prUrl: null, feedbackSeenAt: 0, ...patch })
const session = (taskId: string, role: AgentSession['role'], status: AgentSession['status']): AgentSession => ({
  id: `${taskId}-${role}`,
  projectId: 'p',
  taskId,
  role,
  agent: 'claude-code',
  nativeSessionId: null,
  status,
  items: [],
  createdAt: 0,
})

const texts = (prev: Task, next: Task) => taskChangeEvents(prev, next).map((e) => `${e.kind}:${e.text}`)

test('taskChangeEvents: status change uses the label', () => {
  const events = taskChangeEvents(task('t', 'backlog'), task('t', 'grooming'))
  assert.deepEqual(events, [{ projectId: 'p', taskId: 't', taskKey: 't', kind: 'status', text: 'Grooming' }])
})

test('taskChangeEvents: PR opened and merged', () => {
  const pr = work({ prUrl: 'https://x/pr/1' })
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: pr }), task('t', 'in_review', 0, { work: pr })), ['status:PR opened'])
  assert.deepEqual(texts(task('t', 'in_review', 0, { work: pr }), task('t', 'done', 0, { work: pr })), ['status:merged'])
  assert.deepEqual(texts(task('t', 'in_progress'), task('t', 'in_review')), ['status:In review'], 'rollup without a PR')
})

test('taskChangeEvents: needsInput set and changed, not cleared', () => {
  assert.deepEqual(texts(task('t', 'grooming'), task('t', 'grooming', 0, { needsInput: 'q1' })), ['needs_input:q1'])
  assert.deepEqual(texts(task('t', 'grooming', 0, { needsInput: 'q1' }), task('t', 'grooming', 0, { needsInput: 'q2' })), ['needs_input:q2'])
  assert.deepEqual(texts(task('t', 'grooming', 0, { needsInput: 'q1' }), task('t', 'grooming')), [])
})

test('taskChangeEvents: checkError set and changed', () => {
  assert.deepEqual(texts(task('t', 'in_review', 0, { work: work() }), task('t', 'in_review', 0, { work: work({ checkError: 'gh failed' }) })), ['check_failed:gh failed'])
  assert.deepEqual(texts(task('t', 'in_review', 0, { work: work({ checkError: 'a' }) }), task('t', 'in_review', 0, { work: work({ checkError: 'b' }) })), ['check_failed:b'])
  assert.deepEqual(texts(task('t', 'in_review', 0, { work: work({ checkError: 'a' }) }), task('t', 'in_review', 0, { work: work({ checkError: null }) })), [])
})

test('taskChangeEvents: nothing changes, nothing logged', () => {
  const t = task('t', 'in_review', 0, { needsInput: 'q', work: work({ checkError: 'e', prUrl: 'u' }) })
  assert.deepEqual(taskChangeEvents(t, { ...t, title: 'renamed', rank: 5 }), [])
})

test('inbox: one item per task, by priority', () => {
  const tasks = [
    task('groomed', 'groomed'),
    task('review', 'in_review', 0, { work: work({ prUrl: 'u' }) }),
    task('question', 'grooming', 0, { needsInput: 'which db?' }),
    task('check', 'in_review', 0, { needsInput: 'q', work: work({ prUrl: 'u', checkError: 'gh down' }) }),
    task('failed', 'in_progress', 0, { needsInput: 'Developer agent failed; check the chat', work: work() }),
    task('quiet', 'planned'),
    sub('subgroomed', 'groomed', 'groomed', 0),
  ]
  const sessions = [session('failed', 'developer', 'error'), session('question', 'groomer', 'idle')]
  assert.deepEqual(
    inbox(tasks, sessions).map((i) => [i.task.id, i.kind, i.text]),
    [
      ['failed', 'agent_failed', 'Developer failed'],
      ['check', 'check_failed', 'gh down'],
      ['question', 'question', 'which db?'],
      ['review', 'ready_to_merge', 'PR is ready to merge'],
      ['groomed', 'groomed', 'Groomed, ready to add to the plan'],
    ],
  )
})

test('inbox: agent_failed only from the latest groomer/developer session', () => {
  const t = task('t', 'backlog')
  assert.deepEqual(inbox([t], [session('t', 'groomer', 'error'), session('t', 'groomer', 'idle')]), [])
  assert.equal(inbox([t], [session('t', 'groomer', 'idle'), session('t', 'groomer', 'error')])[0]?.kind, 'agent_failed')
  assert.deepEqual(inbox([t], [session('t', 'reviewer', 'error')]), [], 'other roles do not count')
})

test('pipelineCounts: top-level only, done in the last 7 days', () => {
  const now = 100 * 24 * 3600 * 1000
  const day = 24 * 3600 * 1000
  const tasks = [
    task('a', 'backlog'),
    task('b', 'backlog'),
    task('c', 'grooming'),
    task('d', 'groomed'),
    task('e', 'planned'),
    task('f', 'in_progress'),
    sub('fs', 'f', 'in_review', 0),
    task('g', 'in_review'),
    task('h', 'done', 0, { updatedAt: now - 2 * day }),
    task('i', 'done', 0, { updatedAt: now - 8 * day }),
    sub('hs', 'h', 'done', 0),
  ]
  assert.deepEqual(pipelineCounts(tasks, now), { backlog: 2, grooming: 1, groomed: 1, planned: 1, in_progress: 1, in_review: 1, done7d: 1 })
})

test('queueHead: no current unit', () => {
  const tasks = [task('t1', 'done', 0), task('t2', 'planned', 1), task('t3', 'planned', 2), task('x', 'groomed', 3)]
  assert.deepEqual(ids(queueHead(tasks)), { current: null, next: 't2' })
  assert.deepEqual(ids(queueHead([])), { current: null, next: null })
})

test('queueHead: current subtask and the next one', () => {
  const tasks = [
    task('t1', 'in_progress', 0),
    sub('s1', 't1', 'done', 0),
    sub('s2', 't1', 'in_review', 1),
    sub('s3', 't1', 'planned', 2),
    task('t2', 'planned', 1),
  ]
  assert.deepEqual(ids(queueHead(tasks)), { current: 's2', next: 's3' })
})

test('queueHead: current task and the next task', () => {
  const tasks = [task('t1', 'in_review', 0), task('t2', 'planned', 1), sub('t2s', 't2', 'planned', 0)]
  assert.deepEqual(ids(queueHead(tasks)), { current: 't1', next: 't2s' })
  assert.deepEqual(ids(queueHead([task('t1', 'in_progress', 0)])), { current: 't1', next: null })
})

function ids(h: { current: Task | null; next: Task | null }) {
  return { current: h.current?.id ?? null, next: h.next?.id ?? null }
}
