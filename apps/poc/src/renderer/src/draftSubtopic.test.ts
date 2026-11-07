import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSession, Attachment } from '@mag/core'
import { startSubtopic, type SubtopicApi } from './draftSubtopic.ts'

/** A fake mag that records its calls in order. */
function fake(failSend = false) {
  const calls: unknown[][] = []
  const api: SubtopicApi = {
    startChild: async (...a) => { calls.push(['startChild', ...a]); return { id: 'kid' } as AgentSession },
    renameChat: async (...a) => { calls.push(['renameChat', ...a]) },
    send: async (...a) => { calls.push(['send', ...a]); if (failSend) throw new Error('offline') },
    deleteChat: async (...a) => { calls.push(['deleteChat', ...a]) },
  }
  return { api, calls }
}

const file: Attachment = { name: 'shot.png', path: '/tmp/shot.png', mime: 'image/png' }

test('startSubtopic: the first message starts the subtopic under its parent, with that message; nothing before it', async () => {
  const { api, calls } = fake()
  assert.deepEqual(calls, [], 'a draft calls nothing until its first message')
  const kid = await startSubtopic(api, 'topic', 'Why is login slow?', [], [])
  assert.equal(kid.id, 'kid')
  assert.deepEqual(calls, [['startChild', 'topic', 'Why is login slow?', null, false]], 'a general session, not a fork, its brief the message')
})

test('startSubtopic: with files or references it starts empty, takes the first line as its title and sends them with the message', async () => {
  const { api, calls } = fake()
  const refs = [{ kind: 'task' as const, id: 'w1' }]
  await startSubtopic(api, 'topic', '\nLook at this\nand this', [file], refs)
  assert.deepEqual(calls, [
    ['startChild', 'topic', '', null, false],
    ['renameChat', 'kid', 'Look at this'],
    ['send', 'kid', '\nLook at this\nand this', [file], refs],
  ])
  // Only a file: named after it.
  const only = fake()
  await startSubtopic(only.api, 'topic', '', [file], [])
  assert.deepEqual(only.calls[1], ['renameChat', 'kid', 'shot.png'])
})

test('startSubtopic: a send that fails deletes the empty subtopic it started, and the error reaches the draft', async () => {
  const { api, calls } = fake(true)
  await assert.rejects(startSubtopic(api, 'topic', 'Look', [file], []), /offline/)
  assert.deepEqual(calls.map((c) => c[0]), ['startChild', 'renameChat', 'send', 'deleteChat'])
  assert.deepEqual(calls[3], ['deleteChat', 'kid'])
})
