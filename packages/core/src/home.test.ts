import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalCommand, approvalName, workSections, ideaContext, ideaPrompt, ideaText, ideaTitle, projectIdeas, agentState, inbox, runningAgents, taskChangeEvents, type AgentSession, type RepoWork, type Task, type WorkState, type SubtaskStatus, type TaskWork } from './index.ts'

const task = (id: string, status: WorkState | SubtaskStatus, rank = 0, patch: Partial<Task> = {}): Task => ({
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
const sub = (id: string, parentId: string, status: WorkState | SubtaskStatus, rank: number) => task(id, status, rank, { parentId })
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
  const events = taskChangeEvents(task('t', 'planning'), task('t', 'ready'))
  assert.deepEqual(events, [{ projectId: 'p', taskId: 't', taskKey: 't', kind: 'status', text: 'Ready' }])
})

test('taskChangeEvents: PR opened and merged', () => {
  const pr = work({ prUrl: 'https://x/pr/1', prState: 'open' })
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: work() }), task('t', 'in_progress', 0, { work: pr })), ['status:PR opened'])
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: pr }), task('t', 'in_progress', 0, { work: pr })), [], 'already known')
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: pr }), task('t', 'done', 0, { work: pr })), ['status:merged'])
  assert.deepEqual(texts(task('t', 'in_progress'), task('t', 'done')), ['status:Done'], 'no PR recorded')
})

test('taskChangeEvents: canceled, with the reason', () => {
  assert.deepEqual(texts(task('t', 'ready'), task('t', 'canceled', 0, { cancelReason: 'dup of T-1' })), ['status:Canceled: dup of T-1'])
  assert.deepEqual(texts(task('t', 'ready'), task('t', 'canceled')), ['status:Canceled'])
})

test('taskChangeEvents: a ticked subtask is not activity', () => {
  assert.deepEqual(texts(sub('s', 't', 'todo', 0), sub('s', 't', 'done', 0)), [])
})

test('taskChangeEvents: a check error in any repo', () => {
  assert.deepEqual(texts(task('t', 'in_progress', 0, { work: work({}, {}) }), task('t', 'in_progress', 0, { work: work({}, { checkError: 'r2 down' }) })), ['check_failed:r2 down'])
})

test('taskChangeEvents: needsInput set and changed, not cleared', () => {
  assert.deepEqual(texts(task('t', 'planning'), task('t', 'planning', 0, { needsInput: 'q1' })), ['needs_input:q1'])
  assert.deepEqual(texts(task('t', 'planning', 0, { needsInput: 'q1' }), task('t', 'planning', 0, { needsInput: 'q2' })), ['needs_input:q2'])
  assert.deepEqual(texts(task('t', 'planning', 0, { needsInput: 'q1' }), task('t', 'planning')), [])
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
    task('question', 'planning', 0, { needsInput: 'which db?' }),
    task('check', 'in_progress', 0, { needsInput: 'q', work: work({ prUrl: 'u', checkError: 'gh down' }) }),
    task('failed', 'in_progress', 0, { needsInput: 'Developer agent failed; check the chat', work: work() }),
    task('quiet', 'ready'),
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

test('inbox: a finished work and its steps wait on nobody', () => {
  const tasks = [
    task('done', 'done', 0, { needsInput: 'q', work: work({ prUrl: 'u', prState: 'open' }) }),
    task('donestep', 'in_progress', 0, { parentId: 'done', work: work({ prUrl: 'u2', prState: 'open' }) }),
    task('gone', 'canceled'),
  ]
  assert.deepEqual(inbox('p', tasks, [session('done', 'developer', 'error'), session('gone', 'groomer', 'error')]), [])
})

test('inbox: ready to merge counts the PRs still open', () => {
  const two = task('t', 'in_progress', 0, { work: work({ prUrl: 'u1', prState: 'open' }, { prUrl: 'u2', prState: 'open' }) })
  assert.equal(inbox('p', [two], [])[0]?.text, '2 PRs are ready to merge')
  const one = task('t', 'in_progress', 0, { work: work({ prUrl: 'u1', prState: 'merged' }, { prUrl: 'u2', prState: 'open' }) })
  assert.equal(inbox('p', [one], [])[0]?.text, 'PR is ready to merge')
})

test('inbox: agent_failed only from the task agent that ran last', () => {
  const t = task('t', 'planning')
  assert.deepEqual(inbox('p', [t], [session('t', 'groomer', 'error'), session('t', 'groomer', 'idle')]), [])
  assert.equal(inbox('p', [t], [session('t', 'groomer', 'idle'), session('t', 'groomer', 'error')])[0]?.kind, 'agent_failed')
  assert.deepEqual(inbox('p', [t], [session('t', 'reviewer', 'error')]).map((i) => i.text), ['Review failed'], 'the agent review of a step (T-55.1)')
  assert.deepEqual(inbox('p', [t], [session('t', 'chat', 'error')]), [], 'other roles do not count')
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

test('runningAgents: running sessions of any role and project', () => {
  const sessions = [session('t1', 'developer', 'running'), session('t2', 'groomer', 'running'), session('t3', 'developer', 'idle'), session('t4', 'developer', 'error'), { ...session('c', 'chat', 'running'), projectId: 'q', taskId: null }]
  assert.deepEqual(runningAgents(sessions).map((s) => s.id), ['t1-developer', 't2-groomer', 'c-chat'])
  assert.deepEqual(runningAgents([]), [])
})

test('agentState: working, waiting, or nothing', () => {
  const running = { ...session('t', 'developer', 'running'), runStartedAt: 42 }
  assert.deepEqual(agentState(task('t', 'in_progress'), [session('t', 'groomer', 'idle'), running], []), { kind: 'working', role: 'developer', since: 42 })
  assert.deepEqual(agentState(task('t', 'planning', 0, { needsInput: 'Which DB?' }), [session('t', 'groomer', 'idle')], []), { kind: 'waiting', reason: 'Which DB?' })
  const pr = work({ prUrl: 'u', prState: 'open' })
  assert.deepEqual(agentState(task('t', 'in_progress', 0, { work: pr }), [session('t', 'developer', 'idle')], []), { kind: 'waiting', reason: 'PR waits for merge' })
  assert.equal(agentState(task('t', 'in_progress', 0, { work: pr }), [running], [])?.kind, 'working', 'addressing PR feedback')
  assert.equal(agentState(task('t', 'ready'), [], []), null)
  assert.equal(agentState(task('t', 'done', 0, { work: work({ prUrl: 'u', prState: 'merged' }) }), [], []), null)
  assert.equal(agentState(task('t', 'in_progress'), [session('x', 'developer', 'running')], []), null, 'another task')
})

test('agentState: a pending approval waits even while the agent runs', () => {
  const dev = { ...session('t', 'developer', 'running'), items: [{ kind: 'approval', id: 'a', tool: 'execute', server: 'Cloudflare', input: {}, status: 'pending', at: 0 } as const] }
  assert.deepEqual(agentState(task('t', 'in_progress'), [dev], []), { kind: 'waiting', reason: 'Approval: Cloudflare · execute' })
})

test('approvalName / approvalCommand: an integration by its server, a Bash call by its command, shortened (chat-publishes-to-github-prs.2)', () => {
  assert.equal(approvalName({ tool: 'execute', server: 'Cloudflare', input: {} }), 'Cloudflare · execute')
  assert.equal(approvalCommand({ tool: 'execute', server: 'Cloudflare', input: { command: 'x' } }), null)
  const bash = { tool: 'Bash', input: { command: 'gh pr comment 4\n  -b "ok"' } }
  assert.equal(approvalCommand(bash), 'gh pr comment 4\n  -b "ok"')
  assert.equal(approvalName(bash), 'Bash: gh pr comment 4 -b "ok"')
  const long = approvalName({ tool: 'Bash', input: { command: `gh api -X POST ${'x'.repeat(100)}` } })
  assert.equal(long.length, 'Bash: '.length + 60)
  assert.ok(long.endsWith('…'))
  assert.equal(approvalName({ tool: 'Bash', input: {} }), 'Bash')
  const dev = { ...session('t', 'chat', 'running'), items: [{ kind: 'approval', id: 'a', tool: 'Bash', input: { command: 'git push origin x' }, status: 'pending', at: 0 } as const] }
  assert.deepEqual(agentState(task('t', 'in_progress'), [dev], []), { kind: 'waiting', reason: 'Approval: Bash: git push origin x' })
})

test('workSections: works by state, no backlog, priority or archive (T-55.7)', () => {
  const tasks = [
    task('p2', 'planning', 0, { createdAt: 2 }),
    task('p1', 'planning', 0, { createdAt: 1 }),
    task('r2', 'ready', 0, { createdAt: 4 }),
    task('r1', 'ready', 0, { createdAt: 3 }),
    task('run', 'in_progress'),
    task('d1', 'done', 0, { updatedAt: 10 }),
    task('c1', 'canceled', 0, { updatedAt: 20 }),
    task('d2', 'done', 0, { updatedAt: 5 }),
    sub('s', 'run', 'todo', 0),
  ]
  const s = workSections(tasks)
  const k = (l: Task[]) => l.map((t) => t.id)
  assert.deepEqual([k(s.inProgress), k(s.ready), k(s.planning), k(s.finished)], [['run'], ['r1', 'r2'], ['p1', 'p2'], ['c1', 'd1', 'd2']])
})

test('taskChangeEvents: a done work back in planning is reopened (T-55.6)', () => {
  assert.deepEqual(texts(task('t', 'done'), task('t', 'planning')), ['status:Reopened'])
})

test('ideas: per project, newest first; a text is required; the prompt that starts a work from one (T-55.6)', () => {
  const idea = (id: string, projectId: string, createdAt: number) => ({ id, projectId, text: id, createdAt })
  assert.deepEqual(projectIdeas([idea('a', 'p', 1), idea('b', 'q', 2), idea('c', 'p', 3)], 'p').map((i) => i.id), ['c', 'a'])
  assert.equal(ideaText('  cache rates \n'), 'cache rates')
  assert.throws(() => ideaText(' '), /An idea needs a text/)
  assert.match(ideaPrompt({ text: 'dup retry', source: 'T-3.1' }), /idea \(found in T-3\.1\):\n\ndup retry\n\n.*reopen_work/s)
  assert.ok(!ideaPrompt({ text: 'x' }).includes('found in'))
  assert.match(ideaPrompt({ text: 'x' }, true), /^Let's start a work from the idea we discussed here:\n\nx\n/)
  assert.match(ideaContext({ text: 'dup retry', source: 'T-3.1' }), /^## The idea this topic discusses\n.*\(found in T-3\.1\).*\n\ndup retry$/s)
})

test('ideaTitle: the first non-empty line, cut', () => {
  assert.equal(ideaTitle({ text: '\n  Cache rates  \nwhy: the API is slow' }), 'Cache rates')
  const long = ideaTitle({ text: 'x'.repeat(300) })
  assert.equal(long.length, 100)
  assert.ok(long.endsWith('…'))
  assert.equal(ideaTitle({ text: 'y'.repeat(100) }), 'y'.repeat(100))
})
