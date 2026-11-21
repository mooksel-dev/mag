import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coalesce } from './state.ts'

const macrotask = () => new Promise((r) => setImmediate(r))

test('coalesce: any number of calls within one macrotask run once, after it; the next one runs again (p0-fast-safe-store-no.1)', async () => {
  let runs = 0
  const broadcast = coalesce(() => runs++)
  for (let i = 0; i < 50; i++) broadcast()
  assert.equal(runs, 0, 'not within the same tick')
  await macrotask()
  assert.equal(runs, 1)
  broadcast()
  await Promise.resolve()
  broadcast()
  await macrotask()
  assert.equal(runs, 2, 'a microtask is the same macrotask')
})
