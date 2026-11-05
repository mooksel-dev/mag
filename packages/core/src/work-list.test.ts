import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptRecommendations,
  byActivity,
  cardFilter,
  cardMove,
  emptyResult,
  needsQuestions,
  searchAll,
  shortTitle,
  span,
  stepsLine,
  workCard,
  workCards,
  workStage,
  type AgentReview,
  type AgentSession,
  type PrReview,
  type ReviewResult,
  type RepoWork,
  type ReviewReport,
  type Task,
  type WorkCard,
} from './index.ts'

const NOW = 100 * 24 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000
const MIN = 60_000

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, projectId: 'p', key: id, parentId: null, title: id, type: 'dev', status: 'planning', description: '', rank: 0,
  needsInput: null, work: null, nextSubNo: 1, createdAt: 0, updatedAt: NOW - DAY, ...patch,
})
const step = (id: string, parentId: string, patch: Partial<Task> = {}) => task(id, { parentId, status: 'todo', ...patch })
const session = (id: string, patch: Partial<AgentSession> = {}): AgentSession => ({
  id, projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], createdAt: NOW - 2 * DAY, ...patch,
})
const pr = (n: number, patch: Partial<RepoWork> = {}): RepoWork => ({
  repo: 'r', branch: 'b', worktree: 'd/r', prUrl: `https://github.com/o/r/pull/${n}`, prState: 'open', prHead: 'h1', ...patch,
})
const withPr = (n: number, patch: Partial<RepoWork> = {}) => ({ work: { dir: 'd', feedbackSeenAt: 0, repos: [pr(n, patch)] } })
const agentReview = (verdict: AgentReview['verdict'], notes: number, at = NOW - 20 * MIN): AgentReview => ({
  verdict, findings: Array.from({ length: notes }, (_, i) => ({ text: `n${i}` })), round: 1, heads: { r: 'h1' }, withContext: true, at,
})
/** A work in progress on its first of two steps, the step patched. */
const building = (id: string, patch: Partial<Task> = {}, work: Partial<Task> = {}) => [
  task(id, { status: 'in_progress', ...work }),
  step(`${id}.1`, id, { status: 'in_progress', ...patch }),
  step(`${id}.2`, id, { rank: 1 }),
]
const line = (c: WorkCard) => `${c.group}:${c.id}:${c.dot} ${c.move.who}: ${c.move.text}`
const cards = (tasks: Task[], sessions: AgentSession[] = []) => workCards('p', tasks, sessions, NOW)
const card = (tasks: Task[], sessions: AgentSession[] = [], id = tasks[0].id) => cards(tasks, sessions).find((c) => c.id === id)!

/** A work in each state: name, its tasks and sessions, its row line. Shared with the header's card (workCard). */
const WORK_CASES: [string, Task[], AgentSession[], string][] = [
  ['planning', [task('w')], [], 'waiting:w:amber you: Continue planning'],
  ['planning with questions', [task('w', { needsInput: 'Two questions', needsQuestions: [{ text: 'a', recommendation: '' }, { text: 'b', recommendation: '' }] })], [], 'waiting:w:amber you: Your call: 2 questions'],
  ['plan ready', [task('w', { needsInput: 'Plan ready' }), step('w.1', 'w')], [], 'waiting:w:amber you: Approve & Start'],
  ['plan with steps, nothing asked', [task('w'), step('w.1', 'w')], [], 'waiting:w:amber you: Approve & Start'],
  ['ready', [task('w', { status: 'ready' }), step('w.1', 'w')], [], 'waiting:w:amber you: Start'],
  ['groomer planning', [task('w')], [session('g', { taskId: 'w', role: 'groomer', status: 'running', runStartedAt: NOW - 3 * MIN })], 'working:w:green agent: groomer · 3 min'],
  ['owner topic planning', [task('w', { ownerSessionId: 'o' })], [session('o', { status: 'running', runStartedAt: NOW - 5 * MIN })], 'working:w:green agent: owner · 5 min'],
  ['building', building('w'), [session('d', { taskId: 'w', role: 'developer', stepId: 'w.1', status: 'running', runStartedAt: NOW - 12 * MIN, items: [{ kind: 'tool', id: 't', name: 'Bash', summary: 'pnpm test', at: NOW - MIN }] })], 'working:w:green agent: developer · 12 min · Bash pnpm test'],
  ['PR open, CI pending', building('w', withPr(85, { ci: 'pending' })), [], 'working:w:grey other: CI · PR #85'],
  ['PR check failed', building('w', withPr(85, { checkError: 'gh: not logged in' })), [], 'waiting:w:amber you: PR check failed: gh: not logged in'],
  ['agent review: look', building('w', { ...withPr(85, { ci: 'pass' }), review: agentReview('look', 2) }), [], 'waiting:w:amber you: Look at PR #85'],
  ['ready to merge', building('w', { ...withPr(85, { ci: 'pass' }), review: agentReview('merge', 0) }), [], 'waiting:w:amber you: Merge PR #85'],
  ['ready to merge, no review yet', building('w', withPr(85, { ci: 'pass' })), [], 'waiting:w:amber you: Merge PR #85'],
  ['step waits for Start', [task('w', { status: 'in_progress' }), step('w.1', 'w', { status: 'done' }), step('w.2', 'w', { rank: 1, startManually: true })], [], 'waiting:w:amber you: Start step 2'],
  ['next step about to start', [task('w', { status: 'in_progress' }), step('w.1', 'w', { status: 'done' }), step('w.2', 'w', { rank: 1 })], [], 'working:w:grey other: Starting step 2'],
  ['step waits for another', building('w', { status: 'todo', waitingFor: { key: 'x.1', repo: '/r' } }), [], 'working:w:grey other: Waits for x.1'],
  ["developer's question", building('w', { ownerQuestion: 'Which table?' }, { needsInput: 'The developer asks' }), [], "waiting:w:amber you: Answer the developer's question"],
  ['agent failed', building('w'), [session('d', { taskId: 'w', role: 'developer', status: 'error' })], 'waiting:w:amber you: Restart the developer'],
  ['developer stopped', building('w'), [session('d', { taskId: 'w', role: 'developer' })], 'waiting:w:amber you: The developer stopped: look at the work'],
  ['done in 7 days', [task('w', { status: 'done', updatedAt: NOW - 2 * DAY })], [], 'done:w:grey other: Done'],
]

test('workCards: the group, dot and whose-move line of a work in each state', () => {
  for (const [name, tasks, sessions, want] of WORK_CASES) assert.equal(line(card(tasks, sessions)), want, name)
})

test('workCards: done and canceled works stay, however old; a canceled one is closed; steps and other projects are left out', () => {
  const got = cards([task('old', { status: 'done', updatedAt: NOW - 80 * DAY }), task('gone', { status: 'canceled' }), step('s', 'gone'), task('x', { projectId: 'q' })], [session('t', { projectId: 'q' })])
  assert.deepEqual(got.map((c) => [line(c), c.closed]), [['done:old:grey other: Done', false], ['done:gone:grey other: Canceled', true]])
})

test('workCards: stage and progress of a work', () => {
  const c = card(building('w', withPr(85, { ci: 'pass' })))
  assert.deepEqual([c.kind, c.title, c.stage, c.progress], ['work', 'w', 'Merge', 'step 1/2 · PR #85'])
  assert.deepEqual([card(building('w')).stage, card(building('w')).progress], ['Build', 'step 1/2'])
  assert.deepEqual([card([task('w')]).stage, card([task('w')]).progress], ['Plan', null])
  assert.equal(card([task('w', { needsInput: 'Plan ready' }), step('w.1', 'w')]).stage, 'Approve')
  assert.equal(card([task('w', { status: 'done', updatedAt: NOW }), step('w.1', 'w', { status: 'done' })]).progress, 'step 1/1')
})

test('workCards: last event: latest notice, agent review or merged step', () => {
  const merged = step('w.1', 'w', { status: 'done', updatedAt: NOW - 3 * DAY, ...withPr(84, { prState: 'merged' }) })
  const second = step('w.2', 'w', { status: 'in_progress', rank: 1, ...withPr(85, { ci: 'pass' }), review: agentReview('look', 2) })
  const tasks = [task('w', { status: 'in_progress', ownerSessionId: 'o' }), merged, second]
  assert.deepEqual(card(tasks).last, { text: 'agent review: look · 2 notes', at: NOW - 20 * MIN })
  const o = session('o', { items: [{ kind: 'notice', text: 'context compacted', at: NOW - MIN }] })
  assert.deepEqual(card(tasks, [o]).last, { text: 'context compacted', at: NOW - MIN })
  assert.deepEqual(card([tasks[0], merged]).last, { text: 'PR #84 merged', at: NOW - 3 * DAY })
  assert.equal(card([task('w')]).last, null)
})

test('workCards: a topic that owns an open work shows through it, and its turn counts as the work running', () => {
  const tasks = [task('w', { ownerSessionId: 'owner' }), task('finished', { status: 'done', ownerSessionId: 'old', updatedAt: NOW })]
  const sessions = [session('owner', { status: 'running', runStartedAt: NOW - 1000 }), session('old', { title: 'Old talk', titleGenerated: true })]
  assert.deepEqual(cards(tasks, sessions).map(line), ['topics:old:grey other: Discussion · no work yet', 'working:w:green agent: owner · 1 min', 'done:finished:grey other: Done'])
})

test('workCards: topics: approval waits on you; plain and running topics are discussions; untitled is New topic', () => {
  const approval = { kind: 'approval' as const, id: 'a1', tool: 'create_issue', server: 'jira', input: {}, status: 'pending' as const, at: NOW }
  const sessions = [
    session('asks', { items: [approval], title: 'Jira sync', titleGenerated: true }),
    session('plain', { title: 'Pricing', titleGenerated: true, items: [{ kind: 'user', text: 'what to charge?', at: NOW - 2 * MIN }, { kind: 'assistant', text: 'Depends.\nOn what?', at: NOW - MIN }] }),
    session('runs', { status: 'running', runStartedAt: NOW - 2 * MIN, title: 'how do we price the pro plan for teams', items: [{ kind: 'user', text: 'how do we price the pro plan for teams', at: NOW - 2 * MIN }] }),
  ]
  const got = cards([], sessions)
  assert.deepEqual(got.map(line), ['waiting:asks:amber you: Allow jira · create_issue', 'topics:plain:grey other: Discussion · no work yet', 'topics:runs:green agent: agent · 2 min'])
  assert.deepEqual(got.map((c) => [c.kind, c.title, c.stage, c.progress]), [['topic', 'Jira sync', null, null], ['topic', 'Pricing', null, null], ['topic', 'New topic', null, null]])
  assert.deepEqual(got[1].last, { text: 'agent: Depends.', at: NOW - MIN })
  assert.deepEqual(got[2].last, { text: 'you: how do we price the pro plan for teams', at: NOW - 2 * MIN })
})

test('workCards: a closed topic is closed however long ago; running or asking, it is not', () => {
  const approval = { kind: 'approval' as const, id: 'a1', tool: 'x', server: 'jira', input: {}, status: 'pending' as const, at: NOW }
  const sessions = [
    session('closed', { closedAt: NOW - DAY }),
    session('old', { closedAt: NOW - 8 * DAY }),
    session('runs', { closedAt: NOW - DAY, status: 'running', runStartedAt: NOW - MIN }),
    session('asks', { closedAt: NOW - DAY, items: [approval] }),
    session('open', { closedAt: null }),
  ]
  const got = cards([], sessions)
  assert.deepEqual(got.map((c) => [c.id, c.closed]), [['closed', true], ['old', true], ['runs', false], ['asks', false], ['open', false]])
  assert.deepEqual(got.map(line), [
    'done:closed:grey other: Closed',
    'done:old:grey other: Closed',
    'topics:runs:green agent: agent · 1 min',
    'waiting:asks:amber you: Allow jira · x',
    'topics:open:grey other: Discussion · no work yet',
  ])
})

const summary = (gist: string, keywords: string[] = []) => ({ title: 'Summary', gist: [gist], decisions: [], open: [], keywords })

test('searchAll: every word, case-insensitive, in the title, key, summary or messages; archive included', () => {
  const tasks = [
    task('W-1', { title: 'Login page', status: 'ready' }),
    step('W-1.1', 'W-1'),
    task('W-2', { title: 'Billing', status: 'canceled', summary: summary('Invoices per seat', ['stripe']) }),
  ]
  const sessions = [
    session('t', { title: 'Pricing talk', titleGenerated: true, closedAt: NOW, summary: summary('Plans for teams', ['kubernetes']), items: [{ kind: 'user', text: 'pro plan for teams', at: NOW }] }),
    session('dev', { role: 'developer', taskId: 'W-1.1', items: [{ kind: 'assistant', text: 'Added the OAuth callback route', at: NOW }] }),
  ]
  const ids = (q: string) => searchAll(q, tasks, sessions).map((h) => h.ref.id).sort()
  assert.deepEqual(ids('  '), [])
  assert.deepEqual(ids('  login '), ['W-1'])
  assert.deepEqual(ids('w-2'), ['W-2'])
  assert.deepEqual(ids('KUBERNETES'), ['t'], 'an archived topic by a word only in its summary')
  assert.deepEqual(ids('stripe'), ['W-2'])
  assert.deepEqual(ids('oauth callback'), ['W-1'], "a work by its step developer's messages")
  assert.deepEqual(ids('pricing pro'), ['t'], 'title and message words together')
  assert.deepEqual(ids('login billing'), [])
  assert.deepEqual(ids('dev'), [], 'a developer session has no row of its own')
  const [t] = searchAll('kubernetes', tasks, sessions)
  assert.deepEqual(t, { ref: { kind: 'topic', id: 't' }, title: 'Pricing talk', key: null, line: 'Plans for teams', snippet: null, archived: true, score: 2, at: NOW })
  assert.equal(searchAll('oauth', tasks, sessions)[0].snippet, 'Added the OAuth callback route')
  assert.equal(searchAll('login', tasks, sessions)[0].archived, false)
})

test('searchAll: the title ranks over the summary over the messages, then the latest activity', () => {
  const sessions = [
    session('msg', { title: 'One', titleGenerated: true, items: [{ kind: 'user', text: 'about redis', at: NOW }] }),
    session('sum', { title: 'Two', titleGenerated: true, summary: summary('Redis cache'), items: [{ kind: 'user', text: 'x', at: NOW - 2 * DAY }] }),
    session('old', { title: 'Redis old', titleGenerated: true, items: [{ kind: 'user', text: 'x', at: NOW - 3 * DAY }] }),
    session('new', { title: 'Redis new', titleGenerated: true, items: [{ kind: 'user', text: 'x', at: NOW - DAY }] }),
  ]
  assert.deepEqual(searchAll('redis', [], sessions).map((h) => h.ref.id), ['new', 'old', 'sum', 'msg'])
})

test('searchAll: a snippet around the match, cut on both sides; a topic that owns an open work searches as the work', () => {
  const long = `${'a '.repeat(60)}needle${' b'.repeat(80)}`
  const sessions = [session('owner', { items: [{ kind: 'assistant', text: long, at: NOW }] })]
  const hits = searchAll('needle', [task('W-1', { ownerSessionId: 'owner' })], sessions)
  assert.deepEqual(hits.map((h) => h.ref), [{ kind: 'task', id: 'W-1' }])
  assert.match(hits[0].snippet!, /^…(a )+needle( b)+…$/)
})

test('workCards: a pending approval in the owner topic waits for the work it opens as', () => {
  const approval = { kind: 'approval' as const, id: 'a1', tool: 'x', server: 'jira', input: {}, status: 'pending' as const, at: NOW }
  const sessions = [session('owner', { items: [approval] })]
  const two = [task('old', { ownerSessionId: 'owner', updatedAt: NOW - 3 * DAY }), task('new', { ownerSessionId: 'owner', updatedAt: NOW - DAY })]
  assert.deepEqual(cards(two, sessions).map(line).sort(), ['waiting:new:amber you: Allow jira · x', 'waiting:old:amber you: Continue planning'])
})

const report = (patch: Partial<ReviewReport> = {}): ReviewReport => ({
  direction: { decisions: [], options: [{ name: 'A', tradeoffs: '' }, { name: 'B', tradeoffs: '', pr: true }], facts: [], references: [] },
  problem: [], conventions: [], risks: [], questions: [], changes: [], checks: 'look', ...patch,
})
type ResultPatch = Partial<ReviewResult> & { posted?: PrReview['posted'] }
/** A review whose shown result (v2 with a report, else v1) is patched; none before anything is recorded. */
const prReview = ({ posted = null, ...result }: ResultPatch = {}): PrReview => {
  const format = result.report ? 'v2' : 'v1'
  return {
    pr: { url: 'https://github.com/o/r/pull/12', repo: '/r', number: 12, author: 'ann', base: 'main', head: 'h2' },
    results: Object.keys(result).length ? { [format]: { ...emptyResult(format, 'rt'), ...result } } : {},
    shown: format,
    posted,
  }
}
const reviewTask = (patch: Partial<Task> = {}, review: ResultPatch = {}) =>
  task('rv', { type: 'review', title: 'r#12: Charge cards', status: 'in_progress', ownerSessionId: 'rt', prReview: prReview(review), ...patch })
const ready = { verdict: 'comment' as const, head: 'h2', at: NOW - 30 * MIN }

const rt = (patch: Partial<AgentSession> = {}) => session('rt', { reviewOf: 'rv', ...patch })
/** A review in each state: name, the review, its topic, its stage and its row line. Shared with the header's card. */
const REVIEW_CASES = (): [string, Task, AgentSession, string | null, string][] => [
  ['running', reviewTask(), rt({ status: 'running', runStartedAt: NOW - 4 * MIN }), 'Running', 'working:rv:green agent: agent · 4 min'],
  ['question', reviewTask({ needsInput: 'Which ticket?' }), rt(), null, "waiting:rv:amber you: Answer the agent's question"],
  ['direction open', reviewTask({}, { ...ready, report: report() }), rt(), 'Report ready', 'waiting:rv:amber you: Your call on direction (2 options)'],
  ['decided, not posted', reviewTask({}, { ...ready, report: report({ decided: { id: 'd', reviewId: 'rv', pr: '', decision: '', choice: 'ok', at: NOW } }) }), rt(), 'Report ready', 'waiting:rv:amber you: Publish the review'],
  ['v1 ready', reviewTask({}, ready), rt(), 'Report ready', 'waiting:rv:amber you: Publish the review'],
  ['posted', reviewTask({}, { ...ready, posted: { at: NOW - 2 * 60 * MIN, url: 'u' } }), rt(), 'Waiting for author', 'working:rv:grey other: PR author · 2 h'],
  ['failed, no verdict', reviewTask(), rt({ status: 'error' }), null, 'waiting:rv:amber you: Review again'],
  ['not started, no verdict', reviewTask(), rt(), null, 'working:rv:grey other: Waits for the agent'],
  ['outdated', reviewTask({}, { ...ready, head: 'h1' }), rt(), 'Report ready', 'waiting:rv:amber you: Review the new commits'],
  ['closed', reviewTask({ status: 'done', updatedAt: NOW }), rt(), 'Done', 'done:rv:grey other: Closed'],
]

test('workCards: a review: its stage and whose move in each state; its topic is not a topic of its own', () => {
  for (const [name, t, s, stage, want] of REVIEW_CASES()) {
    const got = cards([t], [s])
    assert.deepEqual(got.map(line), [want], name)
    assert.deepEqual([got[0].kind, got[0].title, got[0].stage, got[0].progress], ['review', 'Charge cards', stage, 'PR #12 · @ann'], name)
  }
})

test('workCards: a review with both formats: the run of either is the agent working; the progress names the shown one', () => {
  const t = reviewTask({}, { ...ready, report: report() })
  t.prReview!.results.v1 = { ...emptyResult('v1', 'rt1'), ...ready }
  const c = card([t], [session('rt', { reviewOf: 'rv' }), session('rt1', { reviewOf: 'rv', status: 'running', runStartedAt: NOW - 2 * MIN })])
  assert.deepEqual([c.stage, c.progress, line(c)], ['Running', 'PR #12 · @ann · v2', 'working:rv:green agent: agent · 2 min'])
})

test('workCards: question stage of a review is its report state, not Running, once a verdict exists', () => {
  assert.equal(card([reviewTask({ needsInput: 'Q?' }, ready)], [session('rt', { reviewOf: 'rv' })]).stage, 'Report ready')
})

test('workCards: newest created first, whatever the state; byActivity (Home): green before grey, then the latest activity', () => {
  const tasks = [
    task('ci', { status: 'in_progress', updatedAt: NOW - 1000, createdAt: 5 }), step('ci.1', 'ci', { status: 'in_progress', ...withPr(1, { ci: 'pending' }) }),
    task('dev', { status: 'in_progress', updatedAt: NOW - 3 * DAY, createdAt: 4 }), step('dev.1', 'dev', { status: 'in_progress' }),
    task('a', { updatedAt: NOW - 3 * DAY, createdAt: 3 }),
    task('b', { updatedAt: NOW - 2 * DAY, createdAt: 2 }),
    task('done', { status: 'done', updatedAt: NOW, createdAt: 1 }),
  ]
  const sessions = [
    session('d', { taskId: 'dev', role: 'developer', status: 'running', runStartedAt: NOW - MIN }),
    session('g', { taskId: 'a', role: 'groomer', items: [{ kind: 'assistant', text: 'hi', at: NOW - 1000 }] }),
    session('t', { createdAt: 0 }),
  ]
  const all = cards(tasks, sessions)
  assert.deepEqual(all.map((c) => c.id), ['ci', 'dev', 'a', 'b', 'done', 't'])
  assert.deepEqual(byActivity(all.filter((c) => c.group === 'waiting')).map((c) => c.id), ['a', 'b'])
  assert.deepEqual(byActivity(all.filter((c) => c.group === 'working')).map((c) => c.id), ['dev', 'ci'])
})

test('cardFilter: waiting = that group, working = green dots, reviews = review rows with done ones', () => {
  const tasks = [
    task('asks', { needsInput: 'Pick' }),
    task('runs'),
    reviewTask(),
    task('rv2', { type: 'review', status: 'done', updatedAt: NOW, prReview: prReview() }),
    task('ci', { status: 'in_progress' }), step('ci.1', 'ci', { status: 'in_progress', ...withPr(1, { ci: 'pending' }) }),
  ]
  const all = cards(tasks, [session('g', { taskId: 'runs', role: 'groomer', status: 'running' }), session('rt', { reviewOf: 'rv', status: 'running' })])
  const ids = (f: Parameters<typeof cardFilter>[1]) => cardFilter(all, f).map((c) => c.id).sort()
  assert.equal(cardFilter(all, 'all').length, 5)
  assert.deepEqual(ids('waiting'), ['asks'])
  assert.deepEqual(ids('working'), ['runs', 'rv'])
  assert.deepEqual(ids('reviews'), ['rv', 'rv2'])
})

test('cardMove: the same line for a work given its inbox item, so the header bar can reuse it', () => {
  const tasks = building('w', { ...withPr(85, { ci: 'pass' }), review: agentReview('merge', 0) })
  assert.deepEqual(cardMove(tasks[0], { task: tasks[0], kind: 'ready_to_merge', text: '' }, [], tasks, NOW), { who: 'you', text: 'Merge PR #85', action: { kind: 'open_pr', url: 'https://github.com/o/r/pull/85' } })
  assert.deepEqual(cardMove(tasks[0], { task: tasks[0], kind: 'ready_to_start', text: '' }, [], [tasks[0], step('w.1', 'w', { startManually: true })], NOW).action, { kind: 'start_step', stepId: 'w.1' })
})

test('workCard: the header shows the same card, move and action as the row, for every work and review state', () => {
  for (const [name, tasks, sessions] of WORK_CASES) assert.deepEqual(workCard(tasks[0], tasks, sessions, NOW), card(tasks, sessions), name)
  for (const [name, t, s] of REVIEW_CASES()) assert.deepEqual(workCard(t, [t], [s], NOW), card([t], [s]), name)
  // A topic that owns the work is not taken for it, even with the same id.
  assert.equal(workCard(task('w'), [task('w')], [session('w')], NOW)?.kind, 'work')
})

test('workCard: a canceled or long done work has its card too; a step has none', () => {
  assert.equal(workCard(task('w', { status: 'canceled' }), [task('w', { status: 'canceled' })], [], NOW)?.move.text, 'Canceled')
  const old = task('w', { status: 'done', updatedAt: NOW - 80 * DAY })
  assert.equal(workCard(old, [old], [], NOW)?.move.text, 'Done')
  const s = step('w.1', 'w')
  assert.equal(workCard(s, [old, s], [], NOW), null)
})

test('stepsLine: each step with its number, PRs and where it stands', () => {
  const tasks = [
    task('w', { status: 'in_progress' }),
    step('w.1', 'w', { title: 'Model', status: 'done', ...withPr(84, { prState: 'merged' }) }),
    step('w.2', 'w', { title: 'Rows', status: 'in_progress', rank: 1, ...withPr(85) }),
    step('w.3', 'w', { title: 'Header', status: 'in_progress', rank: 2 }),
    step('w.4', 'w', { title: 'Wait', rank: 3, waitingFor: { key: 'x.1', repo: '/r' } }),
    step('w.5', 'w', { title: 'Later', rank: 4, startManually: true }),
    step('w.6', 'w', { title: 'Next', rank: 5, ...withPr(86, { prState: 'closed' }) }),
  ]
  assert.deepEqual(stepsLine(tasks[0], tasks), [
    { no: 1, key: 'w.1', title: 'Model', pr: 'PR #84', state: 'done' },
    { no: 2, key: 'w.2', title: 'Rows', pr: 'PR #85', state: 'merge' },
    { no: 3, key: 'w.3', title: 'Header', state: 'build' },
    { no: 4, key: 'w.4', title: 'Wait', state: 'waiting', waitsFor: 'x.1' },
    { no: 5, key: 'w.5', title: 'Later', state: 'manual' },
    { no: 6, key: 'w.6', title: 'Next', state: 'todo' },
  ])
  assert.deepEqual(stepsLine(task('solo'), [task('solo')]), [])
})

test('workStage: canceled has none; shortTitle: review without its prefix, topic only by its generated title', () => {
  assert.equal(workStage(task('w', { status: 'canceled' }), []), null)
  assert.equal(shortTitle(task('r', { type: 'review', title: 'api#7: Add login' })), 'Add login')
  assert.equal(shortTitle(session('t', { title: 'what should we charge for the pro p' })), 'New topic')
  assert.equal(shortTitle(session('t', { title: 'Pricing', titleGenerated: true })), 'Pricing')
})

test('span: minutes, hours, days', () => {
  assert.deepEqual([span(0), span(12 * MIN), span(3 * 60 * MIN), span(3 * DAY)], ['1 min', '12 min', '3 h', '3 d'])
})

test('needsQuestions: text required, recommendation optional, empty is none', () => {
  assert.equal(needsQuestions(undefined), null)
  assert.equal(needsQuestions([]), null)
  assert.deepEqual(needsQuestions([{ text: ' Keep? ', recommendation: ' Yes: cheap ' }, { text: 'Two PRs?' }]), [
    { text: 'Keep?', recommendation: 'Yes: cheap' },
    { text: 'Two PRs?', recommendation: '' },
  ])
  assert.throws(() => needsQuestions([{ recommendation: 'x' }]), /needs a text/)
  assert.throws(() => needsQuestions('x'), /array/)
})

test('acceptRecommendations: one numbered line per question', () => {
  assert.equal(acceptRecommendations([{ text: 'Keep?', recommendation: 'Yes' }, { text: 'Two PRs?', recommendation: '' }]), 'I accept your recommendations:\n1. Keep? → Yes\n2. Two PRs? → as you recommend')
})
