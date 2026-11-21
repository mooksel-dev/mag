import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimRefResolver, deliverableTool } from './deliverable-tools.ts'

test('claimRefResolver: topics, files, meetings and transcript times resolve; missing ones say why', () => {
  const store = { data: { sessions: [{ id: 't1' }] } } as never
  const meetings = { read: (id: string) => { if (id !== 'm1') throw new Error('gone'); return { transcript: '[09:05:12] me: hi\n[10:02:40] others: ok' } } } as never
  const resolve = claimRefResolver(store, meetings)
  assert.equal(resolve('topic', 'topic:t1'), null)
  assert.equal(resolve('topic', 'topic:t2'), 'no such topic')
  assert.equal(resolve('file', import.meta.filename), null)
  assert.equal(resolve('file', '/no/such/file'), 'no such file')
  assert.equal(resolve('meeting', 'mtg:m1'), null)
  assert.equal(resolve('meeting', 'mtg:m2'), 'no such meeting')
  assert.equal(resolve('transcript', 'mtg:m1@9:05'), null)
  assert.equal(resolve('transcript', 'mtg:m1@10:02:40'), null)
  assert.equal(resolve('transcript', 'mtg:m1@11:00'), 'no transcript line at 11:00')
  assert.equal(claimRefResolver(store, undefined)('meeting', 'mtg:m1'), 'meetings are not ready yet')
})

test('read of a search hit\'s ref opens the version it names; without one, the current version', () => {
  const d = { id: 'd1', slug: 'weekly', folder: 'aura', kind: 'report', title: 'Weekly', state: 'draft', finalVersion: null, labels: [], versions: [{ n: 1, at: 1, by: 'agent' }, { n: 2, at: 2, by: 'agent' }] }
  const dlv = { resolve: () => d, refOf: () => 'aura:dlv:weekly', read: (_: string, n: number) => `text v${n}` } as never
  const origin = { workspaceId: 'w1', folder: 'aura', projectId: null, topicId: null, taskId: null }
  assert.match(deliverableTool(dlv, origin, 'read', { ref: 'aura:dlv:weekly@1' }), /^aura:dlv:weekly v1 · report · Weekly · draft\n\ntext v1$/)
  assert.match(deliverableTool(dlv, origin, 'read', { ref: 'aura:dlv:weekly' }), /v2 [\s\S]*text v2$/)
  assert.match(deliverableTool(dlv, origin, 'read', { ref: 'aura:dlv:weekly@1', version: 2 }), /text v2$/, 'version wins')
})
