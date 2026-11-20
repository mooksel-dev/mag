// Speech to text on this Mac: whisper.cpp's whisper-server (Homebrew's whisper-cpp) with large-v3-turbo on Metal, kept
// running between chunks so the model loads once. Audio goes to it over localhost in memory; nothing is written.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Segment, SetupProgress } from './types.ts'

export type * from './types.ts'

export interface Stt {
  /** Installs whisper.cpp when missing, downloads the model once and starts the server; concurrent calls share one run. */
  ensureModel(onProgress?: (p: SetupProgress) => void): Promise<void>
  /** 16 kHz mono PCM → its speech; language detected per call. Calls ensureModel first. */
  transcribe(pcm: Float32Array): Promise<Segment[]>
  /** Stops the server. */
  close(): void
}

export interface SttOptions {
  /** Where the model is kept. */
  modelsDir: string
  /** whisper-server's path; found on PATH (else installed with brew) when not given. */
  server?: string
  model?: { file: string; url: string }
}

export const MODEL = {
  file: 'ggml-large-v3-turbo.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
}

const SAMPLE_RATE = 16_000
/** "ggml" as whisper.cpp writes it, little-endian: a download that is a proxy's page instead is caught by it. */
const GGML_MAGIC = 0x67676d6c

/** 16-bit PCM WAV of 16 kHz mono samples. */
export function wav(pcm: Float32Array): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + pcm.length * 2, 4)
  b.write('WAVEfmt ', 8, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SAMPLE_RATE, 24)
  b.writeUInt32LE(SAMPLE_RATE * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2)
  return b
}

/** whisper-server's verbose_json → segments with text; markers like [BLANK_AUDIO] or (music) dropped. */
export function parseSegments(body: unknown): Segment[] {
  const segments = (body as { segments?: { start?: number; end?: number; text?: string }[] })?.segments
  if (!Array.isArray(segments)) throw new Error(`whisper-server answered without segments: ${JSON.stringify(body).slice(0, 200)}`)
  return segments
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: (s.text ?? '').replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text && !/^[[(].*[\])]$/.test(s.text))
}

export function isModel(path: string): boolean {
  if (!existsSync(path)) return false
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && head.readUInt32LE(0) === GGML_MAGIC
  } finally {
    closeSync(fd)
  }
}

function onPath(bin: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']
  return dirs.filter(Boolean).map((d) => join(d, bin)).find((p) => existsSync(p)) ?? null
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${err.trim()}`))))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

async function download(url: string, dest: string, onProgress: (done: number, total: number | null) => void) {
  const part = `${dest}.part`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Downloading the whisper model failed (HTTP ${res.status}). Download ${url} yourself and put it at ${dest}`)
  const total = Number(res.headers.get('content-length')) || null
  let done = 0
  let last = 0
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  body.on('data', (c: Buffer) => {
    done += c.length
    if (done - last > 8_000_000 || done === total) (last = done, onProgress(done, total))
  })
  try {
    await pipeline(body, createWriteStream(part))
  } catch (e) {
    rmSync(part, { force: true })
    throw e
  }
  if (!isModel(part)) {
    rmSync(part, { force: true })
    throw new Error(`What came from ${url} is not a whisper model (a proxy's page?). Download it yourself and put it at ${dest}`)
  }
  renameSync(part, dest)
}

export function createStt(opts: SttOptions): Stt {
  const model = opts.model ?? MODEL
  const modelPath = join(opts.modelsDir, model.file)
  let ready: Promise<string> | null = null
  let server: ReturnType<typeof spawn> | null = null

  const setup = async (onProgress: (p: SetupProgress) => void): Promise<string> => {
    let bin = opts.server ?? onPath('whisper-server')
    if (!bin) {
      const brew = onPath('brew')
      if (!brew) throw new Error('whisper.cpp is not installed: install Homebrew, then `brew install whisper-cpp`')
      onProgress({ step: 'install' })
      await run(brew, ['install', 'whisper-cpp'])
      bin = onPath('whisper-server')
      if (!bin) throw new Error('`brew install whisper-cpp` did not put whisper-server on PATH')
    }
    if (!isModel(modelPath)) {
      mkdirSync(opts.modelsDir, { recursive: true })
      onProgress({ step: 'model', done: 0, total: null })
      await download(model.url, modelPath, (done, total) => onProgress({ step: 'model', done, total }))
    }
    onProgress({ step: 'load' })
    const port = await freePort()
    const child = spawn(bin, ['-m', modelPath, '-l', 'auto', '-sns', '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
    server = child
    let err = ''
    child.stderr!.on('data', (d) => (err = (err + d).slice(-2000)))
    let exited = false
    child.on('close', () => {
      exited = true
      if (server === child) (server = null, ready = null)
    })
    const url = `http://127.0.0.1:${port}`
    for (const t0 = Date.now(); Date.now() - t0 < 180_000;) {
      if (exited) throw new Error(`whisper-server exited: ${err.trim().split('\n').slice(-3).join(' ')}`)
      try {
        await fetch(url)
        return url
      } catch {
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    child.kill()
    throw new Error('whisper-server did not start in 3 minutes')
  }

  const ensure = (onProgress: (p: SetupProgress) => void = () => {}) => {
    ready ??= setup(onProgress).catch((e) => {
      ready = null
      throw e
    })
    return ready
  }

  return {
    ensureModel: async (onProgress) => void (await ensure(onProgress)),
    async transcribe(pcm) {
      const url = await ensure()
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav(pcm))], { type: 'audio/wav' }), 'chunk.wav')
      form.append('response_format', 'verbose_json')
      form.append('temperature', '0')
      const res = await fetch(`${url}/inference`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`whisper-server failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
      return parseSegments(await res.json())
    },
    close() {
      server?.kill()
      server = null
      ready = null
    },
  }
}
