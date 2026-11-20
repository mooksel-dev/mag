import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStt, isModel, parseSegments, wav, type SetupProgress } from './index.ts'

const MODEL_BYTES = Buffer.concat([Buffer.from([0x6c, 0x6d, 0x67, 0x67]), Buffer.alloc(100)])

/** A whisper-server stand-in: answers /inference with the WAV's size, so the test sees what was sent. */
function fakeServer(dir: string): string {
  const path = join(dir, 'whisper-server')
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
if (!require('fs').existsSync(args[args.indexOf('-m') + 1]) || args[args.indexOf('-l') + 1] !== 'auto') process.exit(2)
require('http').createServer((req, res) => {
  let n = 0
  req.on('data', (c) => (n += c.length))
  req.on('end', () => {
    if (req.url !== '/inference') return res.end('ok')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ segments: [{ start: 0.5, end: 1, text: ' bytes ' + n + ' ' }, { start: 1, end: 2, text: ' [BLANK_AUDIO]' }] }))
  })
}).listen(port, '127.0.0.1')
`)
  chmodSync(path, 0o755)
  return path
}

async function serve(body: Buffer, status = 200) {
  const server = createServer((_, res) => res.writeHead(status, { 'content-length': body.length }).end(body))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/m.bin`, close: () => server.close() }
}

test('wav: 16 kHz mono 16-bit header, samples clipped', () => {
  const b = wav(new Float32Array([0, 1, -2]))
  assert.equal(b.toString('ascii', 0, 4), 'RIFF')
  assert.equal(b.readUInt32LE(24), 16_000)
  assert.equal(b.readUInt32LE(40), 6)
  assert.deepEqual([b.readInt16LE(44), b.readInt16LE(46), b.readInt16LE(48)], [0, 32767, -32767])
})

test('parseSegments: trimmed text, markers dropped; an answer without segments is an error', () => {
  assert.deepEqual(parseSegments({ segments: [{ start: 1, end: 2, text: '  Добрий   день ' }, { start: 2, end: 3, text: '(music)' }, { text: '' }] }), [{ start: 1, end: 2, text: 'Добрий день' }])
  assert.throws(() => parseSegments({ error: 'failed to read audio' }), /without segments.*failed to read audio/)
})

test('first use downloads the model with progress, starts the server once and transcribes in memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-stt-'))
  const model = await serve(MODEL_BYTES)
  const stt = createStt({ modelsDir: join(dir, 'models'), server: fakeServer(dir), model: { file: 'm.bin', url: model.url } })
  try {
    const progress: SetupProgress[] = []
    await Promise.all([stt.ensureModel((p) => progress.push(p)), stt.ensureModel()])
    assert.ok(isModel(join(dir, 'models', 'm.bin')))
    assert.deepEqual(progress.map((p) => p.step), ['model', 'model', 'load'])
    assert.deepEqual(progress[1], { step: 'model', done: MODEL_BYTES.length, total: MODEL_BYTES.length })
    const segments = await stt.transcribe(new Float32Array(16_000))
    assert.equal(segments.length, 1)
    assert.match(segments[0].text, /^bytes \d+$/)
    assert.ok(Number(segments[0].text.split(' ')[1]) > 32_044)
    assert.equal(segments[0].start, 0.5)
  } finally {
    stt.close()
    model.close()
  }
})

test("a download that is not a model (a proxy's page, an HTTP error) fails with where to put it, and leaves nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-stt-'))
  const page = await serve(Buffer.from('<html>blocked</html>'))
  const denied = await serve(Buffer.from('no'), 403)
  try {
    const dest = join(dir, 'm.bin')
    await assert.rejects(createStt({ modelsDir: dir, server: fakeServer(dir), model: { file: 'm.bin', url: page.url } }).ensureModel(), new RegExp(`not a whisper model.*${dest}`))
    await assert.rejects(createStt({ modelsDir: dir, server: fakeServer(dir), model: { file: 'm.bin', url: denied.url } }).ensureModel(), /HTTP 403/)
    assert.equal(existsSync(dest) || existsSync(`${dest}.part`), false)
  } finally {
    page.close()
    denied.close()
  }
})
