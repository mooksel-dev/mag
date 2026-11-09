import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentReview, AgentSession, Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import { topicAgents, topicArtifacts, treeWorks, workTarget, type TopicArtifacts } from './artifacts.ts'

const session = (id: string, extra: Partial<AgentSession> = {}) =>
  ({ id, projectId: 'p', taskId: null, role: 'chat', parentId: null, status: 'idle', items: [], createdAt: 0, ...extra }) as unknown as AgentSession
const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, projectId: 'p', key: id.toUpperCase(), parentId: null, title: `Work ${id}`, type: 'dev', status: 'planning', createdAt: 0, updatedAt: 0, ...extra }) as unknown as Task
const canvas = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, projectId: 'p', taskId: null, sessionId: null, title: id, kind: 'diagram', diagram: { type: 'component', modules: [] }, version: 1, updatedAt: 0, ...extra }) as unknown as AppState['canvases'][number]

const topic = session('t')
const child = session('c', { parentId: 't', role: null })
const other = session('o')
const review: AgentReview = { verdict: 'changes', findings: [{ text: 'fix it' } as never], round: 1, heads: {}, withContext: true, at: 50 }

const state = (extra: Partial<AppState> = {}): Pick<AppState, 'tasks' | 'sessions' | 'canvases' | 'docs'> => ({
  sessions: [topic, child, other],
  tasks: [
    task('w1', { ownerSessionId: 't', updatedAt: 10, createdAt: 1 }),
    task('w1.1', { parentId: 'w1', key: 'W1.1', title: 'Step one', review }),
    task('w2', { ownerSessionId: 'c', updatedAt: 20, createdAt: 2 }),
    task('w3', { ownerSessionId: 'o', updatedAt: 30 }),
    task('r1', { type: 'review', status: 'in_progress', updatedAt: 40 }),
  ],
  canvases: [
    canvas('plan-root', { taskId: 'w1', role: 'plan', stepId: 'w1.1', root: true, updatedAt: 5 }),
    canvas('plan-flow', { taskId: 'w1', role: 'plan', stepId: 'w1.1', updatedAt: 7, diagram: { type: 'flowchart', nodes: [], edges: [] } }),
    canvas('fact', { taskId: 'w1', role: 'fact', stepId: 'w1.1', updatedAt: 60 }),
    canvas('mock', { taskId: null, sessionId: 'c', kind: 'html', diagram: undefined, updatedAt: 3 }),
    canvas('elsewhere', { taskId: 'w3', updatedAt: 90 }),
    canvas('loose-other', { taskId: null, sessionId: 'o', kind: 'html', diagram: undefined }),
  ],
  docs: { w1: '# W1\nSee [plan](canvas:plan-root).' },
  ...extra,
})

/** Each work's lines by their labels; the loose ones last. */
const shape = (a: TopicArtifacts) => [
  ...a.works.map((w) => `${w.work.key}: ${w.lines.map((c) => c.label).join(' | ')}`),
  ...(a.loose.length ? [`loose: ${a.loose.map((c) => c.label).join(' | ')}`] : []),
]

test("topicArtifacts: plain titles: the doc is the work's title; a step's plan, fact and review are named after the step (topic-screen-one-new-compact.2)", () => {
  const list = topicArtifacts(topic, state())
  assert.deepEqual(shape(list), ['W2: Work w2 | mock', 'W1: Work w1 | Plan: Step one | What was built: Step one | Review: Step one'])
  assert.equal(list.count, 6)
  const [doc, plan, , review] = list.works[1].lines
  assert.deepEqual(doc.open, { kind: 'doc', taskId: 'w1' })
  assert.equal(plan.title, 'plan-root · 2 diagrams', 'a set is one line; its own title is the tooltip')
  assert.deepEqual(plan.open, { kind: 'canvas', id: 'plan-root' })
  assert.deepEqual([review.open, review.tone], [{ kind: 'review', taskId: 'w1.1' }, 'red'])
  // A work without a doc yet: its title opens its card.
  assert.deepEqual(list.works[0].lines[0].open, { kind: 'work', taskId: 'w2' })
})

test('topicArtifacts: a session under a topic lists its own part of the tree only', () => {
  assert.deepEqual(shape(topicArtifacts(child, state())), ['W2: Work w2 | mock'])
})

test('topicArtifacts: a work without a topic lists its own, with what its owner drew before it; a review is its report', () => {
  assert.deepEqual(shape(topicArtifacts(null, state(), task('w3', { ownerSessionId: 'o', updatedAt: 30 }))), ['W3: Work w3 | elsewhere | loose-other'])
  const r = state().tasks.find((t) => t.id === 'r1')!
  const reviewed = topicArtifacts(null, state(), r)
  assert.deepEqual(reviewed.works.map((w) => w.lines.map((l) => [l.label, l.open])), [[['Review: Work r1', { kind: 'review', taskId: 'r1' }]]])
  assert.equal(reviewed.count, 1)
  assert.deepEqual(workTarget(r), { kind: 'review', taskId: 'r1' })
  assert.deepEqual(workTarget(task('w1')), { kind: 'work', taskId: 'w1' })
  assert.deepEqual(topicArtifacts(null, state()), { works: [], loose: [], count: 0 })
})

test("topicArtifacts: a work lists only its own canvases: another work's that its doc links stays out, or with its step", () => {
  const s = state({ docs: { w1: '[x](canvas:elsewhere)', w2: '[x](canvas:elsewhere) [y](canvas:plan-root)' } })
  assert.deepEqual(shape(topicArtifacts(topic, s)), ['W2: Work w2 | mock', 'W1: Work w1 | Plan: Step one | What was built: Step one | Review: Step one'])
})

test('topicArtifacts: a canvas two works list shows once', () => {
  const s = state({
    tasks: [task('a', { ownerSessionId: 't', createdAt: 1 }), task('b', { ownerSessionId: 't', createdAt: 2 })],
    canvases: [canvas('sketch', { taskId: null, sessionId: 't', kind: 'html', diagram: undefined })],
    docs: {},
  })
  assert.deepEqual(shape(topicArtifacts(topic, s)), ['B: Work b | sketch', 'A: Work a'])
})

test('topicArtifacts: finished works leave the panel, what the tree drew outside a work stays (right-panel-only-what-is.1)', () => {
  const s = state({
    tasks: [
      task('open', { ownerSessionId: 't' }),
      task('merged', { ownerSessionId: 't', status: 'done' }),
      task('dropped', { ownerSessionId: 'c', status: 'canceled' }),
      task('closed', { type: 'review', status: 'done', closedAt: 9, ownerSessionId: 't' }),
      task('theirs', { ownerSessionId: 'o' }),
    ],
    canvases: [
      canvas('c-open', { taskId: 'open' }),
      canvas('c-merged', { taskId: 'merged' }),
      canvas('c-dropped', { taskId: 'dropped', kind: 'html', diagram: undefined }),
      canvas('c-theirs', { taskId: 'theirs' }),
      canvas('sketch', { taskId: null, sessionId: 'c', kind: 'html', diagram: undefined }),
    ],
    docs: { merged: '# done' },
  })
  assert.deepEqual(shape(topicArtifacts(topic, s)), ['OPEN: Work open | c-open', 'loose: sketch'])
  // With no open work, what the tree drew is loose.
  assert.deepEqual(shape(topicArtifacts(child, s)), ['loose: sketch'])
  // A finished work's own screen, without a topic, still reaches its doc.
  const merged = s.tasks.find((t) => t.id === 'merged')!
  assert.deepEqual(shape(topicArtifacts(null, s, merged)), ['MERGED: Work merged | c-merged'])
})

test("topicArtifacts: Delete is on a canvas's line, a whole set at once; not on a doc or the fact of an open step (right-panel-only-what-is.1)", () => {
  const deletes = (a: TopicArtifacts) => Object.fromEntries([...a.works.flatMap((w) => w.lines), ...a.loose].map((c) => [c.label, c.deletes]))
  assert.deepEqual(deletes(topicArtifacts(topic, state())), {
    'Work w2': undefined,
    mock: ['mock'],
    'Work w1': undefined,
    'Plan: Step one': ['plan-root', 'plan-flow'],
    'What was built: Step one': undefined,
    'Review: Step one': undefined,
  })
  const s = state({
    tasks: [
      task('w', { ownerSessionId: 't', status: 'in_progress' }),
      task('w.1', { parentId: 'w', key: 'W.1', title: 'Merged', status: 'done' }),
      task('w.2', { parentId: 'w', key: 'W.2', title: 'Open', status: 'in_progress' }),
    ],
    canvases: [canvas('f1', { taskId: 'w', role: 'fact', stepId: 'w.1' }), canvas('f2', { taskId: 'w', role: 'fact', stepId: 'w.2' })],
    docs: {},
  })
  assert.deepEqual(deletes(topicArtifacts(topic, s)), { 'Work w': undefined, 'What was built: Merged': ['f1'], 'What was built: Open': undefined })
  // The fact of a teammate's open PR review: its report works from it.
  const r = task('r', { type: 'review', status: 'in_progress', ownerSessionId: 't' })
  const reviewed = state({ tasks: [r], canvases: [canvas('rf', { taskId: 'r', role: 'fact' })], docs: {} })
  assert.deepEqual(deletes(topicArtifacts(topic, reviewed)), { 'Review: Work r': undefined, 'What was built: Work r': undefined })
})

test("topicArtifacts: options named after the work, steps' lines in step order; what the tree drew outside a work is last", () => {
  const s = state({
    tasks: [
      task('w', { ownerSessionId: 't', status: 'in_progress' }),
      task('w.1', { parentId: 'w', key: 'W.1', title: 'Model', status: 'done', review: { ...review, verdict: 'merge' } }),
      task('w.2', { parentId: 'w', key: 'W.2', title: 'Rows', status: 'in_progress', review: { ...review, verdict: 'look' } }),
    ],
    canvases: [
      canvas('optB', { taskId: 'w', role: 'option', option: 'B' }),
      canvas('optA', { taskId: 'w', role: 'option', option: 'A' }),
      canvas('fact2', { taskId: 'w', role: 'fact', stepId: 'w.2' }),
      canvas('wplan', { taskId: 'w', role: 'plan' }),
      canvas('sketch', { taskId: null, sessionId: 'c', kind: 'html', diagram: undefined }),
    ],
    docs: {},
  })
  const list = topicArtifacts(topic, s)
  assert.deepEqual(shape(list), [
    'W: Work w | Option A: Work w | Option B: Work w | Plan: Work w | Review: Model | What was built: Rows | Review: Rows',
    'loose: sketch',
  ])
  assert.deepEqual(list.works[0].lines.filter((l) => l.tone).map((l) => l.tone), ['green', 'amber'])
})

test("topicAgents: the live agents of the tree (not its subtopics) and of its works, waiting and working first; finished ones are left out (right-panel-only-what-is.1)", () => {
  const approval = { kind: 'approval', status: 'pending', id: 'a', at: 1 }
  const sessions = [
    topic,
    child,
    session('dev', { parentId: 't', role: 'developer', title: 'Fix the login', status: 'running', createdAt: 3 }),
    session('sub', { parentId: 'c', role: null, origin: 'subagent', title: 'Explore', status: 'idle', createdAt: 4, items: [{ kind: 'user', at: 40 }] } as Partial<AgentSession>),
    session('sub2', { parentId: 'c', role: null, origin: 'subagent', title: 'Search', status: 'running', createdAt: 7 } as Partial<AgentSession>),
    session('g', { taskId: 'w1', role: 'groomer', status: 'idle', createdAt: 1 }),
    session('wd', { taskId: 'w1', stepId: 'w1.1', role: 'developer', status: 'idle', createdAt: 5, items: [approval] } as Partial<AgentSession>),
    session('wr', { taskId: 'w1', stepId: 'w1.1', role: 'reviewer', status: 'error', createdAt: 6 }),
    session('x', { taskId: 'w3', role: 'developer', status: 'running', createdAt: 2 }),
  ]
  const pr = { work: { dir: 'd', feedbackSeenAt: 0, repos: [
    { repo: 'r', branch: 'b', worktree: 'w', prUrl: 'https://github.com/o/r/pull/1', prState: 'closed' },
    { repo: 's', branch: 'b', worktree: 'w', prUrl: 'https://github.com/o/s/pull/2', prState: 'open' },
  ] } }
  const tasks = [
    task('w1', { ownerSessionId: 't' }),
    task('w1.1', { parentId: 'w1', key: 'W1.1', title: 'Step one', ...pr } as Partial<Task>),
    task('w3', { ownerSessionId: 'o' }),
  ]
  const got = topicAgents(topic, { tasks, sessions })
  const lines = (ls: typeof got.active) => ls.map((l) => `${l.role} · ${l.on} · ${l.state}${l.prUrl ? ` · ${l.prUrl}` : ''}`)
  assert.deepEqual(lines(got.active), [
    'developer · Step one · waiting · https://github.com/o/s/pull/2',
    'developer · Fix the login · working',
    'subagent · Search · working',
    'reviewer · Step one · failed · https://github.com/o/s/pull/2',
  ], "the open PR of the step; the subtopic c is not an agent; another topic's work's agent x is not here; idle Explore and the groomer are finished")
  assert.equal(got.working, 2)
  assert.deepEqual(got.active.map((l) => l.open), [{ kind: 'agent', sessionId: 'wd' }, { kind: 'select', id: 'dev' }, { kind: 'select', id: 'sub2' }, { kind: 'agent', sessionId: 'wr' }])
  // A subtopic lists only what is under it.
  assert.deepEqual(lines(topicAgents(child, { tasks, sessions }).active), ['subagent · Search · working'])
  // A work without a topic: its own agents.
  assert.deepEqual(lines(topicAgents(null, { tasks, sessions }, tasks[2]).active), ['developer · Work w3 · working'])
})

test('topicAgents: on a finished work an agent still running is live, one that failed is history; none live: an empty list', () => {
  const tasks = [task('w', { ownerSessionId: 't', status: 'done' })]
  const sessions = [topic, session('run', { taskId: 'w', role: 'reviewer', status: 'running' }), session('bad', { taskId: 'w', role: 'developer', status: 'error' })]
  assert.deepEqual(topicAgents(topic, { tasks, sessions }).active.map((l) => l.session.id), ['run'])
  assert.deepEqual(topicAgents(topic, { tasks, sessions: [topic, session('g', { taskId: 'w', role: 'groomer' })] }), { active: [], working: 0 })
})

test('treeWorks: a review made for a session of the tree is its own; open works first', () => {
  const t = session('t2', { reviewOf: 'r1' } as Partial<AgentSession>)
  const tasks = [task('r1', { type: 'review', status: 'in_progress', createdAt: 5 }), task('d', { ownerSessionId: 't2', status: 'done', createdAt: 9 }), task('n', { ownerSessionId: 't2', createdAt: 1 })]
  assert.deepEqual(treeWorks([t], tasks).map((w) => w.id), ['r1', 'n', 'd'])
})
