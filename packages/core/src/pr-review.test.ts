import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingCounts, findingsByLevel, githubSlug, inbox, openWorkCount, parsePrUrl, pipelineCounts, projectReviews, reviewOf, reviewReady, workSections, type AgentSession, type PrReview, type Task } from './index.ts'

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
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

const prReview = (patch: Partial<PrReview> = {}): PrReview => ({
  pr: { url: 'https://github.com/acme/api/pull/418', repo: '/r/api', number: 418, author: 'olena', base: 'main', head: 'abc' },
  problem: '',
  approach: '',
  verdict: null,
  findings: [],
  head: null,
  posted: null,
  at: null,
  ...patch,
})

const review = (id: string, patch: Partial<Task> = {}) => task(id, { type: 'review', prReview: prReview(), ownerSessionId: 'topic', ...patch })

const topic = (status: AgentSession['status']): AgentSession => ({ id: 'topic', projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status, items: [], createdAt: 1 })

test('parsePrUrl: a GitHub PR link, normalized; anything else throws', () => {
  assert.deepEqual(parsePrUrl(' https://github.com/acme/api/pull/418/files?x=1 '), { url: 'https://github.com/acme/api/pull/418', owner: 'acme', repo: 'api', number: 418 })
  assert.throws(() => parsePrUrl('https://github.com/acme/api/issues/4'), /Not a GitHub PR link/)
  assert.throws(() => parsePrUrl('acme/api#4'), /Not a GitHub PR link/)
})

test('githubSlug: owner/repo of https and ssh remotes, lower case; other hosts none', () => {
  assert.equal(githubSlug('https://github.com/Acme/api.git'), 'acme/api')
  assert.equal(githubSlug('git@github.com:acme/my.repo.git'), 'acme/my.repo')
  assert.equal(githubSlug('ssh://git@github.com/acme/api'), 'acme/api')
  assert.equal(githubSlug('https://x-token@github.com/acme/api/'), 'acme/api')
  assert.equal(githubSlug('https://gitlab.com/acme/api.git'), null)
  assert.equal(githubSlug(null), null)
})

test('reviews stay out of the Tasks tab and its counts', () => {
  const tasks = [task('w'), review('r'), review('old', { status: 'done', updatedAt: Date.now() })]
  const s = workSections(tasks)
  assert.deepEqual([...s.inProgress, ...s.finished].map((t) => t.id), ['w'])
  assert.equal(openWorkCount(tasks), 1)
  assert.equal(pipelineCounts(tasks, Date.now()).done7d, 0)
})

test('projectReviews: in progress first, newest first; reviewOf finds the PR by its link', () => {
  const tasks = [review('a', { createdAt: 1 }), review('b', { createdAt: 2, status: 'done' }), review('c', { createdAt: 3 }), task('w')]
  assert.deepEqual(projectReviews(tasks).map((t) => t.id), ['c', 'a', 'b'])
  assert.equal(reviewOf(tasks, 'https://github.com/ACME/api/pull/418/files')?.id, 'c')
  assert.equal(reviewOf(tasks, 'https://github.com/acme/api/pull/9'), undefined)
})

test('findings by level, in level order; a finding without one is should_fix', () => {
  const findings = [{ text: 'n', level: 'nit' as const }, { text: 'b', level: 'blocker' as const }, { text: 'old' }, { text: 'b2', level: 'blocker' as const }]
  assert.deepEqual(findingsByLevel(findings).map((g) => [g.level, g.findings.map((f) => f.text)]), [['blocker', ['b', 'b2']], ['should_fix', ['old']], ['nit', ['n']]])
  assert.equal(findingCounts(findings), '2 blockers · 1 should fix · 1 nit')
  assert.equal(findingCounts([]), 'no findings')
})

test('Needs you: a review is ready once its verdict covers the PR head, and not while its topic works', () => {
  const ready = review('r', { prReview: prReview({ verdict: 'request_changes', head: 'abc', at: 2, findings: [{ text: 'x', level: 'blocker' }] }) })
  assert.equal(reviewReady(ready), true)
  assert.deepEqual(inbox('p', [ready], [topic('idle')]).map((i) => [i.kind, i.text]), [['review_ready', 'Review ready: Request changes · 1 blocker']])
  assert.deepEqual(inbox('p', [ready], [topic('running')]), [])
  // A newer head waits for the next look.
  const stale = review('s', { prReview: prReview({ verdict: 'approve', head: 'old', at: 2 }) })
  assert.equal(reviewReady(stale), false)
  assert.deepEqual(inbox('p', [stale, review('n')], [topic('idle')]), [])
  assert.deepEqual(inbox('p', [review('q', { needsInput: 'No access to the repo' })], []).map((i) => i.kind), ['question'])
  assert.deepEqual(inbox('p', [{ ...ready, status: 'done' }], [topic('idle')]), [])
})
