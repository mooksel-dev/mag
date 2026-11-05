import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composerRoute } from './index.ts'

test('composerRoute: words open a discussion', () => {
  assert.deepEqual(composerRoute('  Why does step 2.1 block?  '), { kind: 'ask', text: 'Why does step 2.1 block?', label: 'Ask · opens a discussion' })
  assert.equal(composerRoute('see https://example.com/x for details').kind, 'ask')
})

test('composerRoute: empty text sends nothing', () => {
  assert.equal(composerRoute('').kind, 'none')
  assert.equal(composerRoute('  \n ').kind, 'none')
  assert.equal(composerRoute('   ', ['shot.png']).kind, 'none')
})

test('composerRoute: a GitHub PR link reviews the PR, with the whole text as the old field sent it', () => {
  assert.deepEqual(composerRoute(' https://github.com/acme/api/pull/12 '), { kind: 'review', url: 'https://github.com/acme/api/pull/12', label: 'Review PR' })
  assert.deepEqual(composerRoute('https://github.com/acme/api/pull/12/files'), { kind: 'review', url: 'https://github.com/acme/api/pull/12/files', label: 'Review PR' })
  // Not a PR: an issue, http, no number.
  assert.equal(composerRoute('https://github.com/acme/api/issues/12').kind, 'ticket')
  assert.equal(composerRoute('http://github.com/acme/api/pull/12').kind, 'ticket')
  assert.equal(composerRoute('https://github.com/acme/api/pull/new').kind, 'ticket')
})

test('composerRoute: any other single link starts a work from that ticket', () => {
  assert.deepEqual(composerRoute('https://acme.atlassian.net/browse/API-7'), { kind: 'ticket', url: 'https://acme.atlassian.net/browse/API-7', label: 'From ticket' })
  // A link with words around it is words.
  assert.equal(composerRoute('https://acme.atlassian.net/browse/API-7 please').kind, 'ask')
})

test('composerRoute: a dropped .zip imports a review before any text', () => {
  assert.deepEqual(composerRoute('https://github.com/acme/api/pull/12', ['/tmp/a.png', '/tmp/Review-12.ZIP']), { kind: 'import', file: '/tmp/Review-12.ZIP', label: 'Import review' })
  assert.equal(composerRoute('', ['review.zip']).kind, 'import')
  assert.equal(composerRoute('hello', ['notes.txt']).kind, 'ask')
})
