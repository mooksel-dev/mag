import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../../store.ts'
import { createTrackerService } from './index.ts'

const setup = () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-tracker-')), 'db.json'))
  const project = store.createProject('p')
  const started: string[] = []
  const tracker = createTrackerService(store, { startImport: (id) => void started.push(store.task(id).key) })
  return { store, project, tracker, started }
}

test('import: a backlog task linked to the ticket, then the import run', async () => {
  const { store, project, tracker, started } = setup()
  store.updateProject(project.id, { trackers: [{ integrationId: 'atl', kind: 'jira', scope: 'ABC' }] })
  const task = await tracker.import(project.id, 'https://acme.atlassian.net/browse/ABC-12')
  assert.deepEqual([task.key, task.title, task.status, task.parentId], ['T-1', 'ABC-12', 'backlog', null])
  assert.deepEqual(task.tracker, { integrationId: 'atl', kind: 'jira', key: 'ABC-12', url: 'https://acme.atlassian.net/browse/ABC-12', importedAt: null })
  assert.deepEqual(started, ['T-1'])
  await assert.rejects(tracker.import(project.id, 'abc-12'), /ABC-12 is already imported as T-1/)
  assert.deepEqual(started, ['T-1'])
})

test('import: an unknown ref creates nothing', async () => {
  const { store, project, tracker, started } = setup()
  await assert.rejects(tracker.import(project.id, 'ABC-1'), /add a tracker in Settings → Trackers/)
  store.updateProject(project.id, { trackers: [{ integrationId: 'lin', kind: 'linear', scope: 'ENG' }] })
  await assert.rejects(tracker.import(project.id, 'ABC-1'), /^Error: Unknown tracker link or key$/)
  assert.equal(store.data.tasks.length, 0)
  assert.deepEqual(started, [])
})

test('retryImport: runs the import again on a linked task only', async () => {
  const { store, project, tracker, started } = setup()
  store.updateProject(project.id, { trackers: [{ integrationId: 'atl', kind: 'jira', scope: 'ABC' }] })
  const task = await tracker.import(project.id, 'ABC-3')
  tracker.retryImport(task.id)
  assert.deepEqual(started, ['T-1', 'T-1'])
  const plain = store.createTask({ projectId: project.id, title: 'x', type: 'dev', description: '' })
  assert.throws(() => tracker.retryImport(plain.id), /T-2 is not linked to a ticket/)
  assert.deepEqual(started, ['T-1', 'T-1'])
})

test('link: a plain link by URL, replaced on change, no import', () => {
  const { store, project, tracker, started } = setup()
  store.updateProject(project.id, { trackers: [{ integrationId: 'atl', kind: 'jira', scope: 'ABC' }] })
  const a = store.createTask({ projectId: project.id, title: 'a', type: 'dev', description: 'brief' })
  const b = store.createTask({ projectId: project.id, title: 'b', type: 'dev', description: '' })
  const linked = tracker.link(a.id, 'https://acme.atlassian.net/browse/XYZ-1')
  assert.deepEqual(linked.tracker, { integrationId: null, kind: 'jira', key: 'XYZ-1', url: 'https://acme.atlassian.net/browse/XYZ-1', importedAt: null })
  assert.equal(linked.description, 'brief')
  assert.throws(() => tracker.retryImport(a.id), /T-1 is linked without an integration/)
  assert.equal(tracker.link(a.id, 'https://acme.atlassian.net/browse/ABC-2').tracker?.integrationId, 'atl', 'Change link')
  assert.throws(() => tracker.link(b.id, 'https://acme.atlassian.net/browse/abc-2'), /ABC-2 is already linked to T-1/)
  assert.throws(() => tracker.link(b.id, 'ABC-3'), /^Error: Not a Jira or Linear ticket link$/)
  assert.equal(store.task(b.id).tracker, undefined)
  const step = store.createTask({ projectId: project.id, parentId: a.id, title: 's', type: 'dev', description: '' })
  assert.throws(() => tracker.link(step.id, 'https://acme.atlassian.net/browse/ABC-4'), /is a step/)
  assert.equal(tracker.unlink(a.id).tracker, null)
  assert.equal(tracker.link(b.id, 'https://acme.atlassian.net/browse/ABC-2').tracker?.key, 'ABC-2', 'free again after unlink')
  assert.deepEqual(started, [])
})
