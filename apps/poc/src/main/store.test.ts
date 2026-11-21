import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem, SessionItemEvent } from '@mag/core'
import { appState } from './state.ts'
import { mirrorItems } from './item-mirror.test-util.ts'
import { DatabaseSync } from 'node:sqlite'
import { backupName as dbBackupName } from './core/clients/workspace-db/index.ts'
import { logTail } from './log.ts'
import { Store, WORKSPACE_MAP, backupDaily, backupName, writeAtomic } from './store.ts'

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
  assert.equal(t('run').status, 'ready', 'started only through its subtasks: picked up again as a whole (todo then, ready since T-55.7)')
  assert.equal(t('review').status, 'in_progress', 'in review is in progress with an open PR')
  assert.equal(store.session('s').taskId, 'run')
  assert.equal(store.session('s').nativeSessionId, null)
  assert.equal(store.data.canvases.c.taskId, 'run')
  assert.equal(store.data.canvases.c.kind, 'html', 'canvases before T-27 are HTML')

  // Idempotent: loading the migrated file again changes nothing.
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data.tasks, store.data.tasks)
})

test('T-26 migration: groomed and planned become todo (ready since T-55.7), in_review in progress', () => {
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
  writeFileSync(file, JSON.stringify({ projects: [{ id: 'p', name: 'p', repos: [], notes: '' }], tasks, sessions: [] }))
  const store = new Store(file)
  const t = (id: string) => store.task(id)
  const ready = store.data.tasks.filter((x) => x.projectId === 'p' && !x.parentId && x.status === 'ready')
  assert.deepEqual(ready.map((x) => x.id).sort(), ['g1', 'g2', 'p1', 'p2'])
  assert.equal(t('rev').status, 'in_progress')
  assert.equal(t('rev').work?.repos[0].prState, 'open')
  assert.deepEqual([t('d').status, t('s').status, t('q').status], ['done', 'todo', 'ready'])
  assert.deepEqual(store.data.sessions.filter((s) => s.brief).map((s) => [s.brief, !!s.parkedAt]), [['b', true]], 'the backlog task is an idea, a parked topic now (T-55.7)')

  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data.tasks, store.data.tasks, 'idempotent')
})

test('T-55.5 migration: the tracker link becomes tickets; no tracker settings', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const projects = [{ id: 'p', name: 'p', repos: [], trackers: [{ kind: 'jira', scope: 'ABC', base: 'https://acme.atlassian.net' }] }]
  const base = { projectId: 'p', parentId: null, title: 't', type: 'dev', status: 'grooming', description: '', needsInput: null, nextSubNo: 1, rank: 0, work: null, createdAt: 0, updatedAt: 0 }
  const tasks = [
    { ...base, id: 'a', key: 'T-1', tracker: { kind: 'jira', key: 'ABC-1', url: 'https://acme.atlassian.net/browse/ABC-1', importedAt: 5 } },
    { ...base, id: 'b', key: 'T-2', tracker: { kind: 'jira', key: 'ABC-2', url: null, importedAt: null } },
    { ...base, id: 'c', key: 'T-3', tracker: null },
  ]
  writeFileSync(file, JSON.stringify({ projects, tasks, sessions: [] }))
  const store = new Store(file)
  assert.equal('trackers' in store.project('p'), false)
  assert.deepEqual(store.task('a').tickets, [{ url: 'https://acme.atlassian.net/browse/ABC-1', key: 'ABC-1' }])
  assert.equal(store.task('b').tickets, undefined, 'no URL, no ticket')
  assert.ok(['a', 'b', 'c'].every((id) => !('tracker' in store.task(id))))
})

test('T-55.7 migration: work states, an untouched backlog becomes ideas, no archive, T-N counter or auto-archive', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const projects = [{ id: 'p', name: 'p', repos: [], notes: '', templates: {}, nextTaskNo: 9, autoArchiveDays: 14 }]
  const base = { projectId: 'p', type: 'dev', description: '', needsInput: null, nextSubNo: 1, parentId: null, work: null, rank: 0, archivedAt: null, createdAt: 0, updatedAt: 0 }
  const task = (id: string, status: string, patch = {}) => ({ ...base, id, key: id, title: `title ${id}`, status, ...patch })
  const tasks = [
    task('T-1', 'grooming'),
    task('T-2', 'todo', { nextSubNo: 2 }),
    task('T-2.1', 'todo', { parentId: 'T-2' }),
    task('T-3', 'done', { archivedAt: 5 }),
    task('T-4', 'backlog', { description: ' why ', createdAt: 7, tickets: [{ url: 'https://x/browse/ABC-1', key: 'ABC-1' }] }),
    task('T-5', 'backlog'),
    task('T-6', 'backlog'),
    task('T-7', 'backlog'),
    task('T-8', 'backlog'),
  ]
  const sessions = [{ id: 's', projectId: 'p', taskId: 'T-5', role: 'groomer', agent: 'claude-code', nativeSessionId: null, status: 'error', items: [], createdAt: 0 }]
  const canvases = { c: { id: 'c', projectId: 'p', taskId: 'T-6', sessionId: null, title: 't', kind: 'diagram', version: 1, updatedAt: 0 } }
  const docs = { 'T-4': '  ', 'T-7': '# Problem' }
  const steps = [task('T-8.1', 'todo', { parentId: 'T-8' })]
  writeFileSync(file, JSON.stringify({ projects, tasks: [...tasks, ...steps], sessions, canvases, docs, stepsMigrated: true }))
  const store = new Store(file)
  const status = (id: string) => store.task(id).status
  assert.deepEqual([status('T-1'), status('T-2'), status('T-2.1'), status('T-3')], ['planning', 'ready', 'todo', 'done'])
  assert.deepEqual(['T-5', 'T-6', 'T-7', 'T-8'].map(status), ['planning', 'planning', 'planning', 'planning'], 'a backlog task with a session, diagram, doc or step has a state')
  assert.equal(store.data.tasks.some((t) => t.id === 'T-4'), false)
  assert.equal('T-4' in store.data.docs, false)
  const idea = store.data.sessions.find((s) => s.parkedAt)
  assert.deepEqual(idea && { projectId: idea.projectId, brief: idea.brief, title: idea.title, parkedAt: idea.parkedAt }, { projectId: 'p', brief: 'title T-4\n\nwhy\n\nhttps://x/browse/ABC-1', title: 'title T-4', parkedAt: 7 })
  assert.ok(store.data.tasks.every((t) => !('archivedAt' in t)))
  assert.deepEqual(['nextTaskNo' in store.project('p'), 'autoArchiveDays' in store.project('p')], [false, false])

  store.flush()
  const again = new Store(file)
  assert.deepEqual([again.data.tasks, again.data.sessions], [store.data.tasks, store.data.sessions], 'idempotent')
})

test('new works: keyed by their first ticket or title, in planning; steps by their work (T-55.7)', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const p = store.createProject('p')
  const a = store.createTask({ projectId: p.id, title: 'Fix login', type: 'dev', description: '', tickets: [{ url: 'https://x/browse/ABC-12', key: 'ABC-12' }] })
  const b = store.createTask({ projectId: p.id, title: 'Fix login', type: 'dev', description: '' })
  const c = store.createTask({ projectId: p.id, title: 'Fix login', type: 'dev', description: '' })
  const step = store.createTask({ projectId: p.id, parentId: a.id, title: 's', type: 'dev', description: '' })
  assert.deepEqual([a.key, b.key, c.key, step.key], ['ABC-12', 'fix-login', 'fix-login-2', 'ABC-12.1'])
  assert.deepEqual([a.status, step.status, a.rank, step.rank], ['planning', 'todo', 0, 1])
  assert.equal('nextTaskNo' in p, false)
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
  const base = { projectId: 'p', type: 'dev', description: '', needsInput: null, nextSubNo: 1, parentId: null, work: null, rank: 0, createdAt: 0, updatedAt: 0 }
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

test('deleteSession removes only the session; project canvases and events stay', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const p = store.createProject('p')
  const s = store.createSession({ projectId: p.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Topic' })
  const other = store.createSession({ projectId: p.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const c = store.saveCanvas({ projectId: p.id, taskId: null, sessionId: s.id, title: 'mock', kind: 'html', html: '<p>' })
  store.logEvent({ projectId: p.id, taskId: null, taskKey: null, kind: 'architecture', text: 'x' })
  store.deleteSession(s.id)
  assert.deepEqual(store.data.sessions.map((x) => x.id), [other.id])
  assert.ok(store.data.canvases[c.id])
  assert.equal(store.data.events.length, 1)
  assert.throws(() => store.deleteSession(s.id), /No session/)
})

test('deleteCanvas removes that canvas and persists; a canvas that is gone is an error (right-panel-only-what-is.1)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(path)
  const p = store.createProject('p')
  const c = store.saveCanvas({ projectId: p.id, taskId: null, sessionId: null, title: 'mock', kind: 'html', html: '<p>' })
  const other = store.saveCanvas({ projectId: p.id, taskId: null, sessionId: null, title: 'other', kind: 'html', html: '<p>' })
  store.deleteCanvas(c.id)
  assert.deepEqual(store.canvasList().map((x) => x.id), [other.id])
  assert.throws(() => store.deleteCanvas(c.id), /No canvas/)
  store.flush()
  assert.deepEqual(Object.keys(new Store(path).data.canvases), [other.id])
})

test('closeSession keeps the history and persists; reopenSession opens it again', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(file)
  const p = store.createProject('p')
  const s = store.createSession({ projectId: p.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Topic' })
  store.pushItem(s.id, { kind: 'user', text: 'hi', at: 1 })
  store.closeSession(s.id)
  store.flush()
  const again = new Store(file)
  assert.ok(again.session(s.id).closedAt)
  assert.deepEqual(again.session(s.id).items.map((i) => i.kind), ['user'])
  again.reopenSession(s.id)
  assert.equal(again.session(s.id).closedAt, null)
  assert.throws(() => again.closeSession('nope'), /No session/)
})

test('closeTask keeps a done work\'s and a review\'s doc, sessions and history; reopenTask brings them back', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(file)
  const p = store.createProject('p')
  const work = store.createTask({ projectId: p.id, title: 'w', type: 'dev', description: '', status: 'done' })
  const review = store.createTask({ projectId: p.id, title: 'app#1: x', type: 'review', description: '', status: 'done' })
  assert.deepEqual([work.closedAt, review.closedAt], [null, null])
  for (const t of [work, review]) {
    const s = store.createSession({ projectId: p.id, taskId: t.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
    store.pushItem(s.id, { kind: 'user', text: 'hi', at: 1 })
    store.data.docs[t.id] = '# Doc'
    store.closeTask(t.id)
  }
  store.flush()
  const again = new Store(file)
  for (const t of [work, review]) {
    const got = again.task(t.id)
    assert.ok(got.closedAt)
    assert.equal(got.status, 'done')
    assert.equal(again.data.docs[t.id], '# Doc')
    assert.deepEqual(again.data.sessions.filter((s) => s.taskId === t.id).map((s) => s.items.length), [1])
    again.reopenTask(t.id)
    assert.equal(again.task(t.id).closedAt, null)
  }
})

test('closed-mark migration: every task gets closedAt; a review closed before it (done, not imported) is closed', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', description: '', needsInput: null, nextSubNo: 1, createdAt: 0, updatedAt: 7, parentId: null, rank: 0, work: null }
  writeFileSync(file, JSON.stringify({
    schemaVersion: 6,
    projects: [{ id: 'p', name: 'p', repos: [], notes: '', templates: {}, baseBranch: 'main', enforceArchitecture: false, architecture: null, archRun: null, agents: {}, integrations: {}, createdAt: 0 }],
    tasks: [
      { ...base, id: 'r', key: 'R', title: 'app#1: x', type: 'review', status: 'done' },
      { ...base, id: 'i', key: 'I', title: 'app#2: y', type: 'review', status: 'done', imported: { at: 1, from: 'x', diffPath: '/d' } },
      { ...base, id: 'w', key: 'W', title: 'w', type: 'dev', status: 'done' },
    ],
    sessions: [], docs: {}, canvases: {}, events: [], ideas: [],
  }))
  const store = new Store(file)
  assert.deepEqual(['r', 'i', 'w'].map((id) => store.task(id).closedAt), [7, null, null])
})

test('deleteTask removes the task with its sessions, doc and canvases; others stay', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const p = store.createProject('p')
  const work = store.createTask({ projectId: p.id, title: 'w', type: 'dev', description: '' })
  const other = store.createTask({ projectId: p.id, title: 'o', type: 'dev', description: '' })
  const dev = store.createSession({ projectId: p.id, taskId: work.id, role: 'developer', agent: 'claude-code', status: 'idle' })
  const keep = store.createSession({ projectId: p.id, taskId: other.id, role: 'groomer', agent: 'claude-code', status: 'idle' })
  store.data.docs[work.id] = '# Problem'
  store.data.docs[other.id] = '# Other'
  const c = store.saveCanvas({ projectId: p.id, taskId: work.id, sessionId: null, title: 'mock', kind: 'html', html: '<p>' })
  store.deleteTask(work.id)
  assert.deepEqual(store.data.tasks.map((t) => t.id), [other.id])
  assert.deepEqual(store.data.sessions.map((s) => s.id), [keep.id])
  assert.equal(store.data.docs[work.id], undefined)
  assert.equal(store.data.docs[other.id], '# Other')
  assert.equal(store.data.canvases[c.id], undefined)
  assert.ok(!store.data.sessions.some((s) => s.id === dev.id))
})

test('parkTopic: an idea is a parked chat topic titled after its text, with its brief and source; it persists (ideas-are-parked-topics.1)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(file)
  const p = store.createProject('p')
  const a = store.parkTopic(p.id, ' cache rates \nthe API is slow ', 'T-1.2')
  const b = store.parkTopic(p.id, 'dark mode')
  assert.deepEqual(
    [a.role, a.taskId, a.title, a.titleGenerated, a.brief, a.source, a.agent, typeof a.parkedAt],
    ['chat', null, 'cache rates', true, 'cache rates \nthe API is slow', 'T-1.2', 'claude-code', 'number'],
  )
  assert.equal(b.source, null)
  assert.throws(() => store.parkTopic(p.id, ' \n'), /An idea needs a text/)
  assert.throws(() => store.parkTopic('nope', 'x'), /No project nope/)
  store.flush()
  assert.deepEqual(new Store(file).data.sessions.map((s) => [s.brief, !!s.parkedAt]), [['cache rates \nthe API is slow', true], ['dark mode', true]])
})

test('parked-topics migration: an idea without a topic or with an empty one is a parked topic; one whose topic has messages stays live with its brief (ideas-are-parked-topics.1)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', taskId: null, role: 'chat', agent: 'codex', nativeSessionId: 'n', status: 'idle', items: [], createdAt: 1 }
  const said = [{ kind: 'user', text: 'what about web?', at: 2 }, { kind: 'assistant', text: 'web too', at: 3 }]
  writeFileSync(file, JSON.stringify({
    projects: [{ id: 'p', name: 'p', repos: [], agents: { chat: { agent: 'codex' } } }], tasks: [], docs: {}, canvases: {}, events: [], integrations: [], schemaVersion: 8,
    sessions: [
      { ...base, id: 'empty', title: 'Dark mode', titleGenerated: true, closedAt: 4 },
      { ...base, id: 'talked', title: 'Retry logic', titleGenerated: true, items: said },
    ],
    ideas: [
      { id: 'i1', projectId: 'p', text: ' Cache rates\nthe API is slow ', createdAt: 10, source: 'T-3.1' },
      { id: 'i2', projectId: 'p', text: 'Dark mode everywhere', createdAt: 11, topicId: 'empty' },
      { id: 'i3', projectId: 'p', text: 'Retry logic is duplicated', createdAt: 12, topicId: 'talked' },
      { id: 'i4', projectId: 'p', text: 'A topic deleted since', createdAt: 13, topicId: 'gone' },
      { id: 'i5', projectId: 'gone', text: 'Of a deleted project', createdAt: 14 },
    ],
  }))
  const store = new Store(file, 'json')
  const shape = () => store.data.sessions.map((s) => [s.id === 'empty' || s.id === 'talked' ? s.id : 'new', s.title, s.brief, s.source ?? null, s.parkedAt ?? null, s.closedAt ?? null])
  const expected = [
    ['empty', 'Dark mode everywhere', 'Dark mode everywhere', null, 11, null],
    ['talked', 'Retry logic', 'Retry logic is duplicated', null, null, null],
    ['new', 'Cache rates', 'Cache rates\nthe API is slow', 'T-3.1', 10, null],
    ['new', 'A topic deleted since', 'A topic deleted since', null, 13, null],
  ]
  assert.deepEqual(shape(), expected)
  assert.deepEqual(store.data.sessions.filter((s) => s.id !== 'empty' && s.id !== 'talked').map((s) => [s.role, s.taskId, s.agent, s.titleGenerated, s.items.length]), [['chat', null, 'codex', true, 0], ['chat', null, 'codex', true, 0]])
  assert.equal(store.session('talked').items.length, 2, 'its history stays')
  assert.equal('ideas' in store.data, false)
  assert.equal(store.data.schemaVersion, 14)
  store.flush()
  const again = new Store(file, 'json')
  assert.equal('ideas' in JSON.parse(readFileSync(file, 'utf8')), false)
  assert.deepEqual(again.data.sessions, store.data.sessions, 'once')
})

test('a restart keeps a step in progress: its work, PR, sessions and diagrams stay; migrations run once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(file, 'json')
  const p = store.createProject('p')
  const topic = store.createSession({ projectId: p.id, taskId: null, stepId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const task = store.createTask({ projectId: p.id, title: 'Fix restart', type: 'dev', description: '', ownerSessionId: topic.id })
  const step = store.createTask({ projectId: p.id, parentId: task.id, title: 's1', type: 'dev', description: '' })
  store.createTask({ projectId: p.id, parentId: task.id, title: 's2', type: 'dev', description: '' })
  const work = { repos: [{ repo: '/src/mag', branch: 'mag/fix-restart-1', worktree: '/w/mag', prUrl: 'https://github.com/o/r/pull/66', prState: 'open' as const, checkError: null }], dir: '/w/s1', feedbackSeenAt: 5 }
  store.updateTask(task.id, { status: 'in_progress' })
  store.updateTask(step.id, { status: 'in_progress', work })
  const sessions = (['developer', 'reviewer'] as const).map((role) => store.createSession({ projectId: p.id, taskId: task.id, stepId: step.id, role, agent: 'claude-code', status: 'idle' }))
  sessions.forEach((s, i) => (s.nativeSessionId = `native-${i}`))
  const legacyStepSession = store.createSession({ projectId: p.id, taskId: step.id, stepId: null, role: 'developer', agent: 'claude-code', status: 'idle' })
  legacyStepSession.nativeSessionId = 'native-step'
  store.saveCanvas({ projectId: p.id, taskId: step.id, sessionId: null, title: 'step page', kind: 'html', html: '<p/>' })
  store.saveCanvas({ projectId: p.id, taskId: task.id, sessionId: null, title: 'plan', kind: 'html', html: '<p/>', placement: { role: 'plan', option: null, stepId: step.id, repo: null, planOf: null } })
  store.flush()
  const saved = structuredClone({ tasks: store.data.tasks, sessions: store.data.sessions, canvases: store.data.canvases })
  assert.equal(store.data.schemaVersion, 14, 'a new file has had every migration')

  const restart = (patch: (d: Record<string, unknown>) => void) => {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    patch(d)
    writeFileSync(file, JSON.stringify(d))
    for (let i = 0; i < 2; i++) {
      const again = new Store(file, 'json')
      assert.deepEqual({ tasks: again.data.tasks, sessions: again.data.sessions, canvases: again.data.canvases }, saved)
      assert.equal(again.data.schemaVersion, 14)
      assert.equal('stepsMigrated' in again.data, false)
      again.flush()
    }
  }
  restart(() => {})
  // A file from before schemaVersion: the current model says the old migrations have run.
  restart((d) => {
    delete d.schemaVersion
    d.stepsMigrated = true
  })
  // Even if every migration ran again, the T-22 one leaves current steps and their work alone.
  restart((d) => {
    d.schemaVersion = 0
  })
})

test('session-tree migration: branchOf becomes parentId; a branch of a deleted topic becomes a topic; once (topics-a-tree-of-agent.2)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], createdAt: 1 }
  writeFileSync(file, JSON.stringify({
    projects: [], tasks: [], docs: {}, canvases: {}, events: [], ideas: [], integrations: [], schemaVersion: 7,
    sessions: [
      { ...base, id: 'root' },
      { ...base, id: 'branch', branchOf: 'root', forkOf: 'root-native' },
      { ...base, id: 'orphan', branchOf: 'gone' },
      { ...base, id: 'plain', branchOf: null },
    ],
  }))
  const store = new Store(file)
  const shape = () => store.data.sessions.map((x) => [x.id, x.parentId ?? null, 'branchOf' in x])
  assert.deepEqual(shape(), [['root', null, false], ['branch', 'root', false], ['orphan', null, false], ['plain', null, false]])
  assert.equal(store.session('branch').forkOf, 'root-native')
  assert.equal(store.data.schemaVersion, 14)
  store.flush()
  assert.deepEqual(new Store(file).data.sessions.map((x) => [x.id, x.parentId ?? null]), [['root', null], ['branch', 'root'], ['orphan', null], ['plain', null]])
})

test('deleteSession removes the sessions under it too (topics-a-tree-of-agent.2)', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const p = store.createProject('p')
  const mk = (parentId: string | null) => store.createSession({ projectId: p.id, taskId: null, role: parentId ? null : 'chat', agent: 'claude-code', status: 'idle', parentId })
  const root = mk(null)
  const child = mk(root.id)
  const grandchild = mk(child.id)
  const other = mk(null)
  store.deleteSession(child.id)
  assert.deepEqual(store.data.sessions.map((x) => x.id), [root.id, other.id])
  assert.ok(!store.data.sessions.some((x) => x.id === grandchild.id))
})

test('saveCanvas: root stays on one diagram of a set; a revision keeps root and inventory unless given (povnyi-diff-nabir-pov-iazanykh.1)', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const placement = { role: 'fact' as const, option: null, stepId: 's1', repo: null, planOf: null }
  const component = { type: 'component' as const, summary: 's', modules: [{ id: 'api', name: 'api', description: '', uses: [] }] }
  const data = { type: 'data' as const, entities: [{ id: 'users', name: 'users', kind: 'table' as const, fields: [] }], relations: [] }
  const inventory = { summary: ['s'], units: [], noise: [] }
  const base = { projectId: 'p', taskId: 't', sessionId: null, kind: 'diagram' as const, placement }
  const root = store.saveCanvas({ ...base, title: 'fact', diagram: component, root: true, inventory })
  const other = store.saveCanvas({ ...base, title: 'data', diagram: data })
  assert.deepEqual([root.role, root.stepId, root.root, root.inventory, other.root], ['fact', 's1', true, inventory, undefined])
  // Another diagram of the set made root takes it over; a revision without root or inventory keeps them.
  store.saveCanvas({ id: other.id, projectId: 'p', taskId: 't', sessionId: null, title: 'data', kind: 'diagram', diagram: data, root: true })
  assert.deepEqual([store.data.canvases[root.id].root, store.data.canvases[other.id].root, store.data.canvases[root.id].version], [false, true, 1])
  store.saveCanvas({ id: root.id, projectId: 'p', taskId: 't', sessionId: null, title: 'fact', kind: 'diagram', diagram: component })
  assert.deepEqual(store.data.canvases[root.id].inventory, inventory)
})

test('review-v2-part-2-v1-2.1 migration: a review keeps its result per format, a decided report as v2 with its decision; once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const projects = [{ id: 'p', name: 'p', repos: [] }]
  const base = { projectId: 'p', parentId: null, type: 'review', status: 'in_progress', description: '', needsInput: null, nextSubNo: 1, rank: 0, work: null, createdAt: 0, updatedAt: 0 }
  const pr = { url: 'https://github.com/acme/api/pull/1', repo: '/r', number: 1, author: 'a', base: 'main', head: 'h' }
  const report = { checks: 'request_changes', decided: { id: 'd1', choice: 'discuss' }, draft: 'Why?' }
  const tasks = [
    { ...base, id: 'v2', key: 'R-1', title: 'r', ownerSessionId: 's2', prReview: { pr, problem: 'p', approach: 'a', verdict: 'request_changes', findings: [], report, head: 'h', posted: null, at: 5 } },
    { ...base, id: 'v1', key: 'R-2', title: 'r', ownerSessionId: 's1', prReview: { pr, problem: 'p', approach: 'a', verdict: 'approve', findings: [{ text: 'x', level: 'nit' }], head: 'h', posted: { at: 6, url: 'u' }, at: 5 } },
    { ...base, id: 'new', key: 'R-3', title: 'r', ownerSessionId: 's3', prReview: { pr, problem: '', approach: '', verdict: null, findings: [], head: null, posted: null, at: null } },
  ]
  writeFileSync(file, JSON.stringify({ projects, tasks, sessions: [], schemaVersion: 5 }))
  const store = new Store(file)
  assert.deepEqual(store.task('v2').prReview, { pr, shown: 'v2', posted: null, results: { v2: { format: 'v2', sessionId: 's2', problem: 'p', approach: 'a', verdict: 'request_changes', findings: [], report, head: 'h', at: 5 } } })
  assert.deepEqual(store.task('v1').prReview, { pr, shown: 'v1', posted: { at: 6, url: 'u' }, results: { v1: { format: 'v1', sessionId: 's1', problem: 'p', approach: 'a', verdict: 'approve', findings: [{ text: 'x', level: 'nit' }], head: 'h', at: 5 } } })
  assert.deepEqual(store.task('new').prReview, { pr, shown: 'v2', posted: null, results: {} })
  assert.equal(store.data.schemaVersion, 14)
  store.flush()
  assert.deepEqual(new Store(file).task('v2').prReview, store.task('v2').prReview)
})

test("topic-owners migration: a work without a chat topic is owned by its groomer's conversation, now a topic; nothing new is made", () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', agent: 'codex', nativeSessionId: 'n', status: 'idle', items: [{ kind: 'user', text: 'plan it', at: 2 }], createdAt: 1 }
  const work = { projectId: 'p', parentId: null, description: '', status: 'planning', needsInput: null, work: null, closedAt: null, nextSubNo: 1, createdAt: 5, updatedAt: 6 }
  writeFileSync(file, JSON.stringify({
    projects: [{ id: 'p', name: 'p', repos: [], agents: { chat: { agent: 'codex' } } }], docs: {}, canvases: {}, events: [], integrations: [], schemaVersion: 9,
    sessions: [
      { ...base, id: 'mine', taskId: null, role: 'chat', title: 'Mine' },
      { ...base, id: 'old-g', taskId: 'g', role: 'groomer', title: 'Groomer 1', createdAt: 0 },
      { ...base, id: 'groomer', taskId: 'g', stepId: null, role: 'groomer', title: 'Groomer' },
      { ...base, id: 'done-g', taskId: 'old', role: 'groomer', title: 'Groomer' },
      { ...base, id: 'dev', taskId: 'g', role: 'developer', title: 'Dev' },
    ],
    tasks: [
      { ...work, id: 'owned', key: 'A-1', title: 'Owned', ownerSessionId: 'mine' },
      { ...work, id: 'g', key: 'A-2', title: 'Groomed', ownerSessionId: 'groomer' },
      { ...work, id: 'old', key: 'A-3', title: 'Old', status: 'done' },
      { ...work, id: 'none', key: 'A-4', title: 'Nobody talked' },
      { ...work, id: 'r1', key: 'R-1', title: 'PR 1', type: 'review', status: 'in_progress' },
    ],
  }))
  const store = new Store(file)
  assert.equal(store.data.sessions.length, 5, 'no session is made')
  assert.deepEqual(['owned', 'g', 'old', 'none', 'r1'].map((id) => store.task(id).ownerSessionId ?? null), ['mine', 'groomer', 'done-g', null, null])
  const topic = (id: string) => { const s = store.session(id); return [s.role, s.taskId, s.title, s.closedAt ?? null, s.items.length, s.nativeSessionId] }
  assert.deepEqual(topic('groomer'), ['chat', null, 'Groomed', null, 1, 'n'])
  assert.deepEqual(topic('done-g'), ['chat', null, 'Old', 6, 1, 'n'])
  assert.deepEqual([store.session('old-g').role, store.session('dev').role], ['groomer', 'developer'], 'an earlier groomer and the developers stay agents of the work')
  assert.equal(store.data.schemaVersion, 14)
  store.flush()
})

test('reads-auto migration: an integration on auto goes to reads, the architect keeps auto; off and ask stay', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  writeFileSync(file, JSON.stringify({
    projects: [{ id: 'p', name: 'p', repos: [], integrations: { chat: { slack: 'auto', web: 'off' }, developer: { slack: 'ask', db: 'auto' }, architect: { slack: 'auto' } } }],
    tasks: [], sessions: [], docs: {}, canvases: {}, events: [], integrations: [], schemaVersion: 10,
  }))
  const store = new Store(file)
  assert.deepEqual(store.data.projects[0].integrations, { chat: { slack: 'reads', web: 'off' }, developer: { slack: 'ask', db: 'reads' }, architect: { slack: 'auto' } })
  assert.equal(store.data.schemaVersion, 14)
  store.flush()
})

test('effort migration: stored choices of projects and sessions get effort null, once (model-picker-full-model-list.1)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const base = { projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], createdAt: 1 }
  writeFileSync(file, JSON.stringify({
    projects: [{ id: 'p', name: 'p', repos: [], agents: { chat: { agent: 'claude-code', model: 'opus' }, developer: { agent: 'codex', model: null } } }],
    tasks: [], docs: {}, canvases: {}, events: [], integrations: [], schemaVersion: 11,
    sessions: [{ ...base, id: 'own', choice: { agent: 'claude-code', model: 'sonnet' } }, { ...base, id: 'none' }],
  }))
  const store = new Store(file)
  assert.deepEqual(store.data.projects[0].agents, { chat: { agent: 'claude-code', model: 'opus', effort: null }, developer: { agent: 'codex', model: null, effort: null } })
  assert.deepEqual(store.session('own').choice, { agent: 'claude-code', model: 'sonnet', effort: null })
  assert.equal(store.session('none').choice, undefined, 'no choice of its own: still its role default')
  assert.equal(store.data.schemaVersion, 14)
})

test('item events: a push appends, an in-place change re-sends its index, a replacement cuts and sends the rest (p0-fast-safe-store-no.1)', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const p = store.createProject('p')
  const s = store.createSession({ projectId: p.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const events: SessionItemEvent[] = []
  store.onItem((e) => events.push(structuredClone(e)))
  const shown = mirrorItems(store, s.id)
  const tool: ChatItem = { kind: 'tool', id: 't1', name: 'Bash', summary: 'ls', at: 2 }
  store.pushItem(s.id, { kind: 'user', text: 'hi', at: 1 })
  store.pushItem(s.id, tool)
  assert.deepEqual(events, [{ sid: s.id, n: 0, item: { kind: 'user', text: 'hi', at: 1 } }, { sid: s.id, n: 1, item: tool }])

  if (tool.kind === 'tool') tool.ok = true
  store.itemChanged(s.id, tool)
  assert.deepEqual(events.at(-1), { sid: s.id, n: 1, item: { ...tool, ok: true } })
  store.itemChanged(s.id, { kind: 'notice', text: 'gone', at: 0 })
  assert.equal(events.length, 3, 'an item no longer there sends nothing')

  const kept = store.items(s.id)
  store.setItems(s.id, [kept[0], { kind: 'notice', text: 'restored', at: 3 }])
  assert.deepEqual(events.slice(3), [{ sid: s.id, truncate: 1 }, { sid: s.id, n: 1, item: { kind: 'notice', text: 'restored', at: 3 } }])
  store.setItems(s.id, [])
  assert.deepEqual(events.at(-1), { sid: s.id, truncate: 0 })
  store.setItems(s.id, kept)
  assert.deepEqual(shown(), store.items(s.id))
  assert.deepEqual(store.items(s.id, 1), [tool])
})

test('the state windows get has sessions without items; it does not grow with a chat’s history (p0-fast-safe-store-no.1)', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const p = store.createProject('p')
  const s = store.createSession({ projectId: p.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const extra = { claudeBin: null, appVersion: '0', openProjects: [], inbox: [] }
  const size = () => JSON.stringify(appState(store, extra)).length
  const reply = (at: number): ChatItem => ({ kind: 'assistant', text: 'x'.repeat(1000), at })
  store.pushItem(s.id, reply(1000))
  const one = size()
  for (let at = 1001; at < 1100; at++) store.pushItem(s.id, reply(at))
  store.pushItem(s.id, { kind: 'approval', id: 'a1', tool: 'Bash', input: {}, status: 'pending', at: 1100 })
  store.pushItem(s.id, { kind: 'result', ok: true, costUsd: 0.5, at: 1101 })
  const state = appState(store, extra)
  const header = state.sessions[0]
  assert.equal('items' in header, false)
  assert.deepEqual([header.itemCount, header.costUsd, header.pendingApprovals.map((a) => a.id), header.lastReply?.at], [102, 0.5, ['a1'], 1099])
  store.data.sessions[0].items.splice(-2)
  assert.ok(size() - one < 10, `100 more replies of 1 KB add ${size() - one} bytes`)
})

test('flush writes through a temp file; a failed write leaves db.json whole and no temp file (p0-fast-safe-store-no.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-store-'))
  const file = join(dir, 'db.json')
  const store = new Store(file, 'json')
  store.createProject('p')
  store.flush()
  const saved = readFileSync(file, 'utf8')
  assert.equal(JSON.parse(saved).projects[0].name, 'p')
  assert.equal(existsSync(`${file}.tmp`), false)

  assert.throws(() => writeAtomic(file, '{"projects": [', () => { throw new Error('disk full') }), /disk full/)
  assert.equal(readFileSync(file, 'utf8'), saved)
  assert.equal(existsSync(`${file}.tmp`), false)
})

test('a day’s first write backs up db.json as it was, one per day, the newest 7 kept (p0-fast-safe-store-no.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-store-'))
  const file = join(dir, 'db.json')
  assert.equal(backupDaily(file, new Date(2026, 10, 1)), null, 'nothing to back up yet')
  for (let day = 1; day <= 9; day++) {
    writeFileSync(file, `{"day": ${day}}`)
    const at = new Date(2026, 10, day, 9)
    assert.equal(backupDaily(file, at), join(dir, 'backups', backupName(at)))
    writeFileSync(file, `{"day": ${day}, "later": true}`)
    assert.equal(backupDaily(file, new Date(2026, 10, day, 18)), null, 'one per day')
  }
  const kept = readdirSync(join(dir, 'backups')).sort()
  assert.deepEqual(kept, [3, 4, 5, 6, 7, 8, 9].map((d) => `db-2026-11-0${d}.json`))
  assert.equal(readFileSync(join(dir, 'backups', 'db-2026-11-09.json'), 'utf8'), '{"day": 9}', 'the file as it was before the day’s first write')

  const store = new Store(file, 'json')
  store.createProject('p')
  store.flush()
  assert.ok(existsSync(join(dir, 'backups', backupName(new Date()))), 'flush backs up')
})

// p0-fast-safe-store-no.2: the store on SQLite.

const workspaceFixture = () => readFileSync(new URL('./fixtures/db-workspace.json', import.meta.url), 'utf8')

/** A dir with the fixture as db.json, and a JSON copy of it to compare with. */
function withFixture(patch: (d: Record<string, any>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mag-sqlite-'))
  const d = JSON.parse(workspaceFixture())
  patch(d)
  const text = JSON.stringify(d)
  writeFileSync(join(dir, 'db.json'), text)
  const copy = join(mkdtempSync(join(tmpdir(), 'mag-sqlite-json-')), 'db.json')
  writeFileSync(copy, text)
  return { dir, file: join(dir, 'db.json'), text, onJson: () => new Store(copy, 'json') }
}

/** A second connection to the store's db, as a test sees it. */
const peek = (dir: string) => new DatabaseSync(join(dir, 'mag.sqlite'))

/** Logs every write to the entities and items tables into `writes`. */
function logWrites(dir: string) {
  const db = peek(dir)
  db.exec(`CREATE TABLE writes (what TEXT);
    CREATE TRIGGER e_ins AFTER INSERT ON entities BEGIN INSERT INTO writes VALUES (NEW.kind || ':' || NEW.id); END;
    CREATE TRIGGER e_upd AFTER UPDATE ON entities BEGIN INSERT INTO writes VALUES (NEW.kind || ':' || NEW.id); END;
    CREATE TRIGGER e_del AFTER DELETE ON entities BEGIN INSERT INTO writes VALUES ('-' || OLD.kind || ':' || OLD.id); END;
    CREATE TRIGGER i_ins AFTER INSERT ON items BEGIN INSERT INTO writes VALUES ('item:' || NEW.session_id || ':' || NEW.n); END;
    CREATE TRIGGER i_upd AFTER UPDATE ON items BEGIN INSERT INTO writes VALUES ('item:' || NEW.session_id || ':' || NEW.n); END;
    CREATE TRIGGER i_del AFTER DELETE ON items BEGIN INSERT INTO writes VALUES ('-item:' || OLD.session_id || ':' || OLD.n); END;`)
  return () => {
    const got = (db.prepare('SELECT what FROM writes').all() as { what: string }[]).map((r) => r.what)
    db.exec('DELETE FROM writes')
    return got
  }
}

test('first start imports db.json into mag.sqlite in one go; counts match, the data is as on JSON, db.json is kept', () => {
  const { dir, file, text, onJson } = withFixture()
  const store = new Store(file)
  assert.equal(existsSync(file), false)
  assert.equal(readFileSync(join(dir, 'db.pre-sqlite.json'), 'utf8'), text)
  const db = peek(dir)
  const kinds = Object.fromEntries((db.prepare('SELECT kind, count(*) AS c FROM entities GROUP BY kind').all() as { kind: string; c: number }[]).map((r) => [r.kind, r.c]))
  assert.deepEqual(kinds, { workspace: 1, project: 2, task: 3, session: 3, doc: 1, canvas: 2, event: 2, integration: 1, ui: 1, meta: 1 })
  const items = Object.fromEntries((db.prepare('SELECT session_id AS s, count(*) AS c FROM items GROUP BY session_id').all() as { s: string; c: number }[]).map((r) => [r.s, r.c]))
  assert.deepEqual(items, { topic: 3, dev: 2 })

  const json = onJson()
  assert.deepEqual(store.data, json.data, 'what the app reads is the same on both')
  assert.deepEqual(store.sessionHeaders(), json.sessionHeaders())
  assert.deepEqual(store.session('dev').items[1], { kind: 'approval', id: 'a1', tool: 'Bash', input: { command: 'ls' }, status: 'expired', at: 21 }, 'a restart expires pending approvals')

  // Started again: read from mag.sqlite, the same.
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data, json.data)
  assert.deepEqual(again.sessionHeaders(), json.sessionHeaders())
  assert.equal(again.data.schemaVersion, 14)
})

test('an import whose counts differ rolls back: no mag.sqlite, the store runs on db.json and logs why', () => {
  const { dir, file, text } = withFixture((d) => d.tasks.push({ ...d.tasks[0], title: 'the same id again' }))
  const store = new Store(file)
  assert.equal(existsSync(join(dir, 'mag.sqlite')), false)
  assert.equal(existsSync(join(dir, 'db.pre-sqlite.json')), false)
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.equal(store.data.tasks.length, 4)
  store.updateProject('p1', { name: 'renamed' })
  store.flush()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[0].name, 'renamed', 'saves go to db.json')
  assert.ok(logTail().some((l) => /db.json not imported into SQLite, running on JSON: import counts differ: kind task: 4 in the source, 3 stored/.test(l)), 'logged why')
})

test('items load per session when read; the state reads the digest stored with the session', () => {
  const { dir, file, onJson } = withFixture()
  new Store(file).flush()
  const store = new Store(file)
  // Written behind the store's back: seen only once the store loads the session's items.
  peek(dir).prepare('INSERT INTO items (session_id, n, json) VALUES (?, ?, ?)').run('topic', 3, JSON.stringify({ kind: 'notice', text: 'late', at: 13 }))
  const header = store.sessionHeaders().find((s) => s.id === 'topic')!
  assert.deepEqual([header.itemCount, header.costUsd, header.lastReply?.text], [3, 0.25, 'yes'])
  assert.deepEqual(header, onJson().sessionHeaders().find((s) => s.id === 'topic'))
  assert.deepEqual(store.items('topic').map((i) => i.kind), ['user', 'assistant', 'result', 'notice'])
  assert.equal(store.sessionHeaders().find((s) => s.id === 'topic')!.itemCount, 4)
})

test('flush writes only the rows that changed, in one transaction', () => {
  const { dir, file } = withFixture()
  const store = new Store(file)
  // Saves the restart's expiry of the pending approval.
  store.changed()
  store.flush()
  const writes = logWrites(dir)
  const again = new Store(file)

  again.updateTask('w2', { title: 'Other, renamed' })
  again.flush()
  assert.deepEqual(writes(), ['task:w2'], 'one changed task writes one row')

  again.pushItem('topic', { kind: 'user', text: 'and backups?', at: 30 })
  again.flush()
  assert.deepEqual(writes().sort(), ['item:topic:3', 'session:topic'], 'a new item is one row; its session gets the new digest')

  const [first, second] = again.items('topic')
  if (second.kind === 'assistant') second.text = 'yes, with VACUUM INTO'
  again.itemChanged('topic', second)
  again.flush()
  assert.deepEqual(writes().sort(), ['item:topic:1', 'session:topic'], 'an item changed in place; the digest has it as the last reply')

  again.setItems('topic', [first, { kind: 'notice', text: 'rewound', at: 31 }])
  again.flush()
  assert.deepEqual(writes().sort(), ['-item:topic:2', '-item:topic:3', 'item:topic:1', 'session:topic'], 'a rewind cuts and writes what follows the shared prefix')

  again.deleteSession('empty')
  again.flush()
  assert.deepEqual(writes(), ['-session:empty'])

  again.flush()
  assert.deepEqual(writes(), [], 'nothing pending, nothing written')
  const reread = new Store(file)
  assert.deepEqual(reread.items('topic'), again.items('topic'))
  assert.equal(reread.task('w2').title, 'Other, renamed')
  assert.equal(reread.data.sessions.some((s) => s.id === 'empty'), false)
})

test('a failure mid-flush writes nothing; the next flush writes it all', () => {
  const { dir, file } = withFixture()
  const store = new Store(file)
  store.flush()
  const db = peek(dir)
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON entities WHEN NEW.kind = 'task' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  store.updateProject('p1', { name: 'renamed' })
  const task = store.createTask({ projectId: 'p1', title: 'New', type: 'dev', description: '' })
  store.pushItem('topic', { kind: 'user', text: 'more', at: 40 })
  assert.throws(() => store.flush(), /disk full/)
  const name = () => (JSON.parse((db.prepare("SELECT json FROM entities WHERE kind = 'project' AND id = 'p1'").get() as { json: string }).json) as { name: string }).name
  assert.equal(name(), 'mag', 'the project written before the failing task is rolled back')
  assert.equal(new Store(file).items('topic').length, 3)

  db.exec('DROP TRIGGER boom')
  store.updateTask(task.id, { title: 'New, again' })
  store.flush()
  const after = new Store(file)
  assert.deepEqual([name(), after.task(task.id).title, after.items('topic').length], ['renamed', 'New, again', 4])
})

test('a restart on SQLite runs no migration again and keeps the step, its sessions and diagrams', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-sqlite-')), 'db.json')
  const store = new Store(file)
  const p = store.createProject('p')
  const task = store.createTask({ projectId: p.id, title: 'w', type: 'dev', description: '' })
  const s = store.createSession({ projectId: p.id, taskId: task.id, role: 'developer', agent: 'claude-code', status: 'running' })
  store.pushItem(s.id, { kind: 'approval', id: 'a1', tool: 'Bash', input: {}, status: 'pending', at: 1 })
  store.saveCanvas({ projectId: p.id, taskId: task.id, sessionId: null, title: 'plan', kind: 'html', html: '<p/>' })
  store.flush()
  const again = new Store(file)
  assert.equal(again.data.schemaVersion, 14)
  assert.deepEqual([again.session(s.id).status, again.sessionHeaders()[0].pendingApprovals], ['idle', []])
  again.flush()
  const third = new Store(file)
  assert.deepEqual([third.data.tasks, third.data.canvases], [store.data.tasks, store.data.canvases])
  assert.deepEqual(third.items(s.id), [{ kind: 'approval', id: 'a1', tool: 'Bash', input: {}, status: 'expired', at: 1 }], 'the expiry was saved')
})

test('a day’s first flush backs up mag.sqlite with VACUUM INTO; db.json gets no JSON backups', () => {
  const { dir, file } = withFixture()
  const store = new Store(file)
  store.updateProject('p1', { name: 'renamed' })
  store.flush()
  const backups = readdirSync(join(dir, 'backups'))
  assert.deepEqual(backups, [dbBackupName(new Date())])
  const copy = new DatabaseSync(join(dir, 'backups', backups[0]))
  assert.equal((copy.prepare("SELECT count(*) AS c FROM entities WHERE kind = 'task'").get() as { c: number }).c, 3)
})

// workspaces-and-labels-project-as.1: workspaces above projects.

/** A db.json at schemaVersion 12 with the user's four projects, as before workspaces. */
function beforeWorkspaces() {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-ws-')), 'db.json')
  const project = (id: string, name: string, repos: string[]) => ({ id, name, repos, notes: '', enforceArchitecture: true, architecture: null, archRun: null, agents: {}, integrations: {}, sidebar: [], createdAt: 1 })
  const projects = [
    project('dr', 'Aura Data Removal', ['/aura/duff-brewery', '/aura/lisa']),
    project('mp', 'Money Problems', ['/aura/ftm', '/aura/lisa']),
    project('mag', 'mag', ['/mag']),
    project('syn', 'synapse', []),
  ]
  writeFileSync(file, JSON.stringify({ projects, tasks: [], sessions: [], docs: {}, canvases: {}, events: [], integrations: [], schemaVersion: 12 }))
  return file
}

test('workspaces migration: Aura and Personal get their projects and the union of their repos; re-running it changes nothing', () => {
  const file = beforeWorkspaces()
  const store = new Store(file)
  assert.equal(store.data.schemaVersion, 14)
  const ws = store.workspaces()
  assert.deepEqual(ws.map((w) => [w.name, w.repos]), [['Aura', ['/aura/duff-brewery', '/aura/lisa', '/aura/ftm']], ['Personal', ['/mag']]])
  const nameOf = (pid: string) => ws.find((w) => w.id === store.project(pid).workspaceId)?.name
  assert.deepEqual(['dr', 'mp', 'mag', 'syn'].map(nameOf), ['Aura', 'Aura', 'Personal', 'Personal'])

  const before = JSON.stringify(store.data)
  let calls = 0
  store.onChange(() => calls++)
  store.migrateToWorkspaces(WORKSPACE_MAP)
  assert.equal(JSON.stringify(store.data), before)
  assert.equal(calls, 0)

  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.workspaces(), ws, 'a restart keeps the workspaces and runs no migration again')
  assert.deepEqual(again.data.projects.map((p) => p.workspaceId), store.data.projects.map((p) => p.workspaceId))
})

test('workspaces migration: a project the map does not name, or whose workspace is gone, goes to the fallback; with no project the fallback is made', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-ws-')), 'db.json'))
  assert.deepEqual(store.workspaces().map((w) => w.name), ['Personal'])
  const p = store.createProject('Side project')
  store.updateProject(p.id, { repos: ['/side'] })
  store.data.projects[0].workspaceId = 'gone'
  store.migrateToWorkspaces({ workspaces: { Work: ['Other'] }, fallback: 'Personal' })
  assert.deepEqual(store.workspaces().map((w) => [w.name, w.repos]), [['Personal', ['/side']]])
  assert.equal(store.project(p.id).workspaceId, store.workspaces()[0].id)
})

test('updateWorkspace: name, profile, notes and repos persist; a repo of its project stays; names are unique', () => {
  const file = beforeWorkspaces()
  const store = new Store(file)
  const [aura, personal] = store.workspaces()
  store.updateWorkspace(personal.id, { name: ' Home ', profile: 'I lead 3 teams', notes: 'knowledge', repos: ['/mag', '/notes'] })
  assert.throws(() => store.updateWorkspace(aura.id, { repos: ['/aura/ftm'] }), /\/aura\/duff-brewery \(Aura Data Removal\), \/aura\/lisa \(Aura Data Removal\), \/aura\/lisa \(Money Problems\)/)
  assert.throws(() => store.updateWorkspace(aura.id, { name: 'home' }), /exists/)
  assert.throws(() => store.updateWorkspace(aura.id, { name: '  ' }), /needs a name/)
  assert.throws(() => store.createWorkspace('Aura'), /exists/)
  assert.throws(() => store.updateWorkspace('nope', { notes: 'x' }), /No workspace/)
  store.flush()
  const w = new Store(file).workspace(personal.id)
  assert.deepEqual([w.name, w.profile, w.notes, w.repos], ['Home', 'I lead 3 teams', 'knowledge', ['/mag', '/notes']])
  assert.equal(w.createdAt, personal.createdAt)
})

test('updateWorkspace: starred topics and works persist in their order; a workspace from before has none', () => {
  const file = beforeWorkspaces()
  const store = new Store(file)
  const [aura, personal] = store.workspaces()
  assert.equal(aura.starred, undefined)
  store.updateWorkspace(aura.id, { starred: ['work:w1', 'topic:t1'] })
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.workspace(aura.id).starred, ['work:w1', 'topic:t1'])
  assert.equal(again.workspace(personal.id).starred, undefined)
})

test('a project moved to another workspace, or given a repo, adds its repos there; a new project goes to the last opened project’s workspace', () => {
  const store = new Store(beforeWorkspaces())
  const [aura, personal] = store.workspaces()
  store.updateProject('syn', { repos: ['/synapse'] })
  assert.deepEqual(store.workspace(personal.id).repos, ['/mag', '/synapse'])
  store.updateProject('mag', { workspaceId: aura.id })
  assert.deepEqual(store.workspace(aura.id).repos, ['/aura/duff-brewery', '/aura/lisa', '/aura/ftm', '/mag'])
  assert.deepEqual(store.workspace(personal.id).repos, ['/mag', '/synapse'], 'the old workspace keeps the repo')
  assert.throws(() => store.updateProject('mag', { workspaceId: 'nope' }), /No workspace/)

  store.touchRecent('syn')
  assert.equal(store.createProject('next').workspaceId, personal.id)
  assert.equal(store.createProject('there', aura.id).workspaceId, aura.id)
})

test('the state windows get has the workspaces', () => {
  const store = new Store(beforeWorkspaces())
  assert.deepEqual(appState(store, { claudeBin: null, appVersion: '0', openProjects: [], inbox: [] }).workspaces, store.workspaces())
})

test('inbox state and added items persist one row per key, on SQLite and on JSON (inbox-what-waits-on-me.1)', () => {
  for (const backend of ['auto', 'json'] as const) {
    const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
    const store = new Store(file, backend)
    const state = { id: 'task:t:question:x', key: 'task:t:question:x', workspaceId: null, snoozedUntil: 5, untilActivity: false, activityAt: 0, doneAt: null }
    store.putInboxState(state)
    store.putInboxState({ ...state, snoozedUntil: 9 })
    store.putInboxState({ ...state, id: 'other', key: 'other' })
    store.removeInboxStates(['other'])
    store.putInboxItem({ id: 'r:1', key: 'r:1', workspaceId: 'w', projectId: null, kind: 'draft', text: 'Draft', ref: null, labels: [], dueAt: null, at: 1, resolvedAt: null })
    store.flush()
    const again = new Store(file, backend)
    assert.deepEqual(again.data.inboxStates, [{ ...state, snoozedUntil: 9 }], backend)
    assert.deepEqual(again.data.inboxItems.map((i) => i.key), ['r:1'], backend)
    assert.equal('inboxStates' in appState(again, { claudeBin: null, appVersion: '0', openProjects: [], inbox: [] }), false, 'windows get the inbox, not its rows')
  }
})

// workspaces-and-labels-project-as.2: labels; topics without a project.

/** A store after the workspace migration, with a topic in Data Removal and one session under it. */
function withTopics() {
  const file = beforeWorkspaces()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const session = (id: string, over: object = {}) => ({ id, projectId: 'dr', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], createdAt: 1, ...over })
  raw.sessions = [session('topic'), session('kid', { parentId: 'topic', role: null })]
  writeFileSync(file, JSON.stringify(raw))
  const store = new Store(file)
  const [aura, personal] = store.workspaces()
  return { file, store, aura, personal }
}

test('labels migration: each workspace gets its Project group, each session its project’s workspace; once', () => {
  const { file, store, aura, personal } = withTopics()
  assert.deepEqual(store.data.labelGroups.map((g) => [g.workspaceId, g.name, g.system, g.exclusive]), [[aura.id, 'Project', 'project', true], [personal.id, 'Project', 'project', true]])
  assert.deepEqual(store.data.sessions.map((s) => s.workspaceId), [aura.id, aura.id])
  assert.deepEqual(store.labels.labels(store.labels.groups(aura.id)[0].id).map((l) => l.name), ['Aura Data Removal', 'Money Problems'])
  const w = store.createWorkspace('Lab')
  assert.equal(store.labels.groups(w.id)[0].system, 'project', 'a new workspace gets its Project group')
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data.labelGroups, store.data.labelGroups)
})

test('a topic moves into another project, with its tree and canvases, or out to no project; not one that owns a work, nor across workspaces', () => {
  const { store, aura } = withTopics()
  const canvas = store.saveCanvas({ projectId: 'dr', taskId: null, sessionId: 'kid', title: 'sketch', kind: 'html', html: '<p/>' })
  store.labels.setLabel('topic:topic', 'mp', 'user')
  assert.deepEqual(store.data.sessions.map((s) => s.projectId), ['mp', 'mp'])
  assert.equal(store.data.canvases[canvas.id].projectId, 'mp')
  store.labels.removeLabel('topic:topic', 'mp')
  assert.deepEqual(store.data.sessions.map((s) => [s.projectId, s.workspaceId]), [[null, aura.id], [null, aura.id]])
  assert.equal(store.data.canvases[canvas.id].projectId, '')
  assert.throws(() => store.labels.setLabel('topic:topic', 'mag', 'user'), /another workspace/)
  assert.throws(() => store.moveTopic('kid', 'dr'), /Only a topic/)
  store.labels.setLabel('topic:topic', 'dr', 'user')
  store.createTask({ projectId: 'dr', title: 'w', type: 'dev', description: '', ownerSessionId: 'kid' })
  assert.throws(() => store.labels.setLabel('topic:topic', 'mp', 'user'), /owns w: it stays/)
  const work = store.data.tasks[0]
  assert.throws(() => store.labels.setLabel(`work:${work.id}`, 'mp', 'user'), /A work stays in its project/)
})

test('a topic without a project runs on its workspace: its repos and notes; one in a project on the project’s, the workspace’s where it has none', () => {
  const { store, aura } = withTopics()
  store.updateWorkspace(aura.id, { notes: 'aura notes', playbook: { review: 'aura review' } })
  store.updateProject('dr', { notes: 'dr notes' })
  const none = store.createSession({ projectId: null, workspaceId: aura.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  const scope = store.sessionScope(none)
  assert.deepEqual([scope.id, scope.repos, scope.notes, scope.playbook?.review], ['', aura.repos, 'aura notes', 'aura review'])
  const inDr = store.sessionScope(store.session('topic'))
  assert.deepEqual([inDr.id, inDr.repos, inDr.notes, inDr.playbook?.review], ['dr', ['/aura/duff-brewery', '/aura/lisa'], 'dr notes', 'aura review'])
  assert.throws(() => store.createSession({ projectId: null, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' }), /needs a workspace/)
})

test('item labels persist on SQLite; a deleted topic or work drops its labels; a work gets rule labels from its tickets', () => {
  const { file, store, aura } = withTopics()
  const area = store.labels.upsertGroup({ workspaceId: aura.id, name: 'Area', exclusive: false })
  const privacy = store.labels.upsertLabel({ groupId: area.id, name: 'Privacy', rules: [{ kind: 'jiraKey', value: 'PRVP' }] })
  store.labels.setLabel('topic:topic', privacy.id, 'user')
  const work = store.createTask({ projectId: 'dr', title: 'w', type: 'dev', description: '', tickets: [{ url: 'https://x.atlassian.net/browse/PRVP-7', key: 'PRVP-7' }] })
  assert.deepEqual(store.labels.labelsOf(`work:${work.id}`).map((l) => l.name), ['Aura Data Removal', 'Privacy'])
  assert.equal(store.data.itemLabels.find((r) => r.itemRef === `work:${work.id}`)?.by, 'rule')
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.labels.labelsOf('topic:topic').map((l) => l.name), ['Aura Data Removal', 'Privacy'])
  again.deleteSession('topic')
  again.deleteTask(work.id)
  assert.deepEqual(again.data.itemLabels, [])
})

test('a project moved to another workspace takes its sessions and its rules; its items lose the old workspace’s labels', () => {
  const { store, aura, personal } = withTopics()
  const sys = store.labels.groups(aura.id)[0]
  store.labels.upsertLabel({ id: 'dr', groupId: sys.id, name: 'Aura Data Removal', rules: [{ kind: 'repo', value: 'duff-brewery' }] })
  const area = store.labels.upsertGroup({ workspaceId: aura.id, name: 'Area', exclusive: false })
  store.labels.setLabel('topic:topic', store.labels.upsertLabel({ groupId: area.id, name: 'UI' }).id, 'user')
  store.updateProject('dr', { workspaceId: personal.id })
  assert.deepEqual(store.data.sessions.map((s) => s.workspaceId), [personal.id, personal.id])
  assert.deepEqual(store.labels.labelsOf('topic:topic').map((l) => [l.name, l.rules]), [['Aura Data Removal', [{ kind: 'repo', value: 'duff-brewery' }]]])
})

test('a rule label the user took off a work stays off through PR polls and new tickets; rules run only when a signal changes', () => {
  const { store, aura } = withTopics()
  const area = store.labels.upsertGroup({ workspaceId: aura.id, name: 'Area', exclusive: false })
  const privacy = store.labels.upsertLabel({ groupId: area.id, name: 'Privacy', rules: [{ kind: 'jiraKey', value: 'PRVP' }] })
  const work = store.createTask({ projectId: 'dr', title: 'w', type: 'dev', description: '', tickets: [{ url: 'https://x.atlassian.net/browse/PRVP-7', key: 'PRVP-7' }] })
  const ref = `work:${work.id}` as const
  assert.deepEqual(store.labels.labelsOf(ref).map((l) => l.name), ['Aura Data Removal', 'Privacy'])
  store.labels.removeLabel(ref, privacy.id)
  const repos = [{ repo: '/aura/lisa', branch: 'b', worktree: '/w/lisa', prUrl: null, prState: null }]
  store.updateTask(work.id, { work: { dir: '/w', feedbackSeenAt: 0, repos } })
  store.updateTask(work.id, { work: { dir: '/w', feedbackSeenAt: 1, repos: [{ ...repos[0], prState: 'open' as const }] } })
  store.updateTask(work.id, { tickets: [...store.task(work.id).tickets!, { url: 'https://x.atlassian.net/browse/PRVP-8', key: 'PRVP-8' }] })
  assert.deepEqual(store.labels.labelsOf(ref).map((l) => l.name), ['Aura Data Removal'])

  let runs = 0
  const autoLabel = store.labels.autoLabel
  store.labels.autoLabel = (...a) => (runs++, autoLabel(...a))
  store.updateTask(work.id, { work: { dir: '/w', feedbackSeenAt: 2, repos: [{ ...repos[0], prState: 'open' as const, prUrl: 'https://github.com/o/r/pull/1' }] } })
  assert.equal(runs, 0, 'a PR poll is no new signal')
  store.updateTask(work.id, { work: { dir: '/w', feedbackSeenAt: 2, repos: [...repos, { ...repos[0], repo: '/aura/ftm' }] } })
  assert.equal(runs, 1, 'a new repository is')
})

test('deliverable records persist as rows of their own and reach the renderer state; a removed one goes (deliverables-library-claims-review-and.1)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(file)
  const records = store.deliverableRecords()
  const d = { id: 'd1', slug: 'weekly', workspaceId: 'w', folder: 'personal', projectId: 'p', topicId: 't', taskId: null, kind: 'report', title: 'Weekly', labels: [], sensitivity: 'work', state: 'draft', finalVersion: null, destination: null, publishedAt: null, versions: [{ n: 1, at: 1, by: 'agent' }], publishing: null, createdAt: 1, updatedAt: 1 } as const
  records.put({ ...d, labels: [], versions: [...d.versions] })
  records.put({ ...d, id: 'd2', slug: 'other', labels: [], versions: [] })
  records.put({ ...d, title: 'Weekly, renamed', labels: [], versions: [...d.versions] })
  store.flush()
  const db = new DatabaseSync(join(file, '..', 'mag.sqlite'))
  assert.deepEqual(db.prepare("SELECT id, project_id AS p FROM entities WHERE kind = 'deliverable' ORDER BY seq").all().map((r) => ({ ...r })), [{ id: 'd1', p: 'p' }, { id: 'd2', p: 'p' }])
  db.close()
  const again = new Store(file)
  assert.deepEqual(again.data.deliverables.map((x) => x.title), ['Weekly, renamed', 'Weekly'])
  assert.deepEqual(appState(again, { claudeBin: null, appVersion: '0', openProjects: [], inbox: [] }).deliverables.map((x) => x.id), ['d1', 'd2'])
  again.deliverableRecords().remove('d2')
  again.flush()
  assert.deepEqual(new Store(file).data.deliverables.map((x) => x.id), ['d1'])
})

test('people rows persist on SQLite and stay out of the renderer state (who-is-who-people-from.1)', async () => {
  const { appState } = await import('./state.ts')
  const { createPeople } = await import('./core/services/people/index.ts')
  const { file, store, aura } = withTopics()
  store.updateWorkspace(aura.id, { directories: { slack: true } })
  const none = async () => []
  const people = createPeople(store.data, { workspace: (id) => store.data.workspaces.find((w) => w.id === id), repos: () => [], jiraKeys: () => [] }, { slackUsers: async () => [{ system: 'slack', handle: 'U1', name: 'Ihor Koval' }], atlassianUsers: none, githubMembers: none, commitEmails: async () => new Map(), githubOwners: none }, () => store.changed())
  await people.sync(aura.id)
  people.override({ workspaceId: aura.id, system: 'github', handle: 'ikoval', personId: 'ihor-koval' })
  people.notPerson(aura.id, 'ihor-koval')
  people.override({ workspaceId: aura.id, system: 'github', handle: 'bot', personId: null })
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data.identityOverrides.map((o) => [o.handle, o.personId]).sort(), [['U1', null], ['bot', null], ['ikoval', null]])
  assert.deepEqual(again.data.identities.map((i) => i.handle), ['U1'])
  assert.equal(again.workspace(aura.id).directories?.slack, true)
  const state = appState(again, { claudeBin: null, appVersion: '', openProjects: [], inbox: [] }) as unknown as Record<string, unknown>
  assert.equal('persons' in state || 'identities' in state || 'identityOverrides' in state, false)
})
