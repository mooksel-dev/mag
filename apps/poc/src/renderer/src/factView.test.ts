import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Change, FileChange } from '@mag/diff/types'
import { filesOf, mark, planFactLine, summary, what } from './factView.ts'

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

test('filesOf: the files a line rests on', () => {
  const files = [file('src/store.ts'), file('src/db.ts', 'web')]
  assert.deepEqual(filesOf(change({ files: ['web:src/db.ts', 'src/store.ts', 'nope.ts'] }), files).map((f) => f.path), ['src/db.ts', 'src/store.ts'])
})

test('summary: a recorded fact in one line; deviations, additions, outside the plan, the inventory; no threshold once merged', () => {
  const counts = { match: 30, differs: 0, missing: 0, unplanned: 0, additions: 67, outside: 13, unaccounted: 0, ungrounded: 0 }
  assert.equal(summary({ counts, blockers: [] }, false), 'As planned · +67 additions · 13 outside the plan')
  const bad = { counts: { ...counts, differs: 2, missing: 1, additions: 1, outside: 0, unaccounted: 3 }, blockers: ['x'] }
  assert.equal(summary(bad, false), '3 deviations · +1 addition · in no unit 3: the fact is not complete')
  assert.equal(summary(bad, true), '3 deviations · +1 addition · in no unit 3')
  assert.equal(summary({ counts: { match: 1, differs: 0, missing: 0, unplanned: 0, unaccounted: 0, ungrounded: 0 }, blockers: [] }, true), 'As planned', 'a fact of an older compare has no additions')
})

test('summary and planFactLine: recorded deviations with what the doc backs; one line that never blocks (review-v3-concise-design-first.3)', () => {
  const counts = { match: 1, differs: 0, missing: 0, unplanned: 2, unaccounted: 0, ungrounded: 0 }
  assert.equal(summary({ counts, blockers: [], deviations: [{ text: 'a', backed: true }] }, false), '1 deviation (1 backed by the doc)')
  assert.equal(summary({ counts, blockers: [], deviations: [] }, false), 'As planned', 'an edge counted by status is no deviation')
  assert.equal(planFactLine({ deviations: [{ text: 'a', backed: false, level: 'high' }] }, null), 'Plan ↔ fact: 1 deviation; it never blocks merge.')
  assert.equal(planFactLine(null, { deviations: [] }), 'Plan ↔ fact: as planned; it never blocks merge.')
  assert.equal(planFactLine(null, null), 'Plan ↔ fact: not compared yet.')
})
