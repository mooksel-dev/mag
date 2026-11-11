import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runShell } from './index.ts'

test('runShell: output of both streams as it comes, the exit code, in cwd; stop ends it', async () => {
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/mag-shell-`))
  let out = ''
  const ok = runShell('pwd; echo err >&2; exit 3', dir, (c) => (out += c))
  assert.deepEqual(await ok.done, { code: 3 })
  assert.match(out, new RegExp(`${dir}\\n`))
  assert.match(out, /err/)

  const long = runShell('sleep 30', dir, () => {})
  long.stop()
  const { code } = await long.done
  assert.notEqual(code, 0)
})
