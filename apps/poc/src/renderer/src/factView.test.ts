import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Change, FileChange } from '@mag/diff/types'
import { countLabel, filesOf, mark, rows, statusCounts, what, type FactItem } from './factView.ts'

const change = (c: Partial<Change>): Change => ({ key: 'store#save', kind: 'element', diff: 'add', module: 'store', name: 'save', ...c })
const file = (path: string, repo = 'app'): FileChange => ({ path, status: 'mod', hunks: [], repo, module: 'store', kind: 'code' })

test('mark, what: a change in a few words', () => {
  assert.equal(mark(change({})), 'add')
  assert.equal(what(change({ after: 'save(id): void' })), 'store save(id): void')
  assert.equal(mark(change({ diff: 'mod', part: 'signature' })), 'mod (signature)')
  assert.equal(mark(change({ diff: 'move', from: 'db' })), 'move from db')
  assert.equal(what(change({ kind: 'edge', key: 'a -> b', module: 'a', name: 'b' })), 'a → b')
  assert.equal(what(change({ kind: 'call', key: 'a -> b#run', module: 'a', name: 'run' })), 'a → b#run')
  assert.equal(what(change({ kind: 'module', key: 'store' })), 'module store')
})

test('filesOf and countLabel: the files a line rests on; the counts a step records, named', () => {
  const files = [file('src/store.ts'), file('src/db.ts', 'web')]
  assert.deepEqual(filesOf(change({ files: ['web:src/db.ts', 'src/store.ts', 'nope.ts'] }), files).map((f) => f.path), ['src/db.ts', 'src/store.ts'])
  assert.deepEqual(['match', 'unaccounted', 'ungrounded', 'unshown'].map(countLabel), ['as planned', 'in no unit', 'ungrounded', 'not shown'])
})

test('rows: matches apart, low and noise folded unless all; counts in order', () => {
  const item = (status: FactItem['status'], level: FactItem['level']): FactItem => ({ status, level })
  const items = [item('differs', 'high'), item('unplanned', 'low'), item('unplanned', 'noise'), item('missing', 'medium'), item('match', 'high')]
  const folded = rows(items, false)
  assert.deepEqual(folded.shown.map((i) => i.status), ['differs', 'missing'])
  assert.equal(folded.folded, 2)
  assert.equal(folded.matches.length, 1)
  const all = rows(items, true)
  assert.equal(all.shown.length, 4)
  assert.equal(all.folded, 0)
  assert.deepEqual(statusCounts(items), [{ status: 'differs', count: 1 }, { status: 'missing', count: 1 }, { status: 'unplanned', count: 2 }, { status: 'match', count: 1 }])
})
