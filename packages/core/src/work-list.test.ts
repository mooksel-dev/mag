import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptRecommendations, needsQuestions, workList, type AgentSession, type Task, type WorkListItem } from './index.ts'

const NOW = 100 * 24 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, projectId: 'p', key: id, parentId: null, title: id, type: 'dev', status: 'planning', description: '', rank: 0,
  needsInput: null, work: null, nextSubNo: 1, createdAt: 0, updatedAt: NOW - DAY, ...patch,
})
const session = (id: string, patch: Partial<AgentSession> = {}): AgentSession => ({
  id, projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], createdAt: NOW - 2 * DAY, ...patch,
})
const line = (i: WorkListItem) => `${i.group}:${i.kind === 'work' ? i.task.key : i.session.id}${i.badge ? `(${i.badge})` : ''}`

test('workList: waiting on you, agents working, planning and ready, topics, done 7d; canceled and steps left out', () => {
  const tasks = [
    task('asks', { needsInput: 'Pick an option' }),
    task('runs', { status: 'in_progress' }),
    task('plans'),
    task('ready', { status: 'ready' }),
    task('gone', { status: 'canceled' }),
    task('done', { status: 'done', updatedAt: NOW - 2 * DAY }),
    task('old', { status: 'done', updatedAt: NOW - 8 * DAY }),
    task('runs.1', { parentId: 'runs', status: 'in_progress' }),
  ]
  const sessions = [session('dev', { taskId: 'runs', role: 'developer', status: 'running', runStartedAt: NOW - 60_000 }), session('topic')]
  assert.deepEqual(workList('p', tasks, sessions, NOW).map(line), [
    'waiting:asks(question)', 'working:runs', 'open:plans', 'open:ready', 'topics:topic', 'done:done',
  ])
  const runs = workList('p', tasks, sessions, NOW).find((i) => i.kind === 'work' && i.task.id === 'runs')
  assert.deepEqual(runs?.kind === 'work' && runs.agent, { role: 'developer', since: NOW - 60_000 })
})

test('workList: a topic that owns an open work shows through it, and its turn counts as the work running', () => {
  const tasks = [task('w', { ownerSessionId: 'owner' }), task('finished', { status: 'done', ownerSessionId: 'old', updatedAt: NOW })]
  const sessions = [session('owner', { status: 'running', runStartedAt: NOW - 1000 }), session('old')]
  assert.deepEqual(workList('p', tasks, sessions, NOW).map(line), ['working:w', 'topics:old', 'done:finished'])
})

test("workList: a review is a work; the topic mag made for it is not a topic of its own", () => {
  const review = task('rv', { type: 'review', status: 'in_progress', ownerSessionId: 'rt', prReview: { pr: { url: 'https://github.com/o/r/pull/1', repo: 'o/r', number: 1, author: 'a', base: 'main', head: 'h' }, results: {}, shown: 'v2', posted: null } as Task['prReview'] })
  const sessions = [session('rt', { reviewOf: 'rv' })]
  assert.deepEqual(workList('p', [review], sessions, NOW).map(line), ['open:rv'])
  // Closed, it no longer owns the topic, which still is the review's.
  assert.deepEqual(workList('p', [{ ...review, status: 'done', updatedAt: NOW }], sessions, NOW).map(line), ['done:rv'])
})

test('workList: a pending approval waits on the user, in a work owned by the topic or in a topic alone', () => {
  const approval = { kind: 'approval' as const, id: 'a1', tool: 'x', server: 'jira', input: {}, status: 'pending' as const, at: NOW }
  const tasks = [task('w', { ownerSessionId: 'owner' })]
  const sessions = [session('owner', { items: [approval] }), session('alone', { items: [{ ...approval, id: 'a2' }] })]
  assert.deepEqual(workList('p', tasks, sessions, NOW).map(line).sort(), ['waiting:alone(approval)', 'waiting:w(approval)'])
  // A topic owning several open works: only the latest updated one, the one it opens as, waits.
  const two = [task('old', { ownerSessionId: 'owner', updatedAt: NOW - 3 * DAY }), task('new', { ownerSessionId: 'owner', updatedAt: NOW - DAY })]
  assert.deepEqual(workList('p', two, sessions.slice(0, 1), NOW).map(line), ['waiting:new(approval)', 'open:old'])
})

test('workList: newest activity first within a group, a session item counting as activity', () => {
  const tasks = [task('a', { updatedAt: NOW - 3 * DAY }), task('b', { updatedAt: NOW - 2 * DAY })]
  const sessions = [session('g', { taskId: 'a', role: 'groomer', items: [{ kind: 'assistant', text: 'hi', at: NOW - 1000 }] })]
  assert.deepEqual(workList('p', tasks, sessions, NOW).map(line), ['open:a', 'open:b'])
})

test('workList: other projects stay out', () => {
  assert.deepEqual(workList('p', [task('x', { projectId: 'q' })], [session('t', { projectId: 'q' })], NOW), [])
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
