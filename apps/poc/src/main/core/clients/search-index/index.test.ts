import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MARK_END, MARK_START, createSearchIndex, ftsQuery, type IndexRow } from './index.ts'

const row = (r: Partial<IndexRow> & Pick<IndexRow, 'ref' | 'text'>): IndexRow => ({ kind: 'meeting', workspaceId: '', labels: [], sensitivity: 'work', at: 1000, title: 'DBO sync', ...r })

test('ftsQuery: words as quoted prefixes; FTS syntax is plain text', () => {
  assert.equal(ftsQuery('Реліз  DBO'), '"реліз"* "dbo"*')
  assert.equal(ftsQuery('a OR "b" NEAR(c)*'), '"a"* "or"* "b"* "near"* "c"*')
  assert.equal(ftsQuery(' -- '), '')
})

test('match: prefixes, diacritics and case; title and text; filters by workspace, kind, labels, sensitivity, source and time; put replaces, drop removes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-index-'))
  let path = join(dir, '.index.sqlite')
  const index = createSearchIndex(() => path)
  index.put('mtg:a', '1', [row({ ref: 'mtg:a', text: 'Реліз переносимо на 4 грудня' }), row({ ref: 'mtg:a@00:00:09', text: 'We should move the release, café closed', at: 2000 })])
  index.put('session:t', '7', [row({ ref: 'w1:topic:t#0', kind: 'topic', workspaceId: 'w1', labels: ['p1', 'l2'], title: 'Release plan', text: 'when?', at: 3000 })])
  index.put('session:p', '1', [row({ ref: 'w2:topic:p#0', kind: 'topic', workspaceId: 'w2', sensitivity: 'personal', title: 'Mine', text: 'my release' })])
  assert.ok(existsSync(path))

  const refs = (q: string, w = {}) => index.match(ftsQuery(q), w).map((r) => r.ref).sort()
  assert.deepEqual(refs('releas'), ['mtg:a@00:00:09', 'w1:topic:t#0', 'w2:topic:p#0'])
  assert.match(index.match(ftsQuery('move'))[0].snippet, new RegExp(`${MARK_START}move${MARK_END} the release`))
  assert.deepEqual(refs('CAFE'), ['mtg:a@00:00:09'])
  assert.deepEqual(refs('реліз грудня'), ['mtg:a'])
  assert.deepEqual(refs('release', { workspaceIds: ['w1'] }), ['mtg:a@00:00:09', 'w1:topic:t#0'], 'workspace-wide rows are in every workspace')
  assert.deepEqual(refs('release', { workspaceIds: [] }), [])
  assert.deepEqual(refs('release', { kinds: ['topic'] }), ['w1:topic:t#0', 'w2:topic:p#0'])
  assert.deepEqual(refs('release', { labels: [['l2'], ['p1', 'x']] }), ['w1:topic:t#0'])
  assert.deepEqual(refs('release', { labels: [['l']] }), [], 'a label id matches whole')
  assert.deepEqual(refs('release', { exclude: ['personal'] }), ['mtg:a@00:00:09', 'w1:topic:t#0'])
  assert.deepEqual(refs('release', { sources: ['mtg:a'] }), ['mtg:a@00:00:09'])
  assert.deepEqual(refs('release', { from: 2500, to: 3000 }), ['w1:topic:t#0'])
  assert.deepEqual(index.match(ftsQuery('release'), { limit: 1 }).length, 1)
  assert.deepEqual(refs('"; DROP TABLE search_fts; --'), [])
  assert.deepEqual(index.match(ftsQuery('release'), { sources: ['session:t'] })[0].labels, ['p1', 'l2'])
  // The title weighs ×3: the topic titled "Release plan" ranks first.
  assert.equal(index.match(ftsQuery('release'))[0].ref, 'w1:topic:t#0')

  index.put('mtg:a', '2', [row({ ref: 'mtg:a', text: 'nothing about it' })])
  assert.deepEqual(refs('cafe'), [])
  assert.deepEqual([...index.versions()].sort(), [['mtg:a', '2'], ['session:p', '1'], ['session:t', '7']])
  index.drop('session:t')
  assert.deepEqual(refs('when'), [])
  assert.equal(index.versions().has('session:t'), false)

  // Another root has its own index.
  path = join(dir, 'other', '.index.sqlite')
  assert.deepEqual(refs('nothing'), [])
  index.close()
  rmSync(dir, { recursive: true, force: true })
})

test('an index of another schema (the meetings-only one) is dropped and built again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-index-'))
  const path = join(dir, '.index.sqlite')
  const old = new DatabaseSync(path)
  old.exec("CREATE VIRTUAL TABLE meetings_fts USING fts5(meetingId UNINDEXED, text); CREATE TABLE meetings_indexed (meetingId TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO meetings_indexed VALUES ('a', 1)")
  old.close()
  const index = createSearchIndex(() => path)
  assert.deepEqual([...index.versions()], [])
  index.close()
  const after = new DatabaseSync(path)
  assert.deepEqual(after.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'meetings%'").all(), [])
  after.close()
  rmSync(dir, { recursive: true, force: true })
})
