// The call's audio on this Mac: the microphone (`me`) and the system audio (`others`), from the mag-audio helper
// (native/mag-audio: a Core Audio process tap; Electron 37's loopback is Windows-only). PCM stays in memory.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export type Channel = 'me' | 'others'

/** Samples per second of every chunk: 16 kHz mono Float32, what whisper takes. */
export const SAMPLE_RATE = 16_000

/** `at`: seconds since the capture opened at the chunk's first sample, counted per channel. */
export type OnChunk = (pcm: Float32Array, channel: Channel, at: number) => void

export interface Capture {
  /** Stops both channels; resolves once the helper exited and every chunk was delivered. */
  close(): Promise<void>
  /** Resolves when the helper ends on its own: with its error, or null when closed. */
  ended: Promise<string | null>
}

const CHANNELS: Channel[] = ['me', 'others']
/** How long the start waits for the user to answer macOS's permission prompts. */
export const PERMISSION_WAIT_MS = 120_000

/** Splits the helper's stdout into chunks: [1 byte channel][u32 LE sample count][Float32 LE samples]. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)
  private samples = [0, 0]
  constructor(private onChunk: OnChunk) {}

  push(data: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    while (this.buf.length >= 5) {
      const channel = this.buf[0]
      const count = this.buf.readUInt32LE(1)
      if (channel > 1) throw new Error(`mag-audio sent channel ${channel}`)
      const end = 5 + count * 4
      if (this.buf.length < end) break
      const pcm = new Float32Array(count)
      for (let i = 0; i < count; i++) pcm[i] = this.buf.readFloatLE(5 + i * 4)
      this.buf = this.buf.subarray(end)
      const at = this.samples[channel] / SAMPLE_RATE
      this.samples[channel] += count
      this.onChunk(pcm, CHANNELS[channel], at)
    }
  }
}

/**
 * Starts capturing with the helper at `helperPath`; resolves once both channels run. The first run asks macOS for the
 * microphone and system audio permissions, so it waits for the user's answer. Rejects with the helper's reason.
 */
export function openCapture(helperPath: string, onChunk: OnChunk, waitMs = PERMISSION_WAIT_MS): Promise<Capture> {
  if (!existsSync(helperPath)) return Promise.reject(new Error(`The audio helper is not built: run \`pnpm --filter @mag/poc build:audio\` (${helperPath})`))
  const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const reader = new FrameReader(onChunk)
  let error: string | null = null
  let ready = false
  let stderr = ''
  let closing = false
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      try {
        reader.push(d)
      } catch (e) {
        error = (e as Error).message
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      let nl: number
      while ((nl = stderr.indexOf('\n')) >= 0) {
        const line = stderr.slice(0, nl)
        stderr = stderr.slice(nl + 1)
        let ev: { event?: string; message?: string }
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.event === 'error') error = ev.message ?? 'mag-audio failed'
        if (ev.event === 'ready' && !ready) {
          ready = true
          clearTimeout(unanswered)
          resolve({ close, ended })
        }
      }
    })
    const exited = new Promise<number | null>((done) => child.on('close', done))
    child.on('error', (e) => (error = e.message))
    child.stdin.on('error', () => {})
    const ended = exited.then((code) => (closing ? error : (error ?? `mag-audio exited (code ${code})`)))
    const close = async () => {
      closing = true
      child.stdin.end()
      const kill = setTimeout(() => child.kill('SIGTERM'), 3000)
      await exited
      clearTimeout(kill)
    }
    const unanswered = setTimeout(() => {
      error = 'macOS did not let mag-audio record: answer its prompt, or allow it in System Settings → Privacy & Security → Microphone and → Screen & System Audio Recording'
      child.kill('SIGTERM')
    }, waitMs)
    void ended.then((e) => {
      clearTimeout(unanswered)
      if (!ready) reject(new Error(e ?? 'mag-audio exited before it started'))
    })
  })
}
