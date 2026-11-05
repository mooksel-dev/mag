import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingCounts, findingPlace, findingsByLevel, githubSlug, reviewPollOutcome, reviewToPost, inbox, parsePrUrl, projectReviews, reviewLine, reviewOf, reviewOfTopic, reviewReady, reviewState, reviewTopic, workSections, emptyResult, formatOfTopic, migratePrReview, resultOutdated, reviewRunning, reviewTopicIds, shownResult, type AgentSession, type LegacyPrReview, type PrReview, type Task } from './index.ts'

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

const PR = { url: 'https://github.com/acme/api/pull/418', repo: '/r/api', number: 418, author: 'olena', base: 'main', head: 'abc' }

/** A review with one result, written as before one result per format: migratePrReview places it (v2 with a report). */
const prReview = (patch: Partial<LegacyPrReview> = {}): PrReview => migratePrReview({ pr: PR, posted: null, ...patch }, 'topic')

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

test('reviews stay out of workSections', () => {
  const tasks = [task('w'), review('r'), review('old', { status: 'done', updatedAt: Date.now() })]
  const s = workSections(tasks)
  assert.deepEqual([...s.inProgress, ...s.finished].map((t) => t.id), ['w'])
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

test('findingPlace: a file line or range; anything else names no line (reviews-ahent-reviuit-pr-timeitiv.3)', () => {
  assert.deepEqual(findingPlace('src/a.ts:12'), { path: 'src/a.ts', start: 12, end: 12 })
  assert.deepEqual(findingPlace('./src/a.ts:12-20'), { path: 'src/a.ts', start: 12, end: 20 })
  assert.equal(findingPlace('src/a.ts'), null)
  assert.equal(findingPlace('billing module'), null)
  assert.equal(findingPlace('src/a.ts:20-12'), null)
  assert.equal(findingPlace(undefined), null)
})

test('reviewToPost: only picked findings, in level order; lines become line comments, the rest goes in the text', () => {
  const findings = [
    { text: 'naming', level: 'nit' as const, where: 'src/a.ts:3', post: true },
    { text: 'not picked', level: 'blocker' as const, where: 'src/b.ts:1' },
    { text: 'no lock', level: 'blocker' as const, where: 'src/a.ts:10-14', post: true },
    { text: 'why?', level: 'question' as const, where: 'billing', post: true },
  ]
  assert.deepEqual(reviewToPost('request_changes', findings), {
    verdict: 'request_changes',
    body: '- `billing`: **question**: why?',
    comments: [
      { path: 'src/a.ts', line: 14, start: 10, body: '**blocker**: no lock' },
      { path: 'src/a.ts', line: 3, body: '**nit**: naming' },
    ],
  })
  assert.deepEqual(reviewToPost('comment', findings, false).body.split('\n'), ['- `src/a.ts:10-14`: **blocker**: no lock', '- `billing`: **question**: why?', '- `src/a.ts:3`: **nit**: naming'])
  assert.deepEqual(reviewToPost('approve', []), { verdict: 'approve', body: '', comments: [] })
  assert.equal(reviewToPost('request_changes', [findings[2]]).body, '1 blocker')
  assert.equal(reviewToPost('comment', []).body, 'Comment')
})

test('reviewPollOutcome: done when merged or closed; new commits after a review get a look once', () => {
  const reviewed = prReview({ verdict: 'approve', head: 'abc' })
  assert.equal(reviewPollOutcome(reviewed, { state: 'MERGED', head: 'abc' }), 'done')
  assert.equal(reviewPollOutcome(prReview(), { state: 'CLOSED', head: 'abc' }), 'done')
  assert.equal(reviewPollOutcome(reviewed, { state: 'OPEN', head: 'abc' }), null)
  assert.equal(reviewPollOutcome(reviewed, { state: 'OPEN', head: 'def' }), 'rereview')
  // Asked about def already (the PR's head is def), the agent has not recorded it yet.
  assert.equal(reviewPollOutcome({ ...reviewed, pr: { ...reviewed.pr, head: 'def' } }, { state: 'OPEN', head: 'def' }), null)
  // Not reviewed yet: the agent is at it.
  assert.equal(reviewPollOutcome(prReview(), { state: 'OPEN', head: 'def' }), null)
})

test('reviewState: one state of a review for every view, in order (reviews-normalnyi-ux-stan-reviu.1)', () => {
  const ready = prReview({ verdict: 'request_changes', head: 'abc', at: 2, findings: [{ text: 'x', level: 'blocker' }] })
  const old = prReview({ verdict: 'request_changes', head: 'old', at: 2, findings: [{ text: 'x', level: 'blocker' }] })
  const states = (t: Task, s: AgentSession['status']) => [reviewState(t, [topic(s)]), reviewLine(t, [topic(s)])]
  assert.deepEqual(states(review('r', { status: 'done', prReview: ready }), 'running'), ['closed', 'closed'])
  assert.deepEqual(states(review('r', { prReview: ready, needsInput: 'q' }), 'running'), ['reviewing', 'the agent is reviewing…'])
  assert.deepEqual(states(review('r', { prReview: ready, needsInput: 'No access' }), 'error'), ['question', 'asks: No access'])
  assert.deepEqual(states(review('r', { prReview: ready }), 'idle'), ['ready', 'Request changes · 1 blocker'])
  // A borrowed topic that errors later in another chat keeps the review ready.
  assert.equal(reviewState(review('r', { prReview: ready }), [topic('error')]), 'ready')
  assert.deepEqual(states(review('r'), 'error'), ['failed', 'the agent failed: review again'])
  assert.deepEqual(states(review('r', { prReview: old }), 'error'), ['failed', 'the agent failed: review again'])
  assert.deepEqual(states(review('r', { prReview: old }), 'idle'), ['outdated', 'Request changes · 1 blocker · new commits since'])
  assert.deepEqual(states(review('r'), 'idle'), ['waiting', 'waits for the agent'])
  assert.equal(reviewState(review('r', { ownerSessionId: 'gone' }), []), 'waiting')
})

test('Needs you: a review whose topic failed before a verdict on its head is Review failed', () => {
  assert.deepEqual(inbox('p', [review('r')], [topic('error')]).map((i) => [i.kind, i.text, i.session?.id]), [['agent_failed', 'Review failed', 'topic']])
  assert.deepEqual(inbox('p', [review('r', { status: 'done' })], [topic('error')]), [])
})

test('reviewTopic: the topic mag created for a review; legacy by its first job; never a topic that asked for it', () => {
  const r = review('r')
  const own = { ...topic('idle'), id: 'own', reviewOf: 'r' }
  assert.equal(reviewTopic(r, [topic('idle'), own])?.id, 'own')
  // Before reviewOf: mag's topic opens with the job as a user item.
  const job = (text: string): AgentSession => ({ ...topic('idle'), items: [{ kind: 'user', text, at: 1 }] })
  assert.equal(reviewTopic(r, [job('Review the PR https://github.com/acme/api/pull/418 (api#418 by @olena…')])?.id, 'topic')
  // The user's topic that called review_pr, and a job of another PR.
  assert.equal(reviewTopic(r, [job('please review https://github.com/acme/api/pull/418')]), undefined)
  assert.equal(reviewTopic(r, [job('Review the PR https://github.com/acme/api/pull/4180 (api#4180…')]), undefined)
  assert.equal(reviewTopic(r, [topic('idle')]), undefined)
})

test('reviewOfTopic: the open review a topic owns', () => {
  const tasks = [review('old', { status: 'done' }), task('w', { ownerSessionId: 'topic' }), review('r')]
  assert.equal(reviewOfTopic(tasks, 'topic')?.id, 'r')
  assert.equal(reviewOfTopic(tasks, 'other'), undefined)
})

test('migratePrReview: a report moves to v2 with its direction call and draft, a verdict alone to v1, none to no result', () => {
  const report = { checks: 'request_changes', decided: { id: 'd1', choice: 'prefer', option: 'B' }, draft: 'Please use B' } as unknown as NonNullable<LegacyPrReview['report']>
  const v2 = migratePrReview({ pr: PR, posted: { at: 3, url: 'u' }, problem: 'p', approach: 'a', verdict: 'request_changes', findings: [{ text: 'x', level: 'blocker' }], report, head: 'abc', at: 2 }, 'topic')
  assert.equal(v2.shown, 'v2')
  assert.equal(v2.results.v1, undefined)
  assert.deepEqual(v2.results.v2, { format: 'v2', sessionId: 'topic', problem: 'p', approach: 'a', verdict: 'request_changes', findings: [{ text: 'x', level: 'blocker' }], report, head: 'abc', at: 2 })
  assert.deepEqual(v2.results.v2?.report?.decided, report.decided, 'a decided report keeps its decision')
  assert.equal(v2.results.v2?.report?.draft, 'Please use B')
  assert.deepEqual(v2.posted, { at: 3, url: 'u' })
  const v1 = migratePrReview({ pr: PR, posted: null, verdict: 'approve', findings: [], head: 'abc', at: 2 }, 'topic')
  assert.equal(v1.shown, 'v1')
  assert.equal(v1.results.v1?.verdict, 'approve')
  assert.equal(v1.results.v1?.report, undefined)
  assert.deepEqual(migratePrReview({ pr: PR, posted: null, problem: '', verdict: null, findings: [], head: null, at: null }), { pr: PR, results: {}, shown: 'v2', posted: null })
  // Today's form stays as it is: the migration runs once, and again changes nothing.
  assert.deepEqual(migratePrReview(v2), v2)
})

test('both results are kept: the shown one makes the state and the line; Run for a missing or older one', () => {
  const v1 = { ...emptyResult('v1', 't1'), verdict: 'approve' as const, head: 'abc', at: 2 }
  const v2 = { ...emptyResult('v2', 't2'), verdict: 'request_changes' as const, findings: [{ text: 'x', level: 'blocker' as const }], head: 'old', at: 1 }
  const both: PrReview = { pr: PR, results: { v1, v2 }, shown: 'v1', posted: null }
  assert.equal(shownResult(both), v1)
  const rv = (r: PrReview) => review('r', { prReview: r, ownerSessionId: 't1' })
  const s = (id: string, status: AgentSession['status']) => ({ ...topic(status), id })
  assert.deepEqual([reviewState(rv(both), [s('t1', 'idle'), s('t2', 'idle')]), reviewLine(rv(both), [])], ['ready', 'Approve · no findings'])
  assert.deepEqual([reviewState(rv({ ...both, shown: 'v2' }), []), reviewLine(rv({ ...both, shown: 'v2' }), [])], ['outdated', 'Request changes · 1 blocker · new commits since'])
  // A run of the other format in a turn: the review is reviewing.
  assert.equal(reviewRunning(rv(both), [s('t2', 'running')]), true)
  assert.equal(reviewState(rv(both), [s('t2', 'running')]), 'reviewing')
  assert.deepEqual(reviewTopicIds(rv(both)), ['t1', 't2'])
  assert.equal(resultOutdated(both, 'v1'), false)
  assert.equal(resultOutdated(both, 'v2'), true, 'older than the head')
  assert.equal(resultOutdated({ ...both, results: { v1 } }, 'v2'), true, 'missing')
  assert.equal(resultOutdated({ ...both, results: { v1, v2: emptyResult('v2', 't2') } }, 'v2'), true, 'started, not recorded')
})

test('formatOfTopic: the topic\'s own format, else the result it runs, the shown one first', () => {
  const both: PrReview = { pr: PR, results: { v1: emptyResult('v1', 'asker'), v2: emptyResult('v2', 'asker') }, shown: 'v2', posted: null }
  assert.equal(formatOfTopic(both, { id: 'mine', reviewFormat: 'v1' }), 'v1')
  assert.equal(formatOfTopic(both, { id: 'asker' }), 'v2')
  assert.equal(formatOfTopic({ ...both, results: { v1: emptyResult('v1', 'asker') } }, { id: 'asker' }), 'v1')
  assert.equal(formatOfTopic(both, { id: 'other' }), null)
  assert.equal(formatOfTopic(both, undefined), null)
})
