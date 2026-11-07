import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentReview, AgentSession, Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import { topicArtifacts, treeWorks, workTarget } from './artifacts.ts'

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

test('topicArtifacts: by kind, newest first, of the whole tree and the works its sessions own', () => {
  const list = topicArtifacts(topic, state())
  assert.deepEqual(list.map((a) => a.key), ['work:w2', 'work:w1', 'doc:w1', 'review:w1.1', 'canvas:fact', 'canvas:plan-root', 'canvas:mock'])
  const plan = list.find((a) => a.key === 'canvas:plan-root')!
  assert.equal(plan.detail, 'plan · W1.1 · 2 diagrams', 'a set is one artifact')
  assert.equal(plan.at, 7, 'a set is as new as its newest diagram')
  assert.deepEqual(list.find((a) => a.kind === 'review')!.open, { kind: 'review', taskId: 'w1.1' })
  assert.match(list.find((a) => a.kind === 'review')!.detail, /changes · 1 finding/)
})

test('topicArtifacts: a session under a topic lists its own part of the tree only', () => {
  assert.deepEqual(topicArtifacts(child, state()).map((a) => a.key), ['work:w2', 'canvas:mock'])
})

test('topicArtifacts: a work without a topic lists its own, with what its owner drew before it; a review is its report', () => {
  assert.deepEqual(topicArtifacts(null, state(), task('w3', { ownerSessionId: 'o', updatedAt: 30 })).map((a) => a.key), ['work:w3', 'canvas:elsewhere', 'canvas:loose-other'])
  const r = state().tasks.find((t) => t.id === 'r1')!
  assert.deepEqual(topicArtifacts(null, state(), r).map((a) => a.open), [{ kind: 'review', taskId: 'r1' }])
  assert.deepEqual(workTarget(r), { kind: 'review', taskId: 'r1' })
  assert.deepEqual(workTarget(task('w1')), { kind: 'work', taskId: 'w1' })
  assert.deepEqual(topicArtifacts(null, state()), [])
})

test('topicArtifacts: a canvas two works list shows once; a set root linked from another task is not duplicated', () => {
  const s = state({ docs: { w1: '[x](canvas:elsewhere)', w2: '[x](canvas:elsewhere) [y](canvas:plan-root)' } })
  const keys = topicArtifacts(topic, s).map((a) => a.key)
  assert.equal(keys.filter((k) => k === 'canvas:elsewhere').length, 1)
  assert.equal(keys.filter((k) => k === 'canvas:plan-root').length, 1)
})

test('treeWorks: a review made for a session of the tree is its own; open works first', () => {
  const t = session('t2', { reviewOf: 'r1' } as Partial<AgentSession>)
  const tasks = [task('r1', { type: 'review', status: 'in_progress', createdAt: 5 }), task('d', { ownerSessionId: 't2', status: 'done', createdAt: 9 }), task('n', { ownerSessionId: 't2', createdAt: 1 })]
  assert.deepEqual(treeWorks([t], tasks).map((w) => w.id), ['r1', 'n', 'd'])
})
