import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARK_END, MARK_START, createMeetingIndex, ftsQuery, rowsOf } from './index.ts'

const sync = {
  id: '2026-11-20-1430-dbo-sync',
  version: 1,
  title: 'DBO sync',
  summary: '## Decisions\n- Реліз переносимо на 4 грудня\n\n## Participants\n- Олена',
  transcript: '# DBO sync\n\n> notice\n\n[00:00:02] me: Привіт, Олено\n[00:00:09] others: We should move the release, café closed\n',
}
const retro = { id: '2026-11-21-1000-retro', version: 1, title: 'Retro', summary: '', transcript: '[00:10:00] others: the release went fine\n' }

test('ftsQuery: words as quoted prefixes; FTS syntax is plain text', () => {
  assert.equal(ftsQuery('Реліз  DBO'), '"реліз"* "dbo"*')
  assert.equal(ftsQuery('a OR "b" NEAR(c)*'), '"a"* "or"* "b"* "near"* "c"*')
  assert.equal(ftsQuery(' -- '), '')
})

test('rowsOf: title and summary lines without markup, transcript lines with their time; the header is left out', () => {
  assert.deepEqual(rowsOf(sync).map((r) => [r.part, r.at, r.text]), [
    ['summary', '', 'DBO sync'],
    ['summary', '', 'Decisions'],
    ['summary', '', 'Реліз переносимо на 4 грудня'],
    ['summary', '', 'Participants'],
    ['summary', '', 'Олена'],
    ['transcript', '00:00:02', 'me: Привіт, Олено'],
    ['transcript', '00:00:09', 'others: We should move the release, café closed'],
  ])
})

test('query: ranked hits with time and marked snippet; prefixes, diacritics and case; filters; upsert, remove, versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-index-'))
  let path = join(dir, '.index.sqlite')
  const index = createMeetingIndex(() => path)
  index.upsert(sync)
  index.upsert(retro)
  assert.ok(existsSync(path))

  const hits = index.query('releas')
  assert.deepEqual(hits.map((h) => [h.meetingId, h.at]).sort(), [[sync.id, '00:00:09'], [retro.id, '00:10:00']])
  assert.match(hits.find((h) => h.meetingId === sync.id)!.snippet, new RegExp(`move the ${MARK_START}release${MARK_END}`))
  assert.deepEqual(index.query('CAFE').map((h) => h.at), ['00:00:09'])
  assert.deepEqual(index.query('реліз грудня').map((h) => [h.part, h.at]), [['summary', null]])
  assert.deepEqual(index.query('олен').length, 2)
  assert.deepEqual(index.query('release', { meetingIds: [retro.id] }).map((h) => h.meetingId), [retro.id])
  assert.deepEqual(index.query('release', { meetingIds: [] }), [])
  assert.deepEqual(index.query('release', { limit: 1 }).length, 1)
  assert.deepEqual(index.query('"; DROP TABLE meetings_fts; --'), [])

  index.upsert({ ...retro, version: 2, transcript: '[00:00:01] me: nothing about it\n' })
  assert.deepEqual(index.query('release').map((h) => h.meetingId), [sync.id])
  assert.deepEqual([...index.versions()].sort(), [[sync.id, 1], [retro.id, 2]])
  index.remove(sync.id)
  assert.deepEqual(index.query('release'), [])
  assert.deepEqual([...index.versions()], [[retro.id, 2]])

  // Another root has its own index.
  path = join(dir, 'other', '.index.sqlite')
  assert.deepEqual(index.query('nothing'), [])
  index.close()
  rmSync(dir, { recursive: true, force: true })
})
