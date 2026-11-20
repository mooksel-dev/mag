import { test } from 'node:test'
import assert from 'node:assert/strict'
import { elapsed, hotkeyLabel, recordingNote } from './recordingText.ts'

test('hotkeyLabel: macOS order of modifiers', () => {
  assert.equal(hotkeyLabel('CommandOrControl+Alt+Shift+R'), '⌥⇧⌘R')
  assert.equal(hotkeyLabel('Shift+Ctrl+M'), '⌃⇧M')
})

test('elapsed: m:ss, then h:mm:ss', () => {
  assert.equal(elapsed(75_400), '1:15')
  assert.equal(elapsed(3_725_000), '1:02:05')
  assert.equal(elapsed(-5), '0:00')
})

test('recordingNote: permissions on start, setup progress, what is left on stop, else the error', () => {
  const rec = { meeting: null, dir: null, startedAt: '', phase: 'recording' as const, setup: null, pending: 0 }
  assert.match(recordingNote({ ...rec, phase: 'starting' })!, /allow mag-audio/)
  assert.equal(recordingNote({ ...rec, setup: { step: 'model', done: 400e6, total: 1600e6 } }), 'Downloading the speech model 25% of 1600 MB; recording meanwhile')
  assert.equal(recordingNote({ ...rec, phase: 'stopping', pending: 2 }), 'Transcribing the last 2 pieces…')
  assert.equal(recordingNote(rec), null)
  assert.equal(recordingNote({ ...rec, error: 'x' }), 'x')
})
