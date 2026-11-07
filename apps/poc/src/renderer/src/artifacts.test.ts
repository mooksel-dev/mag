import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentReview, AgentSession, Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import { topicArtifacts, treeWorks, workTarget, type TopicArtifacts } from './artifacts.ts'

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

/** Each work's line, its chips in [], then its steps' lines; "This chat" last. */
const shape = (a: TopicArtifacts) => [
  ...a.works.flatMap((w) => [
    `${w.work.key} [${w.chips.map((c) => c.label).join(', ')}]`,
    ...w.steps.map((s) => `  ${s.no} · ${s.step.title} · ${s.phase} [${s.chips.map((c) => c.label).join(', ')}]`),
  ]),
  ...(a.loose.length ? [`This chat [${a.loose.map((c) => c.label).join(', ')}]`] : []),
]

test("topicArtifacts: by work, then by step; a step's plan, fact and review are chips on its line", () => {
  const list = topicArtifacts(topic, state())
  assert.deepEqual(shape(list), ['W2 [mock]', 'W1 [doc]', '  1 · Step one · todo [plan, fact, review: changes]'])
  assert.equal(list.count, 7, 'two works and five chips')
  const step = list.works[1].steps[0]
  const plan = step.chips[0]
  assert.equal(plan.title, 'plan-root · 2 diagrams', 'a set is one chip; its title is the tooltip')
  assert.deepEqual(plan.open, { kind: 'canvas', id: 'plan-root' })
  const review = step.chips[2]
  assert.deepEqual([review.open, review.tone], [{ kind: 'review', taskId: 'w1.1' }, 'red'])
  assert.deepEqual(list.works[1].open, { kind: 'work', taskId: 'w1' })
  assert.deepEqual(list.works[1].chips[0].open, { kind: 'doc', taskId: 'w1' })
})

test('topicArtifacts: a session under a topic lists its own part of the tree only', () => {
  assert.deepEqual(shape(topicArtifacts(child, state())), ['W2 [mock]'])
})

test('topicArtifacts: a work without a topic lists its own, with what its owner drew before it; a review is its report', () => {
  assert.deepEqual(shape(topicArtifacts(null, state(), task('w3', { ownerSessionId: 'o', updatedAt: 30 }))), ['W3 [elsewhere, loose-other]'])
  const r = state().tasks.find((t) => t.id === 'r1')!
  const reviewed = topicArtifacts(null, state(), r)
  assert.deepEqual(reviewed.works.map((w) => w.open), [{ kind: 'review', taskId: 'r1' }])
  assert.equal(reviewed.count, 1)
  assert.deepEqual(workTarget(r), { kind: 'review', taskId: 'r1' })
  assert.deepEqual(workTarget(task('w1')), { kind: 'work', taskId: 'w1' })
  assert.deepEqual(topicArtifacts(null, state()), { works: [], loose: [], count: 0 })
})

test('topicArtifacts: a canvas two works list shows once, on the line of the work it belongs to; a set root linked from another task is not duplicated', () => {
  const s = state({ docs: { w1: '[x](canvas:elsewhere)', w2: '[x](canvas:elsewhere) [y](canvas:plan-root)' } })
  const list = topicArtifacts(topic, s)
  const keys = [...list.works.flatMap((w) => [...w.chips, ...w.steps.flatMap((st) => st.chips)]), ...list.loose].map((c) => c.key)
  assert.equal(keys.filter((k) => k === 'canvas:elsewhere').length, 1)
  assert.equal(keys.filter((k) => k === 'canvas:plan-root').length, 1)
  // W2's doc links W1.1's plan: it stays on its step's line.
  assert.deepEqual(shape(list), ['W2 [doc, elsewhere, mock]', 'W1 [doc]', '  1 · Step one · todo [plan, fact, review: changes]'])
})

test("topicArtifacts: steps in order with their phase; options on the work's line; what the tree drew outside a work is This chat", () => {
  const repo = (prState: string) => ({ work: { dir: 'd', feedbackSeenAt: 0, repos: [{ repo: 'r', branch: 'b', worktree: 'w', prUrl: 'https://github.com/o/r/pull/1', prState }] } })
  const s = state({
    tasks: [
      task('w', { ownerSessionId: 't', status: 'in_progress' }),
      task('w.1', { parentId: 'w', key: 'W.1', title: 'Model', status: 'done', ...repo('merged'), review: { ...review, verdict: 'merge' } } as Partial<Task>),
      task('w.2', { parentId: 'w', key: 'W.2', title: 'Notes', status: 'done' }),
      task('w.3', { parentId: 'w', key: 'W.3', title: 'Rows', status: 'in_progress', ...repo('open') } as Partial<Task>),
      task('w.4', { parentId: 'w', key: 'W.4', title: 'UI', status: 'in_progress' }),
      task('w.5', { parentId: 'w', key: 'W.5', title: 'Docs', status: 'todo' }),
    ],
    canvases: [
      canvas('optB', { taskId: 'w', role: 'option', option: 'B' }),
      canvas('optA', { taskId: 'w', role: 'option', option: 'A' }),
      canvas('sketch', { taskId: null, sessionId: 'c', kind: 'html', diagram: undefined }),
    ],
    docs: {},
  })
  const list = topicArtifacts(topic, s)
  assert.deepEqual(shape(list), [
    'W [option A, option B]',
    '  1 · Model · merged [review: merge]',
    '  2 · Notes · done []',
    '  3 · Rows · in review []',
    '  4 · UI · working []',
    '  5 · Docs · todo []',
    'This chat [sketch]',
  ])
  assert.equal(list.works[0].steps[0].chips[0].tone, 'green')
})

test('treeWorks: a review made for a session of the tree is its own; open works first', () => {
  const t = session('t2', { reviewOf: 'r1' } as Partial<AgentSession>)
  const tasks = [task('r1', { type: 'review', status: 'in_progress', createdAt: 5 }), task('d', { ownerSessionId: 't2', status: 'done', createdAt: 9 }), task('n', { ownerSessionId: 't2', createdAt: 1 })]
  assert.deepEqual(treeWorks([t], tasks).map((w) => w.id), ['r1', 'n', 'd'])
})
