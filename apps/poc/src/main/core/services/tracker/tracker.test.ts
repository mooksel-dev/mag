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
