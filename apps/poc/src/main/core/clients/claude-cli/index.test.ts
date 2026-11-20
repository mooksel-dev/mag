import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '@mag/core'
import type { RunSpec } from '@mag/agents'
import { createClaudeCli } from './index.ts'

const fake = (events: AgentEvent[], specs: RunSpec[] = []) => ({
  start: (spec: RunSpec, on: (e: AgentEvent) => void) => {
    specs.push(spec)
    for (const e of events) on(e)
    return { kill: () => {}, done: Promise.resolve() }
  },
})

test('complete: prompt then input, no tools; the reply without subagent chatter', async () => {
  const specs: RunSpec[] = []
  const cli = createClaudeCli({ cwd: '/tmp', adapter: fake([{ type: 'message', text: '## Decisions' }, { type: 'message', text: 'x', parentToolUseId: 't' }, { type: 'message', text: '\n- ship' }, { type: 'turn.done', ok: true }], specs) })
  assert.equal(await cli.complete('Summarize.', 'transcript'), '## Decisions\n- ship')
  assert.equal(specs[0].prompt, 'Summarize.\n\ntranscript')
  assert.equal(specs[0].noTools, true)
  assert.equal(specs[0].model, 'sonnet')
})

test('complete: a failed or empty run rejects', async () => {
  await assert.rejects(createClaudeCli({ cwd: '/tmp', adapter: fake([{ type: 'error', message: 'not logged in' }]) }).complete('p', 'i'), /not logged in/)
  await assert.rejects(createClaudeCli({ cwd: '/tmp', adapter: fake([{ type: 'turn.done', ok: true }]) }).complete('p', 'i'), /answered nothing/)
})
