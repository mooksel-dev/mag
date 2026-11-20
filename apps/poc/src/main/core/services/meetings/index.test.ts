import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Capture, OnChunk } from '../../clients/audio-capture/index.ts'
import type { MeetingFiles, MeetingMeta, TranscriptLine } from '../../clients/meeting-files/index.ts'
import { Chunker, TranscriptMerger, createMeetings, quietestCut, type Recording } from './index.ts'

const RATE = 16_000
const tone = (seconds: number, level = 0.5) => new Float32Array(seconds * RATE).fill(level)

function fakes(opts: { setupFails?: string; captureFails?: string } = {}) {
  let onChunk: OnChunk = () => {}
  let endHelper: (e: string | null) => void = () => {}
  const transcribed: number[] = []
  const lines: TranscriptLine[] = []
  const metas: MeetingMeta[] = []
  const created: Omit<MeetingMeta, 'id'>[] = []
  const statuses: (Recording | null)[] = []
  const stopped: MeetingMeta[] = []
  let closed = 0
  const files: MeetingFiles = {
    create: (meta) => (created.push(meta), { id: '2026-11-20-1430-sync', dir: '/m' }),
    appendTranscript: (_, l) => void lines.push(...l),
    writeMeta: (_, m) => void metas.push(m),
  }
  const meetings = createMeetings({
    capture: async (cb) => {
      if (opts.captureFails) throw new Error(opts.captureFails)
      onChunk = cb
      return { close: async () => void closed++, ended: new Promise<string | null>((r) => (endHelper = r)) } satisfies Capture
    },
    stt: {
      ensureModel: async (progress) => {
        progress?.({ step: 'load' })
        if (opts.setupFails) throw new Error(opts.setupFails)
      },
      // One segment per chunk, 1 s in, naming the chunk's length.
      transcribe: async (pcm) => (transcribed.push(pcm.length / RATE), [{ start: 1, end: 2, text: `${Math.round(pcm.length / RATE)}s` }]),
    },
    files,
    now: () => new Date('2026-11-20T14:30:00Z'),
    onChange: (s) => statuses.push(s),
    onStopped: (m) => stopped.push(m),
  })
  return { meetings, push: (...a: Parameters<OnChunk>) => onChunk(...a), endHelper: (e: string | null) => endHelper(e), transcribed, lines, metas, created, statuses, stopped, closed: () => closed }
}

test('a recording: both channels chunked, transcribed, merged by time; stop flushes the tails and finalizes meta', async () => {
  const f = fakes()
  const meeting = await f.meetings.start('  DBO sync ')
  assert.deepEqual(meeting, { id: '2026-11-20-1430-sync', title: 'DBO sync', startedAt: '2026-11-20T14:30:00.000Z' })
  assert.equal(f.meetings.status()?.phase, 'recording')
  f.push(tone(31), 'others', 0)
  f.push(tone(31), 'me', 0)
  f.push(tone(10), 'others', 31)
  const stopped = await f.meetings.stop()
  assert.equal(f.closed(), 1)
  assert.deepEqual(f.lines.map((l) => [l.speaker, Math.round(l.at), l.text]), [
    ['others', 1, '30s'],
    ['me', 1, '30s'],
    ['me', 31, '1s'],
    ['others', 31, '11s'],
  ])
  assert.equal(stopped.endedAt, '2026-11-20T14:30:00.000Z')
  assert.equal(stopped.error, undefined)
  assert.deepEqual(f.metas, [stopped])
  assert.deepEqual(f.stopped, [stopped])
  assert.equal(f.meetings.status(), null)
  assert.equal(f.statuses.at(-1), null)
})

test('silence is not sent to whisper', async () => {
  const f = fakes()
  await f.meetings.start()
  assert.equal(f.created[0].title, 'Call')
  f.push(tone(30, 0.001), 'others', 0)
  f.push(tone(30), 'me', 0)
  await f.meetings.stop()
  assert.deepEqual(f.transcribed, [29.95])
  assert.deepEqual(f.lines.map((l) => l.speaker), ['me'])
})

test('start while recording, stop while idle: rejected', async () => {
  const f = fakes()
  await assert.rejects(f.meetings.stop(), /Nothing is being recorded/)
  await f.meetings.start()
  await assert.rejects(f.meetings.start(), /already being recorded/)
  await f.meetings.stop()
})

test('a capture that cannot start leaves no meeting and no status', async () => {
  const f = fakes({ captureFails: 'microphone access denied' })
  await assert.rejects(f.meetings.start(), /microphone access denied/)
  assert.equal(f.created.length, 0)
  assert.equal(f.meetings.status(), null)
})

test('transcription that cannot be set up stops the recording with the reason in meta.json', async () => {
  const f = fakes({ setupFails: 'HTTP 403' })
  await f.meetings.start()
  f.push(tone(30), 'me', 0)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(f.meetings.status(), null)
  assert.equal(f.stopped.length, 1)
  assert.match(f.stopped[0].error!, /Transcription is not available: HTTP 403/)
  assert.deepEqual(f.transcribed, [])
})

test('the helper ending on its own stops the recording and keeps what was transcribed', async () => {
  const f = fakes()
  await f.meetings.start()
  f.push(tone(30), 'me', 0)
  f.endHelper('device lost')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(f.meetings.status(), null)
  assert.match(f.stopped[0].error!, /Recording stopped: device lost/)
  assert.deepEqual(f.lines.map((l) => l.text), ['30s'])
})

test('Chunker: cuts near 30 s at the quietest moment, keeps the rest; a too short tail is dropped', () => {
  const c = new Chunker()
  const pcm = tone(32)
  pcm.fill(0, 27 * RATE, 27 * RATE + 1600)
  assert.deepEqual(c.push(pcm.subarray(0, 10 * RATE), 5), [])
  const [chunk, ...more] = c.push(pcm.subarray(10 * RATE), 15)
  assert.equal(more.length, 0)
  assert.equal(chunk.at, 5)
  assert.equal(chunk.pcm.length, 27 * RATE + 800)
  const tail = c.flush()!
  assert.equal(tail.at, 5 + 27.05)
  assert.equal(tail.pcm.length, 32 * RATE - chunk.pcm.length)
  c.push(tone(0.2), 0)
  assert.equal(c.flush(), null)
})

test('quietestCut: the latest frame when all are equally loud', () => {
  assert.equal(quietestCut(tone(2), 0, 2 * RATE), 2 * RATE - 800)
})

test('TranscriptMerger: holds lines until both channels passed them; a channel far behind holds back no longer', () => {
  const m = new TranscriptMerger()
  const line = (at: number, speaker: 'me' | 'others') => ({ at, speaker, text: `${speaker}${at}` })
  assert.deepEqual(m.add('me', [line(5, 'me'), line(25, 'me')], 30), [])
  assert.deepEqual(m.add('others', [line(3, 'others')], 20).map((l) => l.text), ['others3', 'me5'])
  assert.deepEqual(m.add('me', [], 120).map((l) => l.text), ['me25'])
  assert.deepEqual(m.flush(), [])
})
