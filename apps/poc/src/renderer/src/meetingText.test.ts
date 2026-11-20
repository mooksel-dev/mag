import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkKey, meetingWhen, transcriptLines } from './meetingText.ts'

test('transcriptLines: the [hh:mm:ss] speaker: text lines only', () => {
  const md = '# Sync\n\n> Recorded locally…\n\n[00:00:05] me: Привіт: як справи?\n[00:01:00] others: ok\nnot a line\n'
  assert.deepEqual(transcriptLines(md), [{ at: '00:00:05', speaker: 'me', text: 'Привіт: як справи?' }, { at: '00:01:00', speaker: 'others', text: 'ok' }])
})

test('meetingWhen: date, time and length', () => {
  const startedAt = new Date(2026, 10, 20, 14, 30).toISOString()
  assert.match(meetingWhen({ startedAt, endedAt: new Date(2026, 10, 20, 15, 12).toISOString() }, 'en-GB'), /^20 Nov, 14:30 · 42 min$/)
  assert.match(meetingWhen({ startedAt, endedAt: new Date(2026, 10, 20, 16, 0).toISOString() }, 'en-GB'), /· 1 h 30 min$/)
  assert.equal(meetingWhen({ startedAt }, 'en-GB'), '20 Nov, 14:30')
})

test('linkKey: a topic and a work of one project differ', () => {
  assert.notEqual(linkKey({ projectId: 'p', topicId: 'x' }), linkKey({ projectId: 'p', workKey: 'x' }))
})
