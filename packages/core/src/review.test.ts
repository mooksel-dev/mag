import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentState, inbox, lastTaskSession, nextReviewRound, prHeads, reviewCurrent, reviewDue, reviewOutcome, reviewText, type AgentReview, type AgentSession, type RepoWork, type Task, type TaskWork } from './index.ts'

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  projectId: 'p',
  key: id,
  parentId: null,
  title: id,
  type: 'dev',
  status: 'in_progress',
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
const repo = (patch: Partial<RepoWork> = {}): RepoWork => ({ repo: 'r', branch: 'b', worktree: 'd/r', prUrl: 'https://github.com/o/r/pull/1', prState: 'open', ...patch })
const work = (...repos: Partial<RepoWork>[]): TaskWork => ({ repos: repos.map(repo), dir: 'd', feedbackSeenAt: 0 })
const review = (patch: Partial<AgentReview> = {}): AgentReview => ({ verdict: 'merge', findings: [], round: 1, heads: { r: 'a1' }, withContext: true, at: 1, ...patch })
const session = (id: string, role: AgentSession['role'], status: AgentSession['status'], runStartedAt?: number): AgentSession => ({
  id,
  projectId: 'p',
  taskId: 'T-1',
  role,
  agent: 'claude-code',
  nativeSessionId: null,
  status,
  items: [],
  createdAt: 0,
  runStartedAt,
})
/** A task in progress on its step T-1.1 with the step's work and review. */
const withStep = (step: Partial<Task>) => [task('T-1'), task('T-1.1', { parentId: 'T-1', ...step })]

test('prHeads: the heads of open PRs whose head is known', () => {
  const w = work({ prHead: 'a1' }, { repo: 'r2', prHead: null }, { repo: 'r3', prState: 'merged', prHead: 'c3' }, { repo: 'r4', prUrl: null, prState: null })
  assert.deepEqual(prHeads(w), { r: 'a1' })
  assert.deepEqual(prHeads(null), {})
})

test('reviewDue: once per set of heads', () => {
  assert.equal(reviewDue({}, { r: 'a1' }), true, 'never reviewed')
  assert.equal(reviewDue({ review: review() }, { r: 'a1' }), false, 'same heads')
  assert.equal(reviewDue({ review: review() }, { r: 'b2' }), true, 'pushed since')
  assert.equal(reviewDue({ review: review() }, { r: 'a1', r2: 'c3' }), true, 'one more PR')
  assert.equal(reviewDue({}, {}), false, 'no open PR')
})

test('rounds: changes in a row count up, and go to the developer while the rounds last', () => {
  assert.equal(nextReviewRound(null), 1)
  assert.equal(nextReviewRound(review({ verdict: 'changes', round: 1 })), 2)
  assert.equal(nextReviewRound(review({ verdict: 'look', round: 2 })), 1)
  assert.equal(reviewOutcome({ verdict: 'changes', round: 1 }), 'developer')
  assert.equal(reviewOutcome({ verdict: 'changes', round: 2 }), 'developer')
  assert.equal(reviewOutcome({ verdict: 'changes', round: 3 }), 'human', 'past the default 2 rounds')
  assert.equal(reviewOutcome({ verdict: 'changes', round: 1 }, 0), 'human', 'no rounds: straight to the user')
  assert.equal(reviewOutcome({ verdict: 'merge', round: 1 }), 'human')
  assert.equal(reviewOutcome({ verdict: 'look', round: 1 }), 'human')
})

test('reviewText: who reviewed, the verdict and the first finding', () => {
  assert.equal(reviewText(review()), 'Owner review: can merge')
  assert.equal(reviewText(review({ verdict: 'look', withContext: false, findings: [{ text: 'migration', where: 'store.ts:12' }, { text: 'naming' }] })), 'Reviewer review: look: store.ts:12 — migration (+1)')
  assert.equal(reviewText(review({ verdict: 'changes', round: 3, findings: [{ text: 'no tests' }] })), 'Owner review asks for changes: no tests')
})

test('inbox: a review that covers the PRs as they are gives its verdict', () => {
  const merge = withStep({ work: work({ prHead: 'a1' }), review: review() })
  assert.deepEqual(inbox('p', merge, []).map((i) => [i.kind, i.text, !!i.review]), [['ready_to_merge', 'T-1.1: Owner review: can merge', true]])
  const look = withStep({ work: work({ prHead: 'a1' }), review: review({ verdict: 'look', findings: [{ text: 'check the migration' }] }) })
  assert.deepEqual(inbox('p', look, []).map((i) => [i.kind, i.text]), [['review_look', 'T-1.1: Owner review: look: check the migration']])
  assert.deepEqual(agentState(look[0], [], look), { kind: 'waiting', reason: 'T-1.1: Owner review: look: check the migration' })
})

test('inbox: pushed since the review, or never reviewed: the plain ready to merge', () => {
  const stale = withStep({ work: work({ prHead: 'b2' }), review: review({ verdict: 'look', findings: [{ text: 'x' }] }) })
  assert.equal(reviewCurrent(stale[1]), false)
  assert.deepEqual(inbox('p', stale, []).map((i) => [i.kind, i.text, i.review]), [['ready_to_merge', 'T-1.1: PR is ready to merge', undefined]])
})

test('inbox: nothing while the reviewer runs; a failed review asks for a restart', () => {
  const tasks = withStep({ work: work({ prHead: 'a1' }) })
  const dev = session('dev', 'developer', 'idle', 10)
  assert.deepEqual(inbox('p', tasks, [dev, session('rev', 'reviewer', 'running', 20)]), [])
  assert.deepEqual(agentState(tasks[0], [dev, session('rev', 'reviewer', 'running', 20)], tasks), { kind: 'working', role: 'reviewer', since: 20 })
  const failed = inbox('p', tasks, [dev, session('rev', 'reviewer', 'error', 20)])
  assert.deepEqual(failed.map((i) => [i.kind, i.text, i.session?.role]), [['agent_failed', 'Review failed', 'reviewer']])
})

test('lastTaskSession: the one that ran last, not the one created last', () => {
  const rev = session('rev', 'reviewer', 'idle', 20)
  const dev = session('dev', 'developer', 'error', 30)
  assert.equal(lastTaskSession('T-1', [dev, rev])?.id, 'dev')
  assert.equal(lastTaskSession('T-1', [session('chat', 'chat', 'idle', 40), rev])?.id, 'rev', 'chats do not count')
})
