import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopeKey } from './trackers.ts'

test('scopeKey: trimmed and upper case; not a key prefix is null', () => {
  assert.equal(scopeKey(' abc '), 'ABC')
  assert.equal(scopeKey('ENG2'), 'ENG2')
  assert.equal(scopeKey(''), null)
  assert.equal(scopeKey('AB-1'), null)
  assert.equal(scopeKey('1AB'), null)
})
