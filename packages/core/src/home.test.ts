import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeSections, agentState, archivedTasks, autoArchiveDue, backlogTasks, inbox, pipelineCounts, runningAgents, taskChangeEvents, viewCounts, type AgentSession, type RepoWork, type Task, type TaskStatus, type TaskWork } from './index.ts'

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
  archivedAt: null,
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
  const pr = work({ prUrl: 'https://x/pr/1', prState: 'open' })
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: work() }), task('t', 'in_progress', 0, { work: pr })), ['status:PR opened'])
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: pr }), task('t', 'in_progress', 0, { work: pr })), [], 'already known')
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: pr }), task('t', 'done', 0, { work: pr })), ['status:merged'])
  assert.deepEqual(texts(task('t', 'in_progress'), task('t', 'done')), ['status:Done'], 'no PR recorded')
})

test('taskChangeEvents: canceled, with the reason', () => {
  assert.deepEqual(texts(task('t', 'todo'), task('t', 'canceled', 0, { cancelReason: 'dup of T-1' })), ['status:Canceled: dup of T-1'])
  assert.deepEqual(texts(task('t', 'todo'), task('t', 'canceled')), ['status:Canceled'])
})

test('taskChangeEvents: a ticked subtask is not activity', () => {
  assert.deepEqual(texts(sub('s', 't', 'todo', 0), sub('s', 't', 'done', 0)), [])
})

test('taskChangeEvents: a check error in any repo', () => {
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: work({}, {}) }), task('t', 'in_progress', 0, { work: work({}, { checkError: 'r2 down' }) })), ['check_failed:r2 down'])
})

test('taskChangeEvents: needsInput set and changed, not cleared', () => {
  assert.deepEqual(texts(task('t', 'grooming'), task('t', 'grooming', 0, { needsInput: 'q1' })), ['needs_input:q1'])
  assert.deepEqual(texts(task('t', 'grooming', 0, { needsInput: 'q1' }), task('t', 'grooming', 0, { needsInput: 'q2' })), ['needs_input:q2'])
  assert.deepEqual(texts(task('t', 'grooming', 0, { needsInput: 'q1' }), task('t', 'grooming')), [])
})

test('taskChangeEvents: checkError set and changed', () => {
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: work() }), task('t', 'in_progress', 0, { work: work({ checkError: 'gh failed' }) })), ['check_failed:gh failed'])
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: work({ checkError: 'a' }) }), task('t', 'in_progress', 0, { work: work({ checkError: 'b' }) })), ['check_failed:b'])
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: work({ checkError: 'a' }) }), task('t', 'in_progress', 0, { work: work({ checkError: null }) })), [])
})

test('taskChangeEvents: nothing changes, nothing logged', () => {
  const t = task('t', 'in_progress', 0, { needsInput: 'q', work: work({ checkError: 'e', prUrl: 'u' }) })
  assert.deepEqual(taskChangeEvents(t, { ...t, title: 'renamed', rank: 5 }), [])
})

test('inbox: one item per task, by priority', () => {
  const tasks = [
    task('review', 'in_progress', 0, { work: work({ prUrl: 'u', prState: 'open' }) }),
    task('working', 'in_progress', 0, { work: work({ prUrl: 'u', prState: 'open' }) }),
    task('gone', 'canceled', 0, { needsInput: 'q' }),
    task('question', 'grooming', 0, { needsInput: 'which db?' }),
    task('check', 'in_progress', 0, { needsInput: 'q', work: work({ prUrl: 'u', checkError: 'gh down' }) }),
    task('failed', 'in_progress', 0, { needsInput: 'Developer agent failed; check the chat', work: work() }),
    task('quiet', 'todo'),
    sub('subtodo', 'quiet', 'todo', 0),
  ]
  const sessions = [session('failed', 'developer', 'error'), session('question', 'groomer', 'idle'), session('working', 'developer', 'running')]
  assert.deepEqual(
    inbox('p', tasks, sessions).map((i) => [i.task?.id, i.kind, i.text]),
    [
      ['failed', 'agent_failed', 'Developer failed'],
      ['check', 'check_failed', 'gh down'],
      ['question', 'question', 'which db?'],
      ['review', 'ready_to_merge', 'PR is ready to merge'],
    ],
  )
})

test('inbox: ready to merge counts the PRs still open', () => {
  const two = task('t', 'in_progress', 0, { work: work({ prUrl: 'u1', prState: 'open' }, { prUrl: 'u2', prState: 'open' }) })
  assert.equal(inbox('p', [two], [])[0]?.text, '2 PRs are ready to merge')
  const one = task('t', 'in_progress', 0, { work: work({ prUrl: 'u1', prState: 'merged' }, { prUrl: 'u2', prState: 'open' }) })
  assert.equal(inbox('p', [one], [])[0]?.text, 'PR is ready to merge')
})

test('inbox: agent_failed only from the latest groomer/developer session', () => {
  const t = task('t', 'backlog')
  assert.deepEqual(inbox('p', [t], [session('t', 'groomer', 'error'), session('t', 'groomer', 'idle')]), [])
  assert.equal(inbox('p', [t], [session('t', 'groomer', 'idle'), session('t', 'groomer', 'error')])[0]?.kind, 'agent_failed')
  assert.deepEqual(inbox('p', [t], [session('t', 'reviewer', 'error')]), [], 'other roles do not count')
})

test('inbox: a failed import is agent_failed until a later groomer runs', () => {
  const t: Task = { ...task('t', 'backlog'), tracker: { kind: 'jira', key: 'ABC-1', url: 'https://x.atlassian.net/browse/ABC-1', importedAt: null } }
  assert.deepEqual(inbox('p', [t], [session('t', 'tracker', 'error')]).map((i) => [i.kind, i.text]), [['agent_failed', 'Import failed']])
  assert.deepEqual(inbox('p', [t], [session('t', 'tracker', 'error'), session('t', 'groomer', 'idle')]), [])
})

test('inbox: a failed import is moot once unlinked', () => {
  assert.deepEqual(inbox('p', [task('t', 'backlog')], [session('t', 'tracker', 'error')]), [])
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
    task('d', 'todo'),
    task('e', 'todo'),
    task('f', 'in_progress'),
    sub('fs', 'f', 'todo', 0),
    task('g', 'canceled'),
    task('h', 'done', 0, { updatedAt: now - 2 * day }),
    task('i', 'done', 0, { updatedAt: now - 8 * day }),
    sub('hs', 'h', 'done', 0),
  ]
  assert.deepEqual(pipelineCounts(tasks, now), { backlog: 2, grooming: 1, todo: 2, in_progress: 1, done7d: 1 })
})

test('runningAgents: running sessions of any role and project', () => {
  const sessions = [session('t1', 'developer', 'running'), session('t2', 'groomer', 'running'), session('t3', 'developer', 'idle'), session('t4', 'developer', 'error'), { ...session('c', 'chat', 'running'), projectId: 'q', taskId: null }]
  assert.deepEqual(runningAgents(sessions).map((s) => s.id), ['t1-developer', 't2-groomer', 'c-chat'])
  assert.deepEqual(runningAgents([]), [])
})

test('agentState: working, waiting, or nothing', () => {
  const running = { ...session('t', 'developer', 'running'), runStartedAt: 42 }
  assert.deepEqual(agentState(task('t', 'in_progress'), [session('t', 'groomer', 'idle'), running], []), { kind: 'working', role: 'developer', since: 42 })
  assert.deepEqual(agentState(task('t', 'grooming', 0, { needsInput: 'Which DB?' }), [session('t', 'groomer', 'idle')], []), { kind: 'waiting', reason: 'Which DB?' })
  const pr = work({ prUrl: 'u', prState: 'open' })
  assert.deepEqual(agentState(task('t', 'in_progress', 0, { work: pr }), [session('t', 'developer', 'idle')], []), { kind: 'waiting', reason: 'PR waits for merge' })
  assert.equal(agentState(task('t', 'in_progress', 0, { work: pr }), [running], [])?.kind, 'working', 'addressing PR feedback')
  assert.equal(agentState(task('t', 'todo'), [], []), null)
  assert.equal(agentState(task('t', 'done', 0, { work: work({ prUrl: 'u', prState: 'merged' }) }), [], []), null)
  assert.equal(agentState(task('t', 'in_progress'), [session('x', 'developer', 'running')], []), null, 'another task')
})

test('agentState: a pending approval waits even while the agent runs', () => {
  const dev = { ...session('t', 'developer', 'running'), items: [{ kind: 'approval', id: 'a', tool: 'execute', server: 'Cloudflare', input: {}, status: 'pending', at: 0 } as const] }
  assert.deepEqual(agentState(task('t', 'in_progress'), [dev], []), { kind: 'waiting', reason: 'Approval: Cloudflare · execute' })
})

test('Tasks views: active sections, backlog and archive', () => {
  const tasks = [
    task('b2', 'backlog', 0, { createdAt: 2 }),
    task('b1', 'backlog', 0, { createdAt: 1 }),
    task('g', 'grooming'),
    task('t2', 'todo', 3),
    task('t1', 'todo', 2),
    task('run', 'in_progress', 1),
    task('d1', 'done', 0, { updatedAt: 10 }),
    task('c1', 'canceled', 0, { updatedAt: 20 }),
    task('d2', 'done', 0, { updatedAt: 5, archivedAt: 50, title: 'Old login' }),
    task('c2', 'canceled', 0, { updatedAt: 6, archivedAt: 60 }),
    sub('s', 'run', 'todo', 0),
  ]
  const s = activeSections(tasks)
  const k = (l: Task[]) => l.map((t) => t.id)
  assert.deepEqual([k(s.inProgress), k(s.todo), k(s.grooming), k(s.finished)], [['run'], ['t1', 't2'], ['g'], ['c1', 'd1']])
  assert.deepEqual(k(backlogTasks(tasks)), ['b1', 'b2'])
  assert.deepEqual(k(archivedTasks(tasks)), ['c2', 'd2'])
  assert.deepEqual(k(archivedTasks(tasks, 'done')), ['d2'])
  assert.deepEqual(k(archivedTasks(tasks, 'all', 'login')), ['d2'])
  assert.deepEqual(k(archivedTasks(tasks, 'all', 'C2')), ['c2'], 'by key')
  assert.deepEqual(viewCounts(tasks), { active: 6, backlog: 2, archive: 2 })
})

test('autoArchiveDue: finished tasks older than N days, 0 = off', () => {
  const day = 24 * 3600 * 1000
  const now = 100 * day
  const tasks = [
    task('old', 'done', 0, { updatedAt: now - 15 * day }),
    task('oldc', 'canceled', 0, { updatedAt: now - 20 * day }),
    task('new', 'done', 0, { updatedAt: now - 3 * day }),
    task('arch', 'done', 0, { updatedAt: now - 30 * day, archivedAt: 1 }),
    task('open', 'in_progress', 0, { updatedAt: now - 30 * day }),
    sub('s', 'old', 'done', 0),
  ]
  assert.deepEqual(autoArchiveDue(tasks, 14, now).map((t) => t.id), ['old', 'oldc'])
  assert.deepEqual(autoArchiveDue(tasks, 0, now), [])
})
