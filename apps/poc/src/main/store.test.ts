import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  writeFileSync(file, JSON.stringify({ projects: [], tasks, sessions: [] }))
  const store = new Store(file)
  const t = (id: string) => store.task(id)
  const ready = store.data.tasks.filter((x) => x.projectId === 'p' && !x.parentId && x.status === 'ready')
  assert.deepEqual(ready.map((x) => x.id).sort(), ['g1', 'g2', 'p1', 'p2'])
  assert.equal(t('rev').status, 'in_progress')
  assert.equal(t('rev').work?.repos[0].prState, 'open')
  assert.deepEqual([t('d').status, t('s').status, t('q').status], ['done', 'todo', 'ready'])
  assert.deepEqual(store.data.ideas.map((i) => i.text), ['b'], 'the backlog task is an idea now (T-55.7)')

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
  assert.deepEqual(store.data.ideas.map(({ projectId, text, createdAt }) => ({ projectId, text, createdAt })), [{ projectId: 'p', text: 'title T-4\n\nwhy\n\nhttps://x/browse/ABC-1', createdAt: 7 }])
  assert.ok(store.data.tasks.every((t) => !('archivedAt' in t)))
  assert.deepEqual(['nextTaskNo' in store.project('p'), 'autoArchiveDays' in store.project('p')], [false, false])

  store.flush()
  const again = new Store(file)
  assert.deepEqual([again.data.tasks, again.data.ideas], [store.data.tasks, store.data.ideas], 'idempotent')
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

test('ideas (T-55.6): none in an older file; add, edit and delete persist', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  writeFileSync(file, JSON.stringify({ projects: [], tasks: [], sessions: [], docs: {}, canvases: {} }))
  const store = new Store(file)
  assert.deepEqual(store.data.ideas, [])
  const p = store.createProject('p')
  const a = store.addIdea(p.id, ' cache rates ', 'T-1.2')
  const b = store.addIdea(p.id, 'dark mode')
  assert.deepEqual([a.text, a.source, 'source' in b], ['cache rates', 'T-1.2', false])
  assert.throws(() => store.addIdea('nope', 'x'), /No project nope/)
  store.updateIdea(b.id, { text: 'dark mode everywhere' })
  assert.throws(() => store.updateIdea(b.id, { text: '' }), /An idea needs a text/)
  store.deleteIdea(a.id)
  store.flush()
  assert.deepEqual(new Store(file).data.ideas.map((i) => i.text), ['dark mode everywhere'])
})

test('an idea links the topic that discusses it; deleting the topic drops the link', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json'))
  const p = store.createProject('p')
  const idea = store.addIdea(p.id, 'dark mode')
  const s = store.createSession({ projectId: p.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle' })
  store.updateIdea(idea.id, { topicId: s.id })
  assert.deepEqual([store.idea(idea.id).topicId, store.idea(idea.id).text], [s.id, 'dark mode'])
  store.deleteSession(s.id)
  assert.equal(store.idea(idea.id).topicId, null)
})

test('a restart keeps a step in progress: its work, PR, sessions and diagrams stay; migrations run once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mag-store-')), 'db.json')
  const store = new Store(file)
  const p = store.createProject('p')
  const task = store.createTask({ projectId: p.id, title: 'Fix restart', type: 'dev', description: '' })
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
  assert.equal(store.data.schemaVersion, 7, 'a new file has had every migration')

  const restart = (patch: (d: Record<string, unknown>) => void) => {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    patch(d)
    writeFileSync(file, JSON.stringify(d))
    for (let i = 0; i < 2; i++) {
      const again = new Store(file)
      assert.deepEqual({ tasks: again.data.tasks, sessions: again.data.sessions, canvases: again.data.canvases }, saved)
      assert.equal(again.data.schemaVersion, 7)
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
  assert.equal(store.data.schemaVersion, 7)
  store.flush()
  assert.deepEqual(new Store(file).task('v2').prReview, store.task('v2').prReview)
})
