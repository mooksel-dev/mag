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
  assert.equal(t('run').status, 'planned', 'started only through its subtasks: picked up again as a whole')
  assert.equal(store.session('s').taskId, 'run')
  assert.equal(store.session('s').nativeSessionId, null)
  assert.equal(store.data.canvases.c.taskId, 'run')

  // Idempotent: loading the migrated file again changes nothing.
  store.flush()
  const again = new Store(file)
  assert.deepEqual(again.data.tasks, store.data.tasks)
})
