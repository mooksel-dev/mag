import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Change } from '@mag/diff/types'
import { mark, rows, statusCounts, what, where, type FactItem } from './factView.ts'

const change = (c: Partial<Change>): Change & { repo: string } => ({ key: 'k', kind: 'element', diff: 'add', module: 'store', hunks: [], repo: '/r', ...c })

test('mark, what, where: a change in a few words and its first hunk', () => {
  const fn = change({ name: 'save', decl: 'function', path: 'src/store.ts', line: 5, hunks: [{ path: 'src/store.ts', oldStart: 4, oldLines: 0, newStart: 5, newLines: 3 }] })
  assert.equal(mark(fn), 'add')
  assert.equal(what(fn), 'store function save')
  assert.equal(where(fn)!.label, 'src/store.ts:5')
  assert.equal(mark(change({ diff: 'mod', part: 'body' })), 'mod (body)')
  assert.equal(mark(change({ diff: 'move', from: 'app:src/old.ts#x' })), 'move from src/old.ts#x')
  assert.equal(what(change({ kind: 'edge', module: 'a', name: 'b' })), 'a → b')
  assert.equal(what(change({ kind: 'file', path: 'README.md', module: null })), 'file README.md')
  assert.equal(what(change({ name: 'h', exported: false, module: null })), '(no module) h (internal)')
  // A deleted range points at base.
  assert.equal(where(change({ hunks: [{ path: 'a.ts', oldStart: 9, oldLines: 2, newStart: 8, newLines: 0 }] }))!.label, 'a.ts:9')
  assert.equal(where(change({})), null)
})

test('rows: matches apart, low and noise folded unless all; counts in order', () => {
  const item = (status: FactItem['status'], level: FactItem['level']): FactItem => ({ status, level, fact: [] })
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
