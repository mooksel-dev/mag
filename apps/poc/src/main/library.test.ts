import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MeetingMeta } from './core/clients/meeting-files/index.ts'
import type { Deliverable, ListFilter } from './core/services/deliverables/index.ts'
import { createLibrary } from './library.ts'
import type { MeetingSource } from './search-feed.ts'
import { Store } from './store.ts'

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-lib-')), 'db.json'))
  const project = store.createProject('Data Removal')
  const ws = project.workspaceId
  const other = store.createProject('Elsewhere', store.createWorkspace('Other').id)
  store.data.labelGroups.push({ id: 'g1', workspaceId: ws, name: 'Team', exclusive: false, system: null, createdAt: 1 })
  store.data.labels.push({ id: 'aura', groupId: 'g1', name: 'Aura', color: '#f00', rules: [] }, { id: 'core', groupId: 'g1', name: 'Core', color: '#0f0', rules: [] })
  const topic = store.createSession({ projectId: project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Reports' })
  store.data.itemLabels.push({ id: `topic:${topic.id}|core`, itemRef: `topic:${topic.id}`, labelId: 'core', by: 'user' })
  const dlvs: Deliverable[] = []
  const filters: ListFilter[] = []
  const disk = new Map<string, { meta: MeetingMeta; summary: string; version: number }>()
  const reads: string[] = []
  const meetings: MeetingSource = {
    list: () => [...disk.values()].map((d) => d.meta),
    read: (id) => {
      reads.push(id)
      const d = disk.get(id)
      if (!d) throw new Error('gone')
      return { ...d, transcript: '', dir: `/m/${id}` }
    },
    changedAt: (id) => disk.get(id)?.version ?? 0,
    recordingId: () => null,
  }
  const library = createLibrary({
    store,
    deliverables: { list: (f = {}) => (filters.push(f), dlvs.filter((d) => d.workspaceId === f.workspaceId && (!f.state || f.state.includes(d.state)))) },
    meetings: () => meetings,
  })
  return { store, project, other, ws, topic, dlvs, filters, disk, reads, library }
}

const deliverable = (over: Partial<Deliverable>): Deliverable => ({
  id: 'd1', slug: 'weekly', workspaceId: '', folder: 'ws', projectId: null, topicId: null, taskId: null, kind: 'report', title: 'Weekly',
  labels: [], sensitivity: 'work', state: 'final', finalVersion: 2, destination: null, publishedAt: null,
  versions: [{ n: 1, at: 1, by: 'agent' }, { n: 2, at: 2, by: 'agent' }], publishing: null, createdAt: 1, updatedAt: 100, ...over,
})

test('lists final and published deliverables with their topic, labels (the topic\'s, own ones by name) and free tags', () => {
  const f = setup()
  f.dlvs.push(deliverable({ workspaceId: f.ws, projectId: f.project.id, topicId: f.topic.id, labels: ['aura', 'Q4'] }))
  f.dlvs.push(deliverable({ id: 'd2', workspaceId: f.ws, state: 'draft' }))
  f.dlvs.push(deliverable({ id: 'd3', workspaceId: f.other.workspaceId }))
  const { rows } = f.library.list(f.ws)
  assert.deepEqual(f.filters[0], { workspaceId: f.ws, state: ['final', 'published'] })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    key: 'dlv:d1', kind: 'report', source: 'deliverable', title: 'Weekly', text: 'v2 · final', at: 100,
    projectIds: [f.project.id], labelIds: ['aura', 'core', f.project.id].sort(), tags: ['Q4'], people: false,
    open: { kind: 'topic', id: f.topic.id, deliverableId: 'd1' },
  })
})

test('a deliverable opens its work when its topic is gone, else shows in Finder; a published one is dated by its publish', () => {
  const f = setup()
  const work = f.store.createTask({ projectId: f.project.id, title: 'Work', type: 'dev', description: '', status: 'in_progress' })
  const step = f.store.createTask({ projectId: f.project.id, parentId: work.id, title: 'Step', type: 'dev', description: '', status: 'in_progress' })
  f.dlvs.push(deliverable({ workspaceId: f.ws, topicId: 'gone', taskId: step.id, state: 'published', publishedAt: 500 }))
  f.dlvs.push(deliverable({ id: 'd2', workspaceId: f.ws, topicId: 'gone' }))
  const [a, b] = f.library.list(f.ws).rows
  assert.deepEqual([a.key, a.at, a.text, a.open], ['dlv:d1', 500, 'v2 · published', { kind: 'work', id: work.id }])
  assert.deepEqual(b.open, { kind: 'reveal', deliverableId: 'd2' })
  assert.deepEqual(b.labelIds, [])
})

test('decisions: a line per decision of works\' §Decisions (step subsections too), not of canceled works', () => {
  const f = setup()
  const work = f.store.createTask({ projectId: f.project.id, title: 'Queue', type: 'dev', description: '', status: 'in_progress' })
  f.store.data.itemLabels.push({ id: `work:${work.id}|aura`, itemRef: `work:${work.id}`, labelId: 'aura', by: 'user' })
  f.store.data.docs[work.id] = '# Problem\nx\n\n# Decisions\n- Drain hourly\n## Q.1\n- Use a cron\n\n# Plan\n- not a decision\n'
  const canceled = f.store.createTask({ projectId: f.project.id, title: 'Dropped', type: 'dev', description: '', status: 'canceled' })
  f.store.data.docs[canceled.id] = '# Decisions\n- Never\n'
  const elsewhere = f.store.createTask({ projectId: f.other.id, title: 'There', type: 'dev', description: '', status: 'planning' })
  f.store.data.docs[elsewhere.id] = '# Decisions\n- Theirs\n'
  const rows = f.library.list(f.ws).rows
  assert.deepEqual(rows.map((r) => [r.key, r.kind, r.source, r.text]), [[`dec:${work.id}#0`, 'decision', 'doc', 'Drain hourly'], [`dec:${work.id}#1`, 'decision', 'doc', 'Use a cron']])
  assert.deepEqual(rows[0].labelIds, ['aura', f.project.id].sort())
  assert.deepEqual(rows[0].open, { kind: 'work', id: work.id })
  assert.equal(rows[0].title, `${work.key}: Queue`)
})

test('merged works: done works with their merged PRs; reviews and unfinished works are not changes', () => {
  const f = setup()
  const work = f.store.createTask({ projectId: f.project.id, title: 'Shipped', type: 'dev', description: '', status: 'done' })
  const step = f.store.createTask({ projectId: f.project.id, parentId: work.id, title: 'S', type: 'dev', description: '', status: 'done' })
  step.work = { dir: '/w', branch: 'b', repos: [{ repo: '/r', prUrl: 'u', prState: 'merged' }, { repo: '/r2', prUrl: 'u2', prState: 'merged' }] } as never
  f.store.createTask({ projectId: f.project.id, title: 'Research', type: 'research', description: '', status: 'done' })
  f.store.createTask({ projectId: f.project.id, title: 'A review', type: 'review', description: '', status: 'done' })
  f.store.createTask({ projectId: f.project.id, title: 'Open', type: 'dev', description: '', status: 'in_progress' })
  const rows = f.library.list(f.ws, { kind: 'change' }).rows
  assert.deepEqual(rows.map((r) => [r.title.replace(/^.*: /, ''), r.text]).sort(), [['Research', 'done'], ['Shipped', '2 PRs merged']])
})

test('meeting decisions: from the summary, read once per change; meetings linked only to other workspaces are left out', () => {
  const f = setup()
  const summary = '## Decisions\n- Ship Friday\n- Freeze Thursday\n\n## Action items\n- **me**: write it\n'
  f.disk.set('m1', { meta: { id: 'm1', title: 'Sync', startedAt: '2026-11-20T14:30:00Z' }, summary, version: 1 })
  f.disk.set('m2', { meta: { id: 'm2', title: 'Linked', startedAt: '2026-11-19T10:00:00Z', links: [{ projectId: f.project.id, topicId: f.topic.id }] }, summary: '## Decisions\n- Mine\n', version: 1 })
  f.disk.set('m3', { meta: { id: 'm3', title: 'Theirs', startedAt: '2026-11-19T10:00:00Z', links: [{ projectId: f.other.id }] }, summary: '## Decisions\n- Not here\n', version: 1 })
  f.disk.set('m4', { meta: { id: 'm4', title: 'Nothing', startedAt: '2026-11-18T10:00:00Z' }, summary: '## Decisions\n- None.\n', version: 1 })
  const rows = f.library.list(f.ws).rows
  assert.deepEqual(rows.map((r) => [r.key, r.text]), [['mtg:m1#0', 'Ship Friday'], ['mtg:m1#1', 'Freeze Thursday'], ['mtg:m2#0', 'Mine']])
  assert.deepEqual(rows[0].open, { kind: 'meeting', id: 'm1' })
  assert.deepEqual(rows[0].projectIds, [])
  assert.deepEqual(rows[2].projectIds, [f.project.id])
  assert.deepEqual(rows[2].labelIds, ['core', f.project.id].sort())
  const n = f.reads.length
  f.library.list(f.ws)
  assert.equal(f.reads.length, n, 'unchanged meetings are not read again')
  f.disk.get('m1')!.summary = '## Decisions\n- Ship Monday\n'
  f.disk.get('m1')!.version = 2
  assert.equal(f.library.list(f.ws).rows[0].text, 'Ship Monday')
})

test('filters: kind (a decision deliverable is a decision too), Project (null: none), any label; people-sensitive only when asked', () => {
  const f = setup()
  const work = f.store.createTask({ projectId: f.project.id, title: 'Queue', type: 'dev', description: '', status: 'planning' })
  f.store.data.docs[work.id] = '# Decisions\n- Drain hourly\n'
  f.dlvs.push(deliverable({ id: 'dec', kind: 'decision', workspaceId: f.ws, updatedAt: 1 }))
  f.dlvs.push(deliverable({ id: 'rep', workspaceId: f.ws, projectId: f.project.id, topicId: f.topic.id }))
  f.dlvs.push(deliverable({ id: 'ass', kind: 'assessment', sensitivity: 'people', workspaceId: f.ws, labels: ['Aura'] }))
  const keys = (filter: object) => f.library.list(f.ws, filter).rows.map((r) => r.key)
  assert.deepEqual(keys({ kind: 'decision' }).sort(), [`dec:${work.id}#0`, 'dlv:dec'].sort())
  assert.deepEqual(keys({ projectId: null }), ['dlv:dec'])
  assert.deepEqual(keys({ projectId: f.project.id }).sort(), [`dec:${work.id}#0`, 'dlv:rep'].sort())
  assert.deepEqual(keys({ labelId: 'core' }), ['dlv:rep'])
  assert.deepEqual(f.library.list(f.ws, { labelId: 'aura' }), { rows: [], hiddenPeople: 1 })
  assert.deepEqual(keys({ labelId: 'aura', people: true }), ['dlv:ass'])
  assert.equal(f.library.list(f.ws, { kind: 'assessment' }).hiddenPeople, 1)
  assert.deepEqual(keys({ kind: 'assessment', people: true }), ['dlv:ass'])
  assert.equal(f.library.list(f.ws).hiddenPeople, 1)
})
