import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagramGroups, linkedCanvasIds, stepDiagrams, taskDiagrams, type Canvas, type Task } from './index.ts'

const canvas = (id: string, patch: Partial<Canvas> = {}): Canvas => ({
  id,
  projectId: 'p',
  taskId: 'w',
  sessionId: null,
  title: id,
  kind: 'diagram',
  diagram: { type: 'state', entity: 'Job', states: [{ id: 'a' }], transitions: [] },
  version: 1,
  updatedAt: 0,
  ...patch,
})
const step = (id: string): Task => ({
  id,
  projectId: 'p',
  key: id,
  parentId: 'w',
  title: id,
  type: 'dev',
  status: 'todo',
  description: '',
  rank: 0,
  needsInput: null,
  work: null,
  nextSubNo: 1,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
})
const ids = (cs: { id: string }[]) => cs.map((c) => c.id)

test('linkedCanvasIds: canvas links outside code, each once, in order', () => {
  const md = '[a](canvas:a) and [node](canvas:b#x.y)\n`[c](canvas:c)`\n```\n[d](canvas:d)\n```\n[a again](canvas:a) (canvas:e)'
  assert.deepEqual(linkedCanvasIds(md), ['a', 'b'])
})

test('taskDiagrams: own diagrams first, then diagrams of other tasks the doc links; HTML and other projects are left out', () => {
  const cs = [
    canvas('own2'),
    canvas('html', { kind: 'html', diagram: undefined, html: '<p/>' }),
    canvas('t54', { taskId: 't54' }),
    canvas('elsewhere', { projectId: 'q', taskId: null }),
    canvas('unlinked', { taskId: 't54' }),
    canvas('own1'),
  ]
  const doc = '[t54](canvas:t54) [html](canvas:html) [own](canvas:own1) [q](canvas:elsewhere)'
  assert.deepEqual(ids(taskDiagrams({ id: 'w', projectId: 'p' }, doc, cs)), ['own2', 'own1', 't54'])
  assert.deepEqual(ids(taskDiagrams({ id: 'w', projectId: 'p' }, undefined, cs)), ['own2', 'own1'])
})

test('diagramGroups: options by name, plan by step then repo, the rest unplaced', () => {
  const cs = [
    canvas('loose'),
    canvas('optB', { role: 'option', option: 'B' }),
    canvas('optA1', { role: 'option', option: 'A' }),
    canvas('s2wide', { role: 'plan', stepId: 's2' }),
    canvas('s2api', { role: 'plan', stepId: 's2', repo: '/r/api' }),
    canvas('s2web', { role: 'plan', stepId: 's2', repo: '/r/web' }),
    canvas('s1api', { role: 'plan', stepId: 's1', repo: '/r/api' }),
    canvas('gone', { role: 'plan', stepId: 'deleted' }),
    canvas('optA2', { role: 'option', option: 'A' }),
  ]
  const g = diagramGroups(cs, [step('s1'), step('s2'), step('s3')], ['/r/web', '/r/api'])
  assert.deepEqual(g.options.map((o) => [o.option, ids(o.diagrams)]), [['B', ['optB']], ['A', ['optA1', 'optA2']]])
  assert.deepEqual(
    g.plan.map((p) => [p.step.id, p.repos.map((r) => [r.repo, ids(r.diagrams)])]),
    [
      ['s1', [['/r/api', ['s1api']]]],
      ['s2', [['/r/web', ['s2web']], ['/r/api', ['s2api']], [null, ['s2wide']]]],
    ],
  )
  assert.deepEqual(ids(g.other), ['loose', 'gone'])
  assert.deepEqual(ids(stepDiagrams(cs, 's2')), ['s2wide', 's2api', 's2web'])
})
