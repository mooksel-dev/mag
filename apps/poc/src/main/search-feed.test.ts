import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MeetingContent, MeetingMeta } from './core/clients/meeting-files/index.ts'
import { createSearchIndex } from './core/clients/search-index/index.ts'
import { createSearch } from './core/services/search/index.ts'
import type { Deliverable } from './core/services/deliverables/index.ts'
import { createSearchFeed, type DeliverableSource, type MeetingSource } from './search-feed.ts'
import { Store } from './store.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-feed-'))
  const store = new Store(join(dir, 'db.json'))
  const project = store.createProject('Data Removal')
  const disk = new Map<string, { meta: MeetingMeta; summary: string; transcript: string; version: number }>()
  const meetings: MeetingSource = {
    list: () => [...disk.values()].map((d) => d.meta),
    read: (id): MeetingContent => ({ ...disk.get(id)!, dir: `/m/${id}` }),
    changedAt: (id) => disk.get(id)?.version ?? 0,
    recordingId: () => null,
  }
  const logs: string[] = []
  const indexPath = join(dir, '.index.sqlite')
  const search = createSearch({ index: createSearchIndex(() => indexPath) })
  const feed = createSearchFeed({ search, store, meetings: () => meetings, log: (m) => logs.push(m), delayMs: 5 })
  const find = (q: string) => search.query(q, { workspaceId: project.workspaceId }).map((h) => h.ref)
  return { dir, store, project, disk, search, feed, find, logs, indexPath }
}

const meeting = (id: string, text: string) => ({ meta: { id, title: 'Sync', startedAt: '2026-11-20T14:30:00Z' }, summary: '', transcript: `[00:00:01] others: ${text}\n`, version: 1 })

test('indexAll backfills topics, docs, decisions and meetings and logs the counts; a second run writes nothing', async () => {
  const f = setup()
  const topic = f.store.createSession({ projectId: f.project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Queue' })
  f.store.pushItem(topic.id, { kind: 'user', text: 'the DBR queue stalls', at: Date.now() })
  const work = f.store.createTask({ projectId: f.project.id, title: 'Queue work', type: 'dev', description: '', status: 'planning' })
  f.store.data.docs[work.id] = '# Problem\nDBR backlog\n\n# Decisions\n- DBR drains hourly\n'
  f.disk.set('m1', meeting('m1', 'the DBR call'))
  await f.feed.indexAll()
  assert.deepEqual(f.find('dbr').sort(), [`${f.project.workspaceId}:dec:${work.id}#0`, `${f.project.workspaceId}:doc:${work.id}#problem`, `${f.project.workspaceId}:topic:${topic.id}#0`, 'mtg:m1@00:00:01'].sort())
  assert.match(f.logs.at(-1)!, /^search index: store: 3 sources, 3 updated, 0 removed; meetings: 1 sources, 1 updated, 0 removed; deliverables: 0 sources, 0 updated, 0 removed in \d+ ms$/)
  await f.feed.indexAll()
  assert.match(f.logs.at(-1)!, /store: 3 sources, 0 updated, 0 removed; meetings: 1 sources, 0 updated/)
})

test('changes follow within the delay: a new message, a doc update, a label, a new meeting; a deleted topic or meeting disappears', async () => {
  const f = setup()
  await f.feed.indexAll()
  const topic = f.store.createSession({ projectId: f.project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Queue' })
  f.store.onItem(() => f.feed.onChanged('store'))
  f.store.onChange(() => f.feed.onChanged('store'))
  f.store.pushItem(topic.id, { kind: 'user', text: 'retention policy', at: Date.now() })
  const settle = () => new Promise((r) => setTimeout(r, 40))
  await settle()
  assert.deepEqual(f.find('retention'), [`${f.project.workspaceId}:topic:${topic.id}#0`])

  const work = f.store.createTask({ projectId: f.project.id, title: 'W', type: 'dev', description: '', status: 'planning' })
  f.store.data.docs[work.id] = '# Plan\nshred the archive'
  f.store.changed()
  await settle()
  assert.deepEqual(f.find('shred'), [`${f.project.workspaceId}:doc:${work.id}#plan`])

  f.disk.set('m2', meeting('m2', 'budget review'))
  f.feed.onChanged('meetings')
  await settle()
  assert.deepEqual(f.find('budget'), ['mtg:m2@00:00:01'])

  f.store.deleteSession(topic.id)
  await settle()
  assert.deepEqual(f.find('retention'), [])
  f.disk.delete('m2')
  f.feed.onChanged('meetings')
  await settle()
  assert.deepEqual(f.find('budget'), [])
})

test('a deleted index file is built again on the next start', async () => {
  const f = setup()
  const topic = f.store.createSession({ projectId: f.project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Queue' })
  f.store.pushItem(topic.id, { kind: 'user', text: 'retention policy', at: Date.now() })
  await f.feed.indexAll()
  const { rmSync } = await import('node:fs')
  rmSync(f.indexPath)
  const search = createSearch({ index: createSearchIndex(() => f.indexPath) })
  await createSearchFeed({ search, store: f.store, meetings: () => undefined, log: () => {} }).indexAll()
  assert.equal(search.query('retention', { workspaceId: f.project.workspaceId }).length, 1)
})

test('persons are indexed with sensitivity people: found only with people on, and follow a sync', async () => {
  const f = setup()
  const ws = f.project.workspaceId
  f.store.data.persons.push({ id: 'olena-k', workspaceId: ws, name: 'Olena Kovalenko', email: 'olena@aura.com', title: 'Backend lead', avatar: null, external: false, syncedAt: 1 })
  f.store.data.identities.push({ id: `${ws}|slack|U1`, workspaceId: ws, system: 'slack', handle: 'U1', personId: 'olena-k', source: 'directory', name: 'olena.k', syncedAt: 1 })
  await f.feed.indexAll()
  assert.deepEqual(f.find('kovalenko'), [], 'not without people')
  const people = (q: string) => f.search.query(q, { workspaceId: ws, people: true }).map((h) => [h.ref, h.kind])
  assert.deepEqual(people('kovalenko'), [[`${ws}:person:olena-k`, 'person']])
  assert.deepEqual(people('olena.k'), [[`${ws}:person:olena-k`, 'person']], 'by a handle')
  f.store.data.persons[0].title = 'Head of payments'
  await f.feed.sync('store')
  assert.deepEqual(people('payments'), [[`${ws}:person:olena-k`, 'person']])
  f.store.data.persons.length = 0
  await f.feed.sync('store')
  assert.deepEqual(people('kovalenko'), [])
})

test('deliverables are indexed at their current version with their labels, under their own ref; an assessment only with people on', async () => {
  const f = setup()
  const ws = f.project.workspaceId
  const area = f.store.labels.upsertGroup({ workspaceId: ws, name: 'Area', exclusive: false })
  const privacy = f.store.labels.upsertLabel({ groupId: area.id, name: 'Privacy' })
  const ux = f.store.labels.upsertLabel({ groupId: area.id, name: 'UX' })
  const topic = f.store.createSession({ projectId: f.project.id, taskId: null, role: 'chat', agent: 'claude-code', status: 'idle', title: 'Reports' })
  f.store.labels.setLabel(`topic:${topic.id}`, ux.id, 'user')
  const texts = new Map([['d1@1', '# Weekly\nThe DBR queue drained.'], ['d1@2', '# Weekly\nThe DBR queue drained twice.'], ['d2@1', 'Olena reviews DBR well.']])
  const base = { workspaceId: ws, folder: 'aura', projectId: f.project.id, topicId: topic.id, taskId: null, finalVersion: null, destination: null, publishedAt: null, publishing: null, createdAt: 0, updatedAt: 0 }
  const v = (n: number) => ({ n, at: n * 10, by: 'agent' as const })
  let list: Deliverable[] = [
    { ...base, id: 'd1', slug: 'weekly', kind: 'report', title: 'Weekly report', labels: ['privacy', 'Customer X'], sensitivity: 'work', state: 'draft', versions: [v(1), v(2)] },
    { ...base, id: 'd2', slug: 'olena', kind: 'assessment', title: 'Olena', labels: [], sensitivity: 'people', state: 'draft', versions: [v(1)] },
  ]
  const reads: string[] = []
  const dlv: DeliverableSource = {
    list: () => list,
    read: (id, n) => {
      reads.push(`${id}@${n}`)
      const t = texts.get(`${id}@${n}`)
      if (t === undefined) throw new Error('gone')
      return t
    },
    refOf: (d) => `${d.folder}:dlv:${d.slug}`,
  }
  const feed = createSearchFeed({ search: f.search, store: f.store, meetings: () => undefined, deliverables: () => dlv, log: () => {} })
  await feed.indexAll()
  const hits = (q: string, o: Partial<Parameters<typeof f.search.query>[1]> = {}) => f.search.query(q, { workspaceId: ws, ...o }).map((h) => h.ref)
  const [hit] = f.search.query('dbr', { workspaceId: ws })
  assert.deepEqual([hit.ref, hit.kind, [...hit.labels].sort()], ['aura:dlv:weekly@2', 'deliverable', [f.project.id, privacy.id, ux.id].sort()], 'the latest version; its project, topic and matching labels')
  assert.deepEqual(hits('dbr', { labels: [[privacy.id]] }), ['aura:dlv:weekly@2'])
  assert.deepEqual(hits('customer'), ['aura:dlv:weekly@2'], 'its own label names are searchable')
  assert.deepEqual(hits('dbr', { people: true }).sort(), ['aura:dlv:olena@1', 'aura:dlv:weekly@2'], 'an assessment only with people on')

  reads.length = 0
  await feed.sync('deliverables')
  assert.deepEqual(reads, [], 'unchanged deliverables are not read again')
  list = [{ ...list[0], state: 'final', finalVersion: 1 }]
  await feed.sync('deliverables')
  assert.deepEqual(hits('drained'), ['aura:dlv:weekly@1'], 'marked final: the final version')
  list = [{ ...list[0], state: 'draft', versions: [v(1), v(2), v(3)] }]
  await feed.sync('deliverables')
  assert.deepEqual(hits('weekly'), ['aura:dlv:weekly@3'], 'a version file deleted by hand leaves its title row')
  assert.deepEqual(hits('dbr', { people: true }), [], 'a deleted deliverable is dropped')
})
