import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupName, countsDiff, openWorkspaceDb, removeDb } from './index.ts'

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-wsdb-'))
  return { dir, path: join(dir, 'mag.sqlite') }
}
const row = (kind: string, id: string, json = '{}') => ({ kind, id, projectId: 'p', json })

test('put keeps an entity in the order it was first put; remove of a session takes its items', () => {
  const { path } = fresh()
  const db = openWorkspaceDb(path)
  assert.equal(db.ready(), false)
  db.init()
  assert.equal(db.ready(), true)
  db.transaction(() => {
    for (const id of ['b', 'a', 'c']) db.put(row('task', id))
    db.put(row('task', 'b', '{"v":2}'))
    db.put(row('session', 's'))
    db.putItem('s', 0, '"x"')
    db.putItem('s', 1, '"y"')
    db.putItem('s', 1, '"z"')
  })
  assert.deepEqual(db.load().map((r) => [r.id, r.json]), [['b', '{"v":2}'], ['a', '{}'], ['c', '{}'], ['s', '{}']])
  assert.deepEqual(db.items('s'), ['"x"', '"z"'])
  db.cutItems('s', 1)
  assert.deepEqual(db.items('s'), ['"x"'])
  db.remove('session', 's')
  assert.deepEqual(db.items('s'), [])
  db.close()
  // The order survives a reopen.
  const again = openWorkspaceDb(path)
  again.put(row('task', 'd'))
  assert.deepEqual(again.load().map((r) => r.id), ['b', 'a', 'c', 'd'])
  again.close()
})

test('a transaction that throws writes nothing', () => {
  const db = openWorkspaceDb(fresh().path)
  db.put(row('task', 'a', '{"v":1}'))
  assert.throws(() => db.transaction(() => {
    db.put(row('task', 'a', '{"v":2}'))
    db.put(row('task', 'b'))
    throw new Error('mid-way')
  }), /mid-way/)
  assert.deepEqual(db.load().map((r) => [r.id, r.json]), [['a', '{"v":1}']])
  db.close()
})

test('importAll stores everything and marks the db ready; counts that differ store nothing', () => {
  const { path } = fresh()
  const db = openWorkspaceDb(path)
  const data = { entities: [row('task', 'a'), row('task', 'a'), row('session', 's')], items: { s: ['"x"', '"y"'] } }
  assert.throws(() => db.importAll(data, { entities: { task: 2, session: 1 }, items: { s: 2 } }), /import counts differ: kind task: 2 in the source, 1 stored/)
  assert.deepEqual([db.ready(), db.load(), db.items('s')], [false, [], []])
  db.importAll({ ...data, entities: [row('task', 'a'), row('session', 's'), row('session', 'empty')] }, { entities: { task: 1, session: 2 }, items: { s: 2, empty: 0 } })
  assert.deepEqual([db.ready(), db.load().length, db.items('s')], [true, 3, ['"x"', '"y"']])
  db.close()
  removeDb(path)
  assert.equal(existsSync(path), false)
})

test('countsDiff: kinds and sessions whose counts differ; zero and missing are the same', () => {
  assert.deepEqual(countsDiff({ entities: { task: 2, doc: 0 }, items: { s: 3, e: 0 } }, { entities: { task: 2 }, items: { s: 2 } }), ['items of session s: 3 in the source, 2 stored'])
})

test('backup: the day’s first call copies the db with VACUUM INTO, one per day, the newest 7 kept', () => {
  const { dir, path } = fresh()
  const db = openWorkspaceDb(path)
  db.init()
  const backups = join(dir, 'backups')
  for (let day = 1; day <= 9; day++) {
    db.put(row('task', `t${day}`))
    const at = new Date(2026, 10, day, 9)
    assert.equal(db.backup(backups, at), join(backups, backupName(at)))
    assert.equal(db.backup(backups, new Date(2026, 10, day, 18)), null, 'one per day')
  }
  assert.deepEqual(readdirSync(backups).sort(), [3, 4, 5, 6, 7, 8, 9].map((d) => `mag-2026-11-0${d}.sqlite`))
  const copy = new DatabaseSync(join(backups, 'mag-2026-11-09.sqlite'))
  assert.equal((copy.prepare('SELECT count(*) AS c FROM entities').get() as { c: number }).c, 9)
  copy.close()
  db.close()
})
