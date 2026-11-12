import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findingLines, findingWhere, pickedByDefault } from './index.ts'

test('findingLines: the summary and the comment; without one, the first sentence without the label, the comment only when it says more', () => {
  assert.deepEqual(findingLines({ summary: 'Sync failure blocks activation', text: 'Risk (bug): long comment.' }), { summary: 'Sync failure blocks activation', comment: 'Risk (bug): long comment.' })
  assert.deepEqual(findingLines({ text: 'Risk (ops): A re-grant resends every removal at once. (Resume sets next_run_at=now.)' }), {
    summary: 'A re-grant resends every removal at once.',
    comment: 'Risk (ops): A re-grant resends every removal at once. (Resume sets next_run_at=now.)',
  })
  assert.deepEqual(findingLines({ text: 'Does AP stop granting it once a user is deleted?' }), { summary: 'Does AP stop granting it once a user is deleted?', comment: null })
})

test('findingWhere: a file and line or a module; an inventory unit id is mag\'s own', () => {
  assert.equal(findingWhere({ where: 'docs/a.md:278' }), 'docs/a.md:278')
  assert.equal(findingWhere({ where: 'u365' }), null)
  assert.equal(findingWhere({}), null)
})

test('pickedByDefault: the blockers, unless the user picked', () => {
  assert.deepEqual(['blocker', 'should_fix', 'question', 'nit'].map((level) => pickedByDefault({ level: level as 'blocker' })), [true, false, false, false])
  assert.equal(pickedByDefault({ level: 'nit', post: true }), true)
  assert.equal(pickedByDefault({ level: 'blocker', post: false }), false)
})
