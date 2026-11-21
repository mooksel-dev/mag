import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MeetingContent, MeetingMeta } from './core/clients/meeting-files/index.ts'
import { createSearchIndex } from './core/clients/search-index/index.ts'
import { createSearch } from './core/services/search/index.ts'
import { createSearchFeed, type MeetingSource } from './search-feed.ts'
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
  assert.match(f.logs.at(-1)!, /^search index: store: 3 sources, 3 updated, 0 removed; meetings: 1 sources, 1 updated, 0 removed in \d+ ms$/)
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
