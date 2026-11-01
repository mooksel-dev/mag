import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ticketLabel, ticketRef, withTicket } from './index.ts'

test('ticketRef: any https link; the key a URL shows, or the one given (T-55.5)', () => {
  assert.deepEqual(ticketRef(' https://acme.atlassian.net/browse/abc-12 '), { url: 'https://acme.atlassian.net/browse/abc-12', key: 'ABC-12' })
  assert.deepEqual(ticketRef('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-3'), { url: 'https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-3', key: 'ABC-3' })
  assert.deepEqual(ticketRef('https://linear.app/acme/issue/ENG-7/fix-login'), { url: 'https://linear.app/acme/issue/ENG-7/fix-login', key: 'ENG-7' })
  assert.deepEqual(ticketRef('https://github.com/o/r/issues/5'), { url: 'https://github.com/o/r/issues/5' })
  assert.deepEqual(ticketRef('https://github.com/o/r/issues/5', ' r#5 '), { url: 'https://github.com/o/r/issues/5', key: 'r#5' })
  assert.deepEqual(ticketRef('https://x-1.example.com/t/9'), { url: 'https://x-1.example.com/t/9' }, 'a host is not a key')
  assert.throws(() => ticketRef('ABC-12'), /Not a ticket link: ABC-12/)
  assert.throws(() => ticketRef('http://x.com/browse/A-1'), /Not a ticket link/)
  assert.throws(() => ticketRef(''), /\(empty\)/)
})

test('ticketLabel: the key, else the link without https://', () => {
  assert.equal(ticketLabel({ url: 'https://x/browse/A-1', key: 'A-1' }), 'A-1')
  assert.equal(ticketLabel({ url: 'https://github.com/o/r/issues/5/' }), 'github.com/o/r/issues/5')
})

test('withTicket: one entry per URL or key; the comment mark stays', () => {
  const a = { url: 'https://x/browse/A-1', key: 'A-1', commentedAt: 5 }
  assert.deepEqual(withTicket(undefined, { url: 'https://x/browse/A-1' }), [{ url: 'https://x/browse/A-1' }])
  assert.deepEqual(withTicket([a], { url: 'https://x/browse/A-1?focusedCommentId=2', key: 'A-1' }), [{ url: 'https://x/browse/A-1?focusedCommentId=2', key: 'A-1', commentedAt: 5 }])
  assert.deepEqual(withTicket([a], { url: 'https://y/2' }), [a, { url: 'https://y/2' }])
})
