import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inbox, pipelineCounts, queueHead, taskChangeEvents, type AgentSession, type RepoWork, type Task, type TaskStatus, type TaskWork } from './index.ts'

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
const repo = (patch: Partial<RepoWork> = {}): RepoWork => ({ repo: 'r', branch: 'b', worktree: 'd/r', prUrl: null, prState: null, ...patch })
/** Work in one repo, or in several when more are given. */
const work = (patch: Partial<RepoWork> = {}, ...more: Partial<RepoWork>[]): TaskWork => ({
  repos: [repo(patch), ...more.map((m, i) => repo({ repo: `r${i + 2}`, worktree: `d/r${i + 2}`, ...m }))],
  dir: 'd',
  feedbackSeenAt: 0,
})
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
  assert.deepEqual(texts(task('t', 'in_progress'), task('t', 'in_review')), ['status:In review'], 'no PR recorded')
})

test('taskChangeEvents: a ticked subtask is not activity', () => {
  assert.deepEqual(texts(sub('s', 't', 'todo', 0), sub('s', 't', 'done', 0)), [])
})

test('taskChangeEvents: a check error in any repo', () => {
  assert.deepEqual(texts(task('t', 'in_review', 0, { work: work({}, {}) }), task('t', 'in_review', 0, { work: work({}, { checkError: 'r2 down' }) })), ['check_failed:r2 down'])
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
    sub('subtodo', 'groomed', 'todo', 0),
  ]
  const sessions = [session('failed', 'developer', 'error'), session('question', 'groomer', 'idle')]
  assert.deepEqual(
    inbox('p', tasks, sessions).map((i) => [i.task?.id, i.kind, i.text]),
    [
      ['failed', 'agent_failed', 'Developer failed'],
      ['check', 'check_failed', 'gh down'],
      ['question', 'question', 'which db?'],
      ['review', 'ready_to_merge', 'PR is ready to merge'],
      ['groomed', 'groomed', 'Groomed, ready to add to the plan'],
    ],
  )
})

test('inbox: ready to merge counts the PRs still open', () => {
  const two = task('t', 'in_review', 0, { work: work({ prUrl: 'u1', prState: 'open' }, { prUrl: 'u2', prState: 'open' }) })
  assert.equal(inbox('p', [two], [])[0]?.text, '2 PRs are ready to merge')
  const one = task('t', 'in_review', 0, { work: work({ prUrl: 'u1', prState: 'merged' }, { prUrl: 'u2', prState: 'open' }) })
  assert.equal(inbox('p', [one], [])[0]?.text, 'PR is ready to merge')
})

test('inbox: agent_failed only from the latest groomer/developer session', () => {
  const t = task('t', 'backlog')
  assert.deepEqual(inbox('p', [t], [session('t', 'groomer', 'error'), session('t', 'groomer', 'idle')]), [])
  assert.equal(inbox('p', [t], [session('t', 'groomer', 'idle'), session('t', 'groomer', 'error')])[0]?.kind, 'agent_failed')
  assert.deepEqual(inbox('p', [t], [session('t', 'reviewer', 'error')]), [], 'other roles do not count')
})

test('inbox: pending approvals from task sessions and chats come first, one per item', () => {
  const approval = (id: string, status: 'pending' | 'allowed' | 'denied' | 'expired') =>
    ({ kind: 'approval', id, tool: 'execute', server: 'Cloudflare', input: {}, status, at: 0 }) as const
  const dev = { ...session('t', 'developer', 'running'), items: [approval('a1', 'pending'), approval('a2', 'allowed')] }
  const chat = { ...session('', 'chat', 'running'), id: 'chat', taskId: null, items: [approval('a3', 'pending'), approval('a4', 'expired')] }
  const other = { ...session('', 'chat', 'running'), id: 'other', projectId: 'q', taskId: null, items: [approval('a5', 'pending')] }
  const t = task('t', 'in_progress', 0, { needsInput: 'q' })
  const items = inbox('p', [t], [dev, chat, other])
  assert.deepEqual(
    items.map((i) => [i.kind, i.task?.id ?? null, i.session?.id, i.approvalId ?? null, i.text]),
    [
      ['approval', 't', 't-developer', 'a1', 'wants Cloudflare · execute'],
      ['approval', null, 'chat', 'a3', 'wants Cloudflare · execute'],
      ['question', 't', 't-developer', null, 'q'],
    ],
  )
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
    sub('fs', 'f', 'todo', 0),
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

test('queueHead: subtasks are not units', () => {
  const tasks = [task('t1', 'in_progress', 0), sub('s1', 't1', 'done', 0), sub('s2', 't1', 'todo', 1), task('t2', 'planned', 1), sub('t2s', 't2', 'todo', 0)]
  assert.deepEqual(ids(queueHead(tasks)), { current: 't1', next: 't2' })
})

test('queueHead: current task and the next task', () => {
  assert.deepEqual(ids(queueHead([task('t1', 'in_review', 0), task('t2', 'planned', 1)])), { current: 't1', next: 't2' })
  assert.deepEqual(ids(queueHead([task('t1', 'in_progress', 0)])), { current: 't1', next: null })
})

function ids(h: { current: Task | null; next: Task | null }) {
  return { current: h.current?.id ?? null, next: h.next?.id ?? null }
}
