import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSearchIndex } from '../../clients/search-index/index.ts'
import type { SearchRow } from '../../lib/search-rows/index.ts'
import { HALF_LIFE_DAYS, createSearch, score, type IndexDoc } from './index.ts'

const NOW = Date.parse('2026-11-21T00:00:00Z')
const DAY = 86_400_000

function fresh() {
  return createSearch({ index: createSearchIndex(((path) => () => path)(join(mkdtempSync(join(tmpdir(), 'mag-search-')), '.index.sqlite'))) })
}

let built = 0
const doc = (source: string, ws: string, rows: SearchRow[], extra: Partial<IndexDoc> = {}): IndexDoc => ({ source, version: '1', workspaceId: ws, labels: [], sensitivity: 'work', rows: () => (built++, rows), ...extra })
const r = (ref: string, text: string, at = NOW, kind: SearchRow['kind'] = 'topic'): SearchRow => ({ ref, kind, title: 'T', text, at })

test('query: the caller\'s workspace by default, another or all when asked; people and personal rows only with people: true', async () => {
  const s = fresh()
  s.upsert([
    doc('session:a', 'aura', [r('topic:a#0', 'queue in aura')]),
    doc('session:b', 'other', [r('topic:b#0', 'queue elsewhere')]),
    doc('session:p', 'personal', [r('topic:p#0', 'queue at home')], { sensitivity: 'personal' }),
    doc('person:x', 'aura', [r('person:x', 'queue owner Olena', NOW, 'person')], { sensitivity: 'people' }),
    doc('mtg:m', '', [r('mtg:m', 'queue on the call', NOW, 'meeting')]),
  ])
  const refs = (o: Parameters<typeof s.query>[1]) => s.query('queue', { now: NOW, ...o }).map((h) => h.ref).sort()
  assert.deepEqual(refs({ workspaceId: 'aura' }), ['aura:topic:a#0', 'mtg:m'])
  assert.deepEqual(refs({ workspaceId: 'aura', scope: 'other' }), ['mtg:m', 'other:topic:b#0'])
  assert.deepEqual(refs({ workspaceId: 'aura', scope: 'all' }), ['aura:topic:a#0', 'mtg:m', 'other:topic:b#0'])
  assert.deepEqual(refs({ workspaceId: 'aura', scope: 'all', people: true }), ['aura:person:x', 'aura:topic:a#0', 'mtg:m', 'other:topic:b#0', 'personal:topic:p#0'])
  assert.deepEqual(refs({ workspaceId: 'aura', people: true }), ['aura:person:x', 'aura:topic:a#0', 'mtg:m'])
  assert.deepEqual(refs({ workspaceId: 'personal' }), ['mtg:m', 'personal:topic:p#0'], 'Personal rows in their own scope')
  assert.deepEqual(refs({ workspaceId: 'aura', kinds: ['meeting'] }), ['mtg:m'])
  assert.deepEqual(s.query('  ', { workspaceId: 'aura' }), [])
})

test('query: one hit per source, its best row; labels, time, recency decay; upsert skips a version it has; rebuild drops what is gone within its prefixes', async () => {
  const s = fresh()
  const old = doc('doc:old', 'w', [r('doc:old#a', 'release release release', NOW - 365 * DAY, 'doc')], { labels: ['l1'] })
  const neu = doc('doc:new', 'w', [r('doc:new#a', 'release notes and more words here', NOW, 'doc'), r('doc:new#b', 'release release', NOW, 'doc')])
  built = 0
  assert.equal(s.upsert([old, neu]), 2)
  assert.equal(s.upsert([old, neu]), 0)
  assert.equal(built, 2, 'rows built only for changed versions')
  const hits = s.query('release', { workspaceId: 'w', now: NOW })
  assert.deepEqual(hits.map((h) => h.ref), ['w:doc:new#b', 'w:doc:old#a'], 'a year-old row decays below today\'s')
  assert.deepEqual(hits[1], { ref: 'w:doc:old#a', kind: 'doc', title: 'T', snippet: '\u0002release\u0003 \u0002release\u0003 \u0002release\u0003', at: NOW - 365 * DAY, labels: ['l1'] })
  assert.deepEqual(s.query('release', { workspaceId: 'w', labels: [['l1']], now: NOW }).map((h) => h.ref), ['w:doc:old#a'])
  assert.deepEqual(s.query('release', { workspaceId: 'w', from: NOW - DAY, now: NOW }).map((h) => h.ref), ['w:doc:new#b'])
  assert.deepEqual(s.query('release', { workspaceId: 'w', limit: 1, now: NOW }).length, 1)

  const meeting = doc('mtg:m', '', [r('mtg:m', 'release', NOW, 'meeting')])
  s.upsert([meeting])
  assert.deepEqual(await s.rebuild([{ ...neu, version: '2', rows: () => [r('doc:new#a', 'nothing', NOW, 'doc')] }], ['doc:']), { updated: 1, removed: 1 })
  assert.deepEqual(s.query('release', { workspaceId: 'w', now: NOW }).map((h) => h.ref), ['mtg:m'], 'other prefixes stay')
  s.remove('mtg:m')
  assert.deepEqual(s.query('release', { workspaceId: 'w', now: NOW }), [])
})

test('rebuild: a source that fails is skipped and tried again on the next one', async () => {
  const errors: string[] = []
  const s = createSearch({ index: createSearchIndex(((path) => () => path)(join(mkdtempSync(join(tmpdir(), 'mag-search-')), '.index.sqlite'))), onError: (m) => errors.push(m) })
  const bad = doc('session:x', 'w', [], { rows: () => { throw new Error('gone') } })
  assert.deepEqual(await s.rebuild([bad, doc('session:y', 'w', [r('topic:y#0', 'fine')])], ['session:']), { updated: 1, removed: 0 })
  assert.deepEqual(errors, ['Indexing session:x failed: gone'])
})

test('score: bm25 halves toward 0 every half-life', () => {
  assert.equal(score(-10, NOW, NOW), -10)
  assert.equal(score(-10, NOW - HALF_LIFE_DAYS * DAY, NOW), -5)
  assert.equal(score(-10, NOW + DAY, NOW), -10)
})
