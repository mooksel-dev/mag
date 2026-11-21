import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Capture, OnChunk } from '../../clients/audio-capture/index.ts'
import type { MeetingFiles, MeetingMeta, TranscriptLine } from '../../clients/meeting-files/index.ts'
import { Chunker, TranscriptMerger, bound, createMeetings, filterMeetings, participantsOf, quietestCut, type Recording } from './index.ts'

const RATE = 16_000
const tone = (seconds: number, level = 0.5) => new Float32Array(seconds * RATE).fill(level)

function fakes(opts: { setupFails?: string; captureFails?: string; summary?: string } = {}) {
  let onChunk: OnChunk = () => {}
  let endHelper: (e: string | null) => void = () => {}
  const transcribed: number[] = []
  const lines: TranscriptLine[] = []
  const metas: MeetingMeta[] = []
  const created: Omit<MeetingMeta, 'id'>[] = []
  const statuses: (Recording | null)[] = []
  const stopped: MeetingMeta[] = []
  let closed = 0
  const disk = new Map<string, { meta: MeetingMeta; summary: string }>()
  const versionOf = (id: string) => JSON.stringify(disk.get(id)).length + lines.length
  const at = (id: string) => {
    const m = disk.get(id)
    if (!m) throw new Error(`No meeting ${id}`)
    return m
  }
  const files: MeetingFiles = {
    create: (meta) => {
      created.push(meta)
      const id = created.length === 1 ? '2026-11-20-1430-sync' : `2026-11-20-1430-sync-${created.length}`
      disk.set(id, { meta: { id, ...meta }, summary: '' })
      return { id, dir: `/m/${id}` }
    },
    appendTranscript: (_, l) => void lines.push(...l),
    writeMeta: (id, m) => void (metas.push(m), (at(id).meta = m)),
    writeSummary: (id, md) => void (at(id).summary = md),
    list: () => [...disk.values()].map((d) => d.meta).reverse(),
    read: (id) => ({ meta: at(id).meta, summary: at(id).summary, transcript: lines.map((l) => `[00:00:0${Math.floor(l.at) % 10}] ${l.speaker}: ${l.text}`).join('\n'), dir: `/m/${id}` }),
    remove: (id) => void (at(id), disk.delete(id)),
    dirOf: (id) => `/m/${id}`,
    changedAt: (id) => (disk.has(id) ? versionOf(id) : 0),
  }
  const prompts: string[] = []
  let changes = 0
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
    llm: { complete: async (prompt, input) => (prompts.push(input), opts.summary ?? '## Decisions\n- ship it') },
    now: () => new Date('2026-11-20T14:30:00Z'),
    onMeetingsChanged: () => void changes++,
    onChange: (s) => statuses.push(s),
    onStopped: (m) => stopped.push(m),
  })
  return { meetings, push: (...a: Parameters<OnChunk>) => onChunk(...a), endHelper: (e: string | null) => endHelper(e), transcribed, lines, metas, created, statuses, stopped, closed: () => closed, disk, prompts, changes: () => changes }
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

const tick = () => new Promise((r) => setTimeout(r, 10))

test('stop summarizes a meeting that has lines; participants go to meta.json', async () => {
  const f = fakes({ summary: '## Decisions\n- ship\n\n## Participants\n- **Olena**\n- me\n- Olena\n' })
  await f.meetings.start()
  f.push(tone(30), 'me', 0)
  await f.meetings.stop()
  assert.deepEqual(f.meetings.summarizing(), ['2026-11-20-1430-sync'])
  await tick()
  assert.deepEqual(f.meetings.summarizing(), [])
  assert.deepEqual(f.prompts, ['[00:00:01] me: 30s'])
  const { meta, summary } = f.meetings.read('2026-11-20-1430-sync')
  assert.match(summary, /## Decisions/)
  assert.deepEqual(meta.participants, ['Olena', 'me'])
  assert.equal(meta.endedAt, '2026-11-20T14:30:00.000Z')
})

test('a meeting with no speech is not summarized', async () => {
  const f = fakes()
  await f.meetings.start()
  await f.meetings.stop()
  await tick()
  assert.deepEqual(f.prompts, [])
})

test('rename and link while recording reach the final meta.json; delete refuses the recording one', async () => {
  const f = fakes()
  const m = await f.meetings.start()
  f.meetings.rename(m.id, ' Planning ')
  assert.equal(f.meetings.status()?.meeting?.title, 'Planning')
  const work = { projectId: 'p1', workKey: 'ABC-1' }
  f.meetings.link(m.id, work)
  f.meetings.link(m.id, work)
  f.meetings.link(m.id, { projectId: 'p1', topicId: 's1' })
  assert.throws(() => f.meetings.remove(m.id), /Stop the recording/)
  const done = await f.meetings.stop()
  assert.equal(done.title, 'Planning')
  assert.deepEqual(done.links, [work, { projectId: 'p1', topicId: 's1' }])
  assert.deepEqual(f.meetings.unlink(m.id, work).links, [{ projectId: 'p1', topicId: 's1' }])
  assert.throws(() => f.meetings.rename(m.id, '  '), /needs a title/)
  f.meetings.remove(m.id)
  assert.deepEqual(f.meetings.list(), [])
  assert.ok(f.changes() > 0)
})

test('summarize: one run per meeting at a time; a failure is reported and can be retried', async () => {
  const f = fakes()
  await f.meetings.start()
  await f.meetings.stop()
  const a = f.meetings.summarize('2026-11-20-1430-sync')
  assert.equal(f.meetings.summarize('2026-11-20-1430-sync'), a)
  await a
  await assert.rejects(f.meetings.summarize('nope'), /No meeting nope/)
})

test('participantsOf: the Participants section only', () => {
  assert.deepEqual(participantsOf('## Decisions\n- a\n## Participants\n- Ivan\n* Maria  \n## Notes\n- x'), ['Ivan', 'Maria'])
  assert.deepEqual(participantsOf('## Participants\n- None.'), [])
  assert.deepEqual(participantsOf('no sections'), [])
})

test('the search index hears of every change: saved, summarized, renamed, deleted; the recording is not indexed yet', async () => {
  const f = fakes()
  const m = await f.meetings.start('Sync')
  assert.equal(f.meetings.recordingId(), m.id)
  f.push(tone(30), 'me', 0)
  const before = f.changes()
  await f.meetings.stop()
  assert.equal(f.meetings.recordingId(), null)
  assert.ok(f.changes() > before)
  await tick()
  const summarized = f.changes()
  const version = f.meetings.changedAt(m.id)
  f.meetings.rename(m.id, 'Planning')
  assert.equal(f.changes(), summarized + 1)
  assert.notEqual(f.meetings.changedAt(m.id), version)
  f.meetings.remove(m.id)
  assert.equal(f.changes(), summarized + 2)
})

test('bound and filterMeetings: a date alone is the whole local day; a bad date is an error', () => {
  const m = (startedAt: string, participants?: string[]) => ({ id: startedAt, title: '', startedAt, participants })
  const late = m(new Date(2026, 10, 20, 23, 59).toISOString(), ['Андрій'])
  assert.deepEqual(filterMeetings([late], { from: '2026-11-20', to: '2026-11-20' }), [late])
  assert.deepEqual(filterMeetings([late], { to: '2026-11-19' }), [])
  assert.deepEqual(filterMeetings([late, m('2026-01-01T00:00:00Z')], { people: ['андр'] }), [late])
  assert.throws(() => bound('soon', false), /Not a date: soon/)
})

test('participants: names of meta.json and the summary, each once, "me" left out (who-is-who-people-from.2)', async () => {
  const f = fakes()
  const { id } = await f.meetings.start('Sync')
  await f.meetings.stop()
  const m = f.disk.get(id)!
  m.meta = { ...m.meta, participants: ['Olena', 'me', 'Ihor  Koval'] }
  m.summary = '## Participants\n- olena\n- Ievgen\n- Me\n'
  assert.deepEqual(f.meetings.participants(id), ['Olena', 'Ihor  Koval', 'Ievgen'])
})
