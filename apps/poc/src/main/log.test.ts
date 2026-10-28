import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLog, log, logFileName, logTail, pruneLogs } from './log.ts'
import { Crashes } from './crash.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'mag-log-'))

test('log lines are JSON with time, level, scope and message, in a file per day', () => {
  const dir = tmp()
  initLog(dir, false)
  log.info('agent', 'developer started', { task: 'T-3' })
  log.error('ipc', 'task:move failed', new Error('boom'))
  const lines = readFileSync(join(dir, logFileName(new Date())), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.deepEqual({ ...lines[0], time: undefined }, { time: undefined, level: 'info', scope: 'agent', msg: 'developer started', data: { task: 'T-3' } })
  assert.equal(lines[1].data.message, 'boom')
  assert.match(lines[1].data.stack, /boom/)
  assert.deepEqual(logTail().slice(-2).map((l) => JSON.parse(l).msg), ['developer started', 'task:move failed'])
})

test('logFileName pads month and day', () => {
  assert.equal(logFileName(new Date(2026, 0, 5)), 'main-2026-01-05.log')
})

test('pruneLogs keeps the last 7 days of logs and other files', () => {
  const dir = tmp()
  const now = new Date(2026, 9, 28, 12)
  for (const day of [20, 21, 22, 28]) writeFileSync(join(dir, logFileName(new Date(2026, 9, day))), '')
  writeFileSync(join(dir, 'notes.txt'), '')
  assert.deepEqual(pruneLogs(dir, now), ['main-2026-10-20.log', 'main-2026-10-21.log'])
  assert.deepEqual(readdirSync(dir).sort(), ['main-2026-10-22.log', 'main-2026-10-28.log', 'notes.txt'])
})

test('crash reports carry the version and log tail; last() shows only undismissed crashes of an earlier run', () => {
  const dir = tmp()
  const start = 1_000_000
  const crashes = new Crashes(dir, '1.2.3', () => ['line'], start)
  assert.equal(crashes.last(), null)
  const path = crashes.write({ kind: 'renderer', message: 'x is undefined', screen: 'Plan' }, start - 10)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { kind: 'renderer', message: 'x is undefined', screen: 'Plan', time: start - 10, appVersion: '1.2.3', log: ['line'] })
  crashes.write({ kind: 'uncaughtException', message: 'older' }, start - 20)
  crashes.write({ kind: 'uncaughtException', message: 'this run' }, start + 5)
  assert.equal(crashes.last()?.message, 'x is undefined')
  crashes.dismiss(start)
  assert.equal(crashes.last(), null)
})

test('a native minidump from the previous run counts as a crash', () => {
  const dir = tmp()
  const crashes = new Crashes(dir, '1.0.0', () => [], Date.now())
  mkdirSync(join(crashes.nativeDir, 'completed'))
  const dump = join(crashes.nativeDir, 'completed', 'a.dmp')
  writeFileSync(dump, '')
  const at = new Date(Date.now() - 60_000)
  utimesSync(dump, at, at)
  const last = crashes.last()
  assert.equal(last?.kind, 'native')
  assert.match(last!.message, /a\.dmp/)
})
