// Meetings (meetings-local-recording-transcript-and): records a call on this Mac and transcribes it locally into its
// folder. Audio lives in memory only, ~30 s per channel at a time, until whisper has turned it into text.
import type { Capture, Channel, OnChunk } from '../../clients/audio-capture/index.ts'
import type { MeetingFiles, TranscriptLine } from '../../clients/meeting-files/index.ts'
import type { Stt } from '../../clients/stt/index.ts'
import type { Meeting, Recording } from './types.ts'

export type * from './types.ts'

export interface MeetingsDeps {
  capture(onChunk: OnChunk): Promise<Capture>
  stt: Pick<Stt, 'ensureModel' | 'transcribe'>
  files: MeetingFiles
  now?: () => Date
  onChange?: (status: Recording | null) => void
  /** A meeting's end: by stop() or on its own (the helper ended, transcription could not start). */
  onStopped?: (meeting: Meeting, dir: string) => void
  onError?: (message: string, e: unknown) => void
}

export interface Meetings {
  /** Starts capturing mic and system audio and creates the meeting's folder; rejects while recording. */
  start(title?: string): Promise<Meeting>
  /** Stops capturing, transcribes what is left and finalizes meta.json. */
  stop(): Promise<Meeting>
  status(): Recording | null
}

const RATE = 16_000
export const CHUNK_SECONDS = 30
/** A chunk is cut at its quietest 100 ms in its last seconds, so a word is rarely split. */
const CUT_WINDOW_SECONDS = 5
const FRAME = RATE / 10
/** Below this peak a chunk is silence: whisper would only make words up. */
export const SILENCE_PEAK = 0.01
/** A channel further behind than this stops holding the other's lines back. */
const MAX_LAG_SECONDS = 3 * CHUNK_SECONDS
/** A last piece shorter than this is not worth transcribing. */
const MIN_TAIL_SECONDS = 0.5
/** Errors kept in meta.json; a broken run repeats the same few. */
const MAX_ERRORS = 5

export interface Chunk {
  pcm: Float32Array
  /** Seconds since the capture opened. */
  at: number
}

/** Collects one channel's PCM into chunks of about CHUNK_SECONDS. */
export class Chunker {
  private parts: Float32Array[] = []
  private length = 0
  private at: number | null = null

  constructor(private seconds = CHUNK_SECONDS, private window = CUT_WINDOW_SECONDS) {}

  push(pcm: Float32Array, at: number): Chunk[] {
    this.at ??= at
    this.parts.push(pcm)
    this.length += pcm.length
    const chunks: Chunk[] = []
    const size = this.seconds * RATE
    while (this.length >= size) {
      const all = this.take()
      const cut = quietestCut(all, size - this.window * RATE, size)
      chunks.push({ pcm: all.slice(0, cut), at: this.at })
      this.at += cut / RATE
      this.keep(all.subarray(cut))
    }
    return chunks
  }

  /** What is left, unless it is too short to hold speech. */
  flush(): Chunk | null {
    const all = this.take()
    const at = this.at
    this.at = null
    return at !== null && all.length >= MIN_TAIL_SECONDS * RATE ? { pcm: all, at } : null
  }

  private take(): Float32Array {
    const all = new Float32Array(this.length)
    let o = 0
    for (const p of this.parts) (all.set(p, o), (o += p.length))
    this.parts = []
    this.length = 0
    return all
  }

  private keep(rest: Float32Array) {
    if (!rest.length) return
    this.parts = [rest.slice()]
    this.length = rest.length
  }
}

/** Index in [from, to) at the middle of the quietest 100 ms frame. */
export function quietestCut(pcm: Float32Array, from: number, to: number): number {
  let best = to
  let bestEnergy = Infinity
  for (let s = Math.max(0, from); s + FRAME <= to; s += FRAME) {
    let e = 0
    for (let i = s; i < s + FRAME; i++) e += pcm[i] * pcm[i]
    if (e <= bestEnergy) (bestEnergy = e, (best = s + FRAME / 2))
  }
  return best
}

export function peak(pcm: Float32Array): number {
  let m = 0
  for (let i = 0; i < pcm.length; i++) m = Math.max(m, Math.abs(pcm[i]))
  return m
}

/**
 * Orders both channels' lines by time: a line is released once both channels are transcribed past it, so transcript.md
 * only ever grows in time order (a channel that falls MAX_LAG_SECONDS behind no longer holds the other back).
 */
export class TranscriptMerger {
  private pending: TranscriptLine[] = []
  private until: Record<Channel, number> = { me: 0, others: 0 }

  add(channel: Channel, lines: TranscriptLine[], until: number): TranscriptLine[] {
    this.pending.push(...lines)
    this.until[channel] = Math.max(this.until[channel], until)
    const lead = Math.max(this.until.me, this.until.others)
    const mark = Math.max(Math.min(this.until.me, this.until.others), lead - MAX_LAG_SECONDS)
    return this.release((l) => l.at < mark)
  }

  flush(): TranscriptLine[] {
    return this.release(() => true)
  }

  private release(ready: (l: TranscriptLine) => boolean): TranscriptLine[] {
    const out = this.pending.filter(ready).sort((a, b) => a.at - b.at)
    this.pending = this.pending.filter((l) => !ready(l))
    return out
  }
}

/** What one recording holds in memory. */
interface Session {
  capture: Capture | null
  chunkers: Record<Channel, Chunker>
  merger: TranscriptMerger
  /** Transcription jobs, one at a time, in the order the chunks came. */
  queue: Promise<void>
  setup: Promise<void>
  errors: string[]
  stopping: Promise<Meeting> | null
}

export function createMeetings(deps: MeetingsDeps): Meetings {
  const now = deps.now ?? (() => new Date())
  let rec: Recording | null = null
  let session: Session | null = null

  const changed = () => deps.onChange?.(rec ? { ...rec } : null)
  const fail = (message: string, e: unknown) => {
    deps.onError?.(message, e)
    if (session) session.errors.push(message)
    if (rec) rec.error = message
  }

  const write = (lines: TranscriptLine[]) => {
    if (!rec?.meeting || !lines.length) return
    try {
      deps.files.appendTranscript(rec.meeting.id, lines)
    } catch (e) {
      fail(`Writing the transcript failed: ${(e as Error).message}`, e)
    }
  }

  const enqueue = (channel: Channel, chunk: Chunk) => {
    const s = session!
    rec!.pending++
    changed()
    s.queue = s.queue.then(async () => {
      const until = chunk.at + chunk.pcm.length / RATE
      let lines: TranscriptLine[] = []
      const setUp = await s.setup.then(() => true, () => false)
      try {
        if (setUp && peak(chunk.pcm) >= SILENCE_PEAK) {
          lines = (await deps.stt.transcribe(chunk.pcm)).map((seg) => ({ at: chunk.at + seg.start, speaker: channel, text: seg.text }))
        }
      } catch (e) {
        fail(`${channel} at ${Math.floor(chunk.at)} s not transcribed: ${(e as Error).message}`, e)
      }
      write(s.merger.add(channel, lines, until))
      if (rec) rec.pending--
      changed()
    })
  }

  const finish = async (): Promise<Meeting> => {
    const s = session!
    const meeting: Meeting = { ...rec!.meeting! }
    const dir = rec!.dir!
    rec!.phase = 'stopping'
    changed()
    try {
      await s.capture?.close()
      for (const channel of ['me', 'others'] as const) {
        const tail = s.chunkers[channel].flush()
        if (tail) enqueue(channel, tail)
      }
      await s.queue
      write(s.merger.flush())
      meeting.endedAt = now().toISOString()
      if (s.errors.length) meeting.error = [...new Set(s.errors)].slice(0, MAX_ERRORS).join('; ')
      deps.files.writeMeta(meeting.id, meeting)
    } finally {
      rec = null
      session = null
      changed()
    }
    deps.onStopped?.(meeting, dir)
    return meeting
  }

  const stopOnItsOwn = (s: Session) => {
    s.stopping = finish()
    s.stopping.catch((e) => deps.onError?.(`Finishing the meeting failed: ${(e as Error).message}`, e))
  }

  return {
    async start(title) {
      if (rec) throw new Error('A meeting is already being recorded')
      const startedAt = now()
      rec = { meeting: null, dir: null, startedAt: startedAt.toISOString(), phase: 'starting', setup: null, pending: 0 }
      const s: Session = (session = {
        capture: null,
        chunkers: { me: new Chunker(), others: new Chunker() },
        merger: new TranscriptMerger(),
        queue: Promise.resolve(),
        setup: Promise.resolve(),
        errors: [],
        stopping: null,
      })
      changed()
      try {
        s.capture = await deps.capture((pcm, channel, at) => {
          if (session !== s) return
          for (const chunk of s.chunkers[channel].push(pcm, at)) enqueue(channel, chunk)
        })
      } catch (e) {
        rec = null
        session = null
        changed()
        throw e
      }
      const meta = { title: title?.trim() || 'Call', startedAt: startedAt.toISOString() }
      try {
        const { id, dir } = deps.files.create(meta)
        rec.meeting = { id, ...meta }
        rec.dir = dir
      } catch (e) {
        await s.capture.close()
        rec = null
        session = null
        changed()
        throw e
      }
      rec.phase = 'recording'
      s.setup = deps.stt.ensureModel((p) => {
        if (session !== s || !rec) return
        rec.setup = p
        changed()
      }).then(
        () => {
          if (session === s && rec) (rec.setup = null, changed())
        },
        (e) => {
          fail(`Transcription is not available: ${(e as Error).message}`, e)
          if (session === s && !s.stopping) stopOnItsOwn(s)
          throw e
        },
      )
      s.setup.catch(() => {})
      void s.capture.ended.then((error) => {
        if (session !== s || s.stopping) return
        fail(`Recording stopped: ${error ?? 'the audio helper ended'}`, error)
        stopOnItsOwn(s)
      })
      changed()
      return rec.meeting
    },

    stop() {
      const s = session
      if (!s || !rec) return Promise.reject(new Error('Nothing is being recorded'))
      if (rec.phase === 'starting') return Promise.reject(new Error('The recording is still starting'))
      s.stopping ??= finish()
      return s.stopping
    },

    status: () => (rec ? { ...rec } : null),
  }
}
