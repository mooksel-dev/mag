import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimRefResolver } from './deliverable-tools.ts'

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
