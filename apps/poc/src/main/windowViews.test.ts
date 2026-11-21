import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromProjectWindows, resolveView, viewHash, viewShows } from './windowViews.ts'

const b = { x: 0, y: 0, width: 900, height: 700 }
const place = { workspaces: [{ id: 'aura' }, { id: 'personal' }], projects: [{ id: 'mag', workspaceId: 'personal' }, { id: 'adr', workspaceId: 'aura' }] }

test('old project windows become workspace windows filtered to their project; a deleted project is dropped', () => {
  assert.deepEqual(fromProjectWindows([{ projectId: 'mag', bounds: b }, { projectId: 'gone', bounds: b }, { projectId: 'adr', bounds: b }], place.projects), [
    { workspaceId: 'personal', projectId: 'mag', bounds: b },
    { workspaceId: 'aura', projectId: 'adr', bounds: b },
  ])
})

test('a saved window reopens as its view; a filtered one follows its project, or shows its workspace when the project is gone', () => {
  assert.deepEqual(resolveView({ workspaceId: 'aura', projectId: null }, place), { workspaceId: 'aura', projectId: null })
  assert.deepEqual(resolveView({ workspaceId: 'aura', projectId: 'mag' }, place), { workspaceId: 'personal', projectId: 'mag' }, 'moved project')
  assert.deepEqual(resolveView({ workspaceId: 'aura', projectId: 'gone' }, place), { workspaceId: 'aura', projectId: null })
  assert.equal(resolveView({ workspaceId: 'deleted', projectId: null }, place), null)
  assert.equal(resolveView({ workspaceId: 'deleted', projectId: 'gone' }, place), null)
})

test('the hash names the workspace, and the project only when filtered', () => {
  assert.equal(viewHash({ workspaceId: 'aura', projectId: null }), 'workspace=aura')
  assert.equal(viewHash({ workspaceId: 'a b', projectId: 'p&1' }), 'workspace=a+b&project=p%261')
})

test('a workspace window shows each of its projects; a filtered one only its project', () => {
  assert.equal(viewShows({ workspaceId: 'aura', projectId: null }, { id: 'adr', workspaceId: 'aura' }), true)
  assert.equal(viewShows({ workspaceId: 'aura', projectId: null }, { id: 'mag', workspaceId: 'personal' }), false)
  assert.equal(viewShows({ workspaceId: 'personal', projectId: 'mag' }, { id: 'mag', workspaceId: 'personal' }), true)
  assert.equal(viewShows({ workspaceId: 'personal', projectId: 'mag' }, { id: 'syn', workspaceId: 'personal' }), false)
})
