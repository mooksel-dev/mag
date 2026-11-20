import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOTICE, clock, createMeetingFiles, folderName, slug } from './index.ts'

test('create: <root>/YYYY/MM/<date>-<time>-<slug>/ with meta.json and the transcript header; a taken name gets a suffix', () => {
  const root = mkdtempSync(join(tmpdir(), 'mag-meetings-'))
  const files = createMeetingFiles(() => root)
  const startedAt = new Date(2026, 10, 20, 14, 30).toISOString()
  const a = files.create({ title: 'DBO sync', startedAt })
  const b = files.create({ title: 'DBO sync', startedAt })
  assert.equal(a.id, '2026-11-20-1430-dbo-sync')
  assert.equal(a.dir, join(root, '2026', '11', a.id))
  assert.equal(b.id, '2026-11-20-1430-dbo-sync-2')
  assert.deepEqual(JSON.parse(readFileSync(join(a.dir, 'meta.json'), 'utf8')), { id: a.id, title: 'DBO sync', startedAt })
  assert.equal(readFileSync(join(a.dir, 'transcript.md'), 'utf8'), `# DBO sync\n\n${NOTICE}\n\n`)

  files.appendTranscript(a.id, [{ at: 3725.9, speaker: 'me', text: 'Привіт' }, { at: 3726, speaker: 'others', text: 'hi' }])
  files.appendTranscript(a.id, [])
  assert.match(readFileSync(join(a.dir, 'transcript.md'), 'utf8'), /\n\n\[01:02:05\] me: Привіт\n\[01:02:06\] others: hi\n$/)

  files.writeMeta(a.id, { id: a.id, title: 'DBO sync', startedAt, endedAt: startedAt })
  assert.equal(JSON.parse(readFileSync(join(a.dir, 'meta.json'), 'utf8')).endedAt, startedAt)
  assert.deepEqual(readdirSync(a.dir).sort(), ['meta.json', 'transcript.md'])
  assert.throws(() => files.writeMeta('other', { id: 'other', title: '', startedAt }), /Not a meeting id: other/)
  assert.throws(() => files.writeMeta('2026-11-20-1430-gone', { id: 'x', title: '', startedAt }), /No meeting 2026-11-20-1430-gone/)
})

test('list, read, writeSummary, remove; ids that are paths are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'mag-meetings-'))
  const files = createMeetingFiles(() => root)
  const older = files.create({ title: 'Old', startedAt: new Date(2026, 9, 1, 9, 0).toISOString() })
  const newer = files.create({ title: 'New', startedAt: new Date(2026, 10, 2, 9, 0).toISOString() })
  // Not meetings: a stray folder, a folder whose meta.json is broken, the index file.
  mkdirSync(join(root, '2026', '11', 'notes'))
  mkdirSync(join(root, '2026', '11', '2026-11-03-0900-broken'))
  writeFileSync(join(root, '2026', '11', '2026-11-03-0900-broken', 'meta.json'), '{')
  writeFileSync(join(root, '.index.sqlite'), '')
  assert.deepEqual(files.list().map((m) => m.id), [newer.id, older.id])

  assert.equal(files.read(newer.id).summary, '')
  files.writeSummary(newer.id, '## Decisions\n- ship')
  const r = files.read(newer.id)
  assert.equal(r.summary, '## Decisions\n- ship\n')
  assert.match(r.transcript, /^# New/)
  assert.equal(r.dir, newer.dir)
  assert.equal(r.meta.title, 'New')

  files.remove(older.id)
  assert.equal(existsSync(older.dir), false)
  assert.throws(() => files.read(older.id), /No meeting/)
  for (const bad of ['../x', '2026-11-02-0900-new/../../etc', '/etc/passwd']) assert.throws(() => files.read(bad), /Not a meeting id/)
})

test('the root is read on each call', () => {
  let root = mkdtempSync(join(tmpdir(), 'mag-meetings-'))
  const files = createMeetingFiles(() => root)
  files.create({ title: 'A', startedAt: new Date().toISOString() })
  root = mkdtempSync(join(tmpdir(), 'mag-meetings-'))
  assert.deepEqual(files.list(), [])
})

test('names: slug keeps Cyrillic, drops accents and punctuation; empty → call; clock pads hours', () => {
  assert.equal(slug('Планування: Q1 / Café!'), 'планування-q1-cafe')
  assert.equal(slug('  !!! '), 'call')
  assert.equal(folderName(new Date(2026, 0, 2, 3, 4), ''), '2026-01-02-0304-call')
  assert.equal(clock(59.99), '00:00:59')
  assert.equal(clock(-1), '00:00:00')
})
