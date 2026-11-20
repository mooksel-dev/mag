import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventsSinceTurn, withEvents, type ChatItem } from './index.ts'

const notice = (text: string, forAgent = true): ChatItem => ({ kind: 'notice', text, at: 0, forAgent })
const result: ChatItem = { kind: 'result', ok: true, at: 0 }

test("eventsSinceTurn: the works' notices since the agent's last turn, not mag's own lines", () => {
  const items: ChatItem[] = [notice('old'), result, notice('X: the user approved the plan'), notice('Stopped', false), notice('X.1 started: "a"')]
  assert.deepEqual(eventsSinceTurn(items), ['X: the user approved the plan', 'X.1 started: "a"'])
  assert.deepEqual(eventsSinceTurn([notice('a'), result]), [])
})

test('withEvents: a list before the prompt; none leaves it as it is', () => {
  assert.equal(withEvents('go on', []), 'go on')
  assert.equal(withEvents('go on', ['X approved']), 'Since your last turn in mag:\n- X approved\n\ngo on')
})
