import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatItem, SessionItemEvent } from '@mag/core'
import { createItemsCache } from './sessionItems.ts'

const item = (text: string): ChatItem => ({ kind: 'notice', text, at: 0 })

function setup() {
  let send: (e: SessionItemEvent) => void = () => {}
  const loads: { sid: string; done: (items: ChatItem[]) => void }[] = []
  const cache = createItemsCache(
    (sid) => new Promise((done) => loads.push({ sid, done })),
    (cb) => void (send = cb),
  )
  return { cache, loads, send: (e: SessionItemEvent) => send(e) }
}

const flush = () => new Promise((r) => setImmediate(r))

test('items cache: loads once per session watched, applies events that came while loading, then follows them (p0-fast-safe-store-no.1)', async () => {
  const { cache, loads, send } = setup()
  let calls = 0
  const stopA = cache.watch('s', () => calls++)
  const stopB = cache.watch('s', () => calls++)
  assert.equal(loads.length, 1)
  assert.equal(cache.get('s'), undefined)
  send({ sid: 's', n: 1, item: item('b') })
  send({ sid: 'other', n: 0, item: item('x') })
  loads[0].done([item('a')])
  await flush()
  assert.deepEqual(cache.get('s'), [item('a'), item('b')])
  assert.equal(calls, 2)

  send({ sid: 's', n: 0, item: item('A') })
  send({ sid: 's', truncate: 1 })
  assert.deepEqual(cache.get('s'), [item('A')])
  stopA()
  send({ sid: 's', n: 1, item: item('c') })
  assert.deepEqual(cache.get('s'), [item('A'), item('c')], 'still watched by the other')
  stopB()
  assert.equal(cache.get('s'), undefined, 'dropped when nothing shows it')
  cache.watch('s', () => {})
  assert.equal(loads.length, 2, 'loaded again when shown again')
})

test('items cache: a load that answers after the session stopped being shown is ignored (p0-fast-safe-store-no.1)', async () => {
  const { cache, loads } = setup()
  const stop = cache.watch('s', () => {})
  stop()
  cache.watch('s', () => {})
  loads[0].done([item('stale')])
  await flush()
  assert.equal(cache.get('s'), undefined)
  loads[1].done([item('fresh')])
  await flush()
  assert.deepEqual(cache.get('s'), [item('fresh')])
})
