import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameReader, openCapture, type Channel } from './index.ts'

const frame = (channel: number, samples: number[]) => {
  const b = Buffer.alloc(5 + samples.length * 4)
  b[0] = channel
  b.writeUInt32LE(samples.length, 1)
  samples.forEach((s, i) => b.writeFloatLE(s, 5 + i * 4))
  return b
}

/** A mag-audio stand-in: `script` runs after the ready event; it ends on stdin's end. */
function fakeHelper(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mag-audio-'))
  const path = join(dir, 'mag-audio')
  writeFileSync(path, `#!/usr/bin/env node
const frame = ${frame.toString()}
${script}
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`)
  chmodSync(path, 0o755)
  return path
}

test('FrameReader: frames split across reads; offsets counted per channel', () => {
  const got: [Channel, number, number[]][] = []
  const r = new FrameReader((pcm, ch, at) => got.push([ch, at, [...pcm]]))
  const all = Buffer.concat([frame(0, [0.5, -0.5]), frame(1, [0.25]), frame(0, [1])])
  r.push(all.subarray(0, 7))
  r.push(all.subarray(7))
  assert.deepEqual(got, [['me', 0, [0.5, -0.5]], ['others', 0, [0.25]], ['me', 2 / 16_000, [1]]])
  assert.throws(() => r.push(frame(2, [])), /channel 2/)
})

test('openCapture: resolves on ready, streams chunks, close ends the helper', async () => {
  const helper = fakeHelper(`
process.stderr.write(JSON.stringify({ event: 'ready' }) + '\\n')
process.stdout.write(Buffer.concat([frame(0, [0.5]), frame(1, [0.25])]))`)
  const got: Channel[] = []
  const capture = await openCapture(helper, (_, ch) => got.push(ch))
  await new Promise((r) => setTimeout(r, 100))
  await capture.close()
  assert.deepEqual(got, ['me', 'others'])
  assert.equal(await capture.ended, null)
})

test("openCapture: the helper's error rejects the start; a missing helper says how to build it", async () => {
  const helper = fakeHelper(`
process.stderr.write(JSON.stringify({ event: 'error', message: 'microphone access denied' }) + '\\n')
process.exit(1)`)
  await assert.rejects(openCapture(helper, () => {}), /microphone access denied/)
  await assert.rejects(openCapture('/nope/mag-audio', () => {}), /build:audio/)
})

test('openCapture: a permission prompt nobody answers ends the start', async () => {
  await assert.rejects(openCapture(fakeHelper(''), () => {}, 100), /did not let mag-audio record/)
})

test('openCapture: a helper that dies while recording ends with its reason', async () => {
  const helper = fakeHelper(`
process.stderr.write(JSON.stringify({ event: 'ready' }) + '\\n')
setTimeout(() => { process.stderr.write(JSON.stringify({ event: 'error', message: 'device lost' }) + '\\n'); process.exit(1) }, 50)`)
  const capture = await openCapture(helper, () => {})
  assert.equal(await capture.ended, 'device lost')
})
