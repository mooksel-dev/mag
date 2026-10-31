import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.ts'

test('window bounds persist per kind without notifying listeners', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(file)
  let calls = 0
  store.onChange(() => calls++)
  const b = { x: 10, y: 20, width: 800, height: 600 }
  store.saveWindowBounds('canvas', b)
  store.flush()
  assert.equal(calls, 0)
  const again = new Store(file)
  assert.deepEqual(again.windowBounds('canvas'), b)
  assert.equal(again.windowBounds('doc'), undefined)
})

test('T-22 migration: per-repo work, subtasks as todo/done steps, their sessions and canvases on the parent', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', type: 'dev', description: '', needsInput: null, nextSubNo: 1, createdAt: 0, updatedAt: 0 }
  const legacy = (worktree: string, prUrl: string | null) => ({ repo: '/src/app', branch: 'mag/b', worktree, prUrl, feedbackSeenAt: 5 })
  const tasks = [
    { ...base, id: 'done', key: 'T-1', parentId: null, title: 'd', status: 'done', rank: 0, work: legacy('/w/T-1', 'https://github.com/o/r/pull/1') },
    { ...base, id: 'doneSub', key: 'T-1.1', parentId: 'done', title: 's', status: 'in_progress', rank: 0, work: legacy('/w/T-1.1', null) },
    { ...base, id: 'run', key: 'T-2', parentId: null, title: 'r', status: 'in_progress', rank: 1, work: null },
    { ...base, id: 'runSub1', key: 'T-2.1', parentId: 'run', title: 's1', status: 'done', rank: 0, work: legacy('/w/T-2.1', 'https://github.com/o/r/pull/2') },
    { ...base, id: 'runSub2', key: 'T-2.2', parentId: 'run', title: 's2', status: 'in_review', rank: 1, needsInput: 'x', work: legacy('/w/T-2.2', 'https://github.com/o/r/pull/3') },
    { ...base, id: 'review', key: 'T-3', parentId: null, title: 'v', status: 'in_review', rank: 2, work: legacy('/w/T-3', 'https://github.com/o/r/pull/4') },
  ]
  const sessions = [{ id: 's', projectId: 'p', taskId: 'runSub2', role: 'developer', agent: 'claude-code', nativeSessionId: 'n', status: 'idle', items: [], createdAt: 0 }]
  const canvases = { c: { id: 'c', projectId: 'p', taskId: 'runSub1', sessionId: null, title: 't', html: '', version: 1, updatedAt: 0 } }
  writeFileSync(file, JSON.stringify({ projects: [], tasks, sessions, canvases }))
  const store = new Store(file)
  const t = (id: string) => store.task(id)

  assert.deepEqual(t('review').work, {
    repos: [{ repo: '/src/app', branch: 'mag/b', worktree: '/w/T-3', prUrl: 'https://github.com/o/r/pull/4', prState: 'open', checkError: null }],
    dir: '/w/T-3',
    feedbackSeenAt: 5,
  })
  assert.equal(t('done').work?.repos[0].prState, 'merged')
  assert.deepEqual([t('doneSub').status, t('runSub1').status, t('runSub2').status], ['done', 'done', 'todo'])
  assert.deepEqual([t('doneSub').work, t('runSub2').work, t('runSub2').needsInput], [null, null, null])
  assert.equal(t('run').status, 'todo', 'started only through its subtasks: picked up again as a whole')
  assert.equal(t('review').status, 'in_progress', 'in review is in progress with an open PR')
  assert.equal(store.session('s').taskId, 'run')
  assert.equal(store.session('s').nativeSessionId, null)
  assert.equal(store.data.canvases.c.taskId, 'run')

  // Idempotent: loading the migrated file again changes nothing.
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data.tasks, store.data.tasks)
})

test('T-26 migration: groomed and planned become todo in queue order, in_review in progress, an archive flag', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', type: 'dev', description: '', needsInput: null, nextSubNo: 1, parentId: null, work: null, updatedAt: 0 }
  const task = (id: string, status: string, rank: number, createdAt: number, patch = {}) => ({ ...base, id, key: id, title: id, status, rank, createdAt, ...patch })
  const pr = { repos: [{ repo: '/r', branch: 'b', worktree: '/w/r', prUrl: 'https://github.com/o/r/pull/1', prState: 'open' }], dir: '/w', feedbackSeenAt: 0 }
  const tasks = [
    task('g2', 'groomed', 1, 20),
    task('p2', 'planned', 5, 1),
    task('g1', 'groomed', 99, 10),
    task('p1', 'planned', 4, 2),
    task('rev', 'in_review', 3, 0, { work: pr }),
    task('d', 'done', 2, 0),
    task('b', 'backlog', 0, 0),
    task('s', 'todo', 0, 0, { parentId: 'p1' }),
    task('q', 'groomed', 1, 0, { projectId: 'other' }),
  ]
  writeFileSync(file, JSON.stringify({ projects: [], tasks, sessions: [] }))
  const store = new Store(file)
  const t = (id: string) => store.task(id)
  const todo = store.data.tasks.filter((x) => x.projectId === 'p' && !x.parentId && x.status === 'todo').sort((a, b) => a.rank - b.rank)
  assert.deepEqual(todo.map((x) => x.id), ['p1', 'p2', 'g1', 'g2'], 'planned by rank, then groomed by creation')
  assert.equal(t('rev').status, 'in_progress')
  assert.equal(t('rev').work?.repos[0].prState, 'open')
  assert.deepEqual([t('d').status, t('b').status, t('s').status, t('q').status], ['done', 'backlog', 'todo', 'todo'])
  assert.ok(store.data.tasks.every((x) => x.archivedAt === null))

  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data.tasks, store.data.tasks, 'idempotent')
})

test('project windows and recent projects persist', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  writeFileSync(file, JSON.stringify({ projects: [], tasks: [], sessions: [], ui: { windows: {} } }))
  const store = new Store(file)
  assert.deepEqual(store.projectWindows(), [], 'older files get an empty list')
  assert.deepEqual(store.recent(), [])
  const b = { x: 0, y: 0, width: 900, height: 700 }
  store.setProjectWindows([{ projectId: 'a', bounds: b }])
  store.touchRecent('a')
  store.touchRecent('b')
  store.touchRecent('a')
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.projectWindows(), [{ projectId: 'a', bounds: b }])
  assert.deepEqual(again.recent(), ['a', 'b'])
})

test('T-28 migration: steps for todo and in-progress tasks, legacy tasks untouched, once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', type: 'dev', description: '', needsInput: null, nextSubNo: 1, parentId: null, work: null, rank: 0, archivedAt: null, createdAt: 0, updatedAt: 0 }
  const task = (id: string, status: string, patch = {}) => ({ ...base, id, key: id, title: `title ${id}`, status, ...patch })
  const work = { repos: [{ repo: '/r', branch: 'b', worktree: '/w/r', prUrl: null, prState: null }], dir: '/w', feedbackSeenAt: 0 }
  const tasks = [
    task('T-1', 'todo'),
    task('T-2', 'todo', { nextSubNo: 3 }),
    task('T-2.1', 'done', { parentId: 'T-2' }),
    task('T-2.2', 'todo', { parentId: 'T-2' }),
    task('T-3', 'in_progress', { work }),
    task('T-4', 'backlog'),
    task('T-5', 'done'),
    task('T-6', 'in_progress'),
  ]
  const sessions = [{ id: 's', projectId: 'p', taskId: 'T-3', role: 'developer', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], createdAt: 0 }]
  writeFileSync(file, JSON.stringify({ projects: [], tasks, sessions }))
  const store = new Store(file)
  const steps = (id: string) => store.data.tasks.filter((t) => t.parentId === id)

  const [one] = steps('T-1')
  assert.equal(steps('T-1').length, 1)
  assert.deepEqual([one.key, one.title, one.status, one.work, one.startManually], ['T-1.1', 'title T-1', 'todo', null, false])
  assert.deepEqual(steps('T-2').map((s) => [s.key, s.status, s.startManually]), [['T-2.1', 'done', false], ['T-2.2', 'todo', false]], 'checklist becomes steps')
  assert.deepEqual(steps('T-6').map((s) => s.title), ['title T-6'])
  assert.deepEqual([steps('T-3'), steps('T-4'), steps('T-5')], [[], [], []], 'legacy, backlog and done tasks get none')
  assert.deepEqual(store.task('T-3').work, work)
  assert.equal(store.session('s').stepId, null)

  // Once: a todo task without steps later is not given one again.
  store.deleteTask(one.id)
  store.flush()
  const again = new Store(file)
  assert.equal(again.data.tasks.filter((t) => t.parentId === 'T-1').length, 0)
})

test('T-27 migration: apps become top-level modules, uses get calls, repeated ids get the app prefix', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const node = (id: string, uses: string[]) => ({ id, name: id, layer: 'service', description: 'd', uses })
  const architecture = {
    summary: 's',
    updatedAt: 7,
    apps: [
      { name: 'Desktop App', kind: 'Electron app', nodes: [node('store', []), node('tasks', ['store', 'gone'])] },
      { name: 'Web', nodes: [node('store', []), node('ui', ['store'])] },
    ],
  }
  const project = { id: 'p', name: 'p', repos: [], notes: '', templates: {}, nextTaskNo: 1, architecture }
  writeFileSync(file, JSON.stringify({ projects: [project, { ...project, id: 'q', architecture: null }], tasks: [], sessions: [], canvases: {} }))
  const store = new Store(file)
  const arch = store.project('p').architecture!
  assert.deepEqual(
    arch.modules.map((m) => ({ id: m.id, kind: m.kind, children: m.children!.map((c) => [c.id, c.uses]) })),
    [
      { id: 'desktop-app', kind: 'Electron app', children: [['store', []], ['tasks', [{ to: 'store', calls: [] }]]] },
      { id: 'web', kind: undefined, children: [['web-store', []], ['ui', [{ to: 'web-store', calls: [] }]]] },
    ],
  )
  assert.equal(arch.summary, 's')
  assert.equal(arch.updatedAt, 7)
  assert.equal(store.project('q').architecture, null)
  assert.deepEqual(new Store(file).project('p').architecture, arch)
})

test('a restart ends live processes: running turns go idle, background tasks are cleared with a notice', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: 'n', items: [], createdAt: 0 }
  const sessions = [
    { ...base, id: 'bg', status: 'idle', live: true, background: [{ id: 't1', name: 'Monitor' }] },
    { ...base, id: 'turn', status: 'running', live: true, background: [] },
  ]
  writeFileSync(file, JSON.stringify({ projects: [], tasks: [], sessions }))
  const store = new Store(file)
  const [bg, turn] = [store.session('bg'), store.session('turn')]
  assert.equal(bg.live, undefined)
  assert.equal(bg.background, undefined)
  assert.deepEqual(bg.items.map((i) => i.kind === 'notice' && i.text), ['Background tasks ended with the process'])
  assert.equal(turn.status, 'idle')
  assert.equal(turn.live, undefined)
  assert.deepEqual(turn.items, [])
})
