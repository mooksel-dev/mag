import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventsSinceTurn, withEvents, type ChatItem } from './index.ts'

const notice = (text: string, forAgent = true): ChatItem => ({ kind: 'notice', text, at: 0, forAgent })
const user: ChatItem = { kind: 'user', text: 'hi', at: 0 }
const result: ChatItem = { kind: 'result', ok: true, at: 0 }

test("eventsSinceTurn: the notices for the agent since its last message, during that turn too; not mag's own lines", () => {
  const items: ChatItem[] = [notice('old'), user, notice('during'), result, notice('X: the user approved the plan'), notice('Stopped', false), notice('X.1 started: "a"')]
  assert.deepEqual(eventsSinceTurn(items), ['during', 'X: the user approved the plan', 'X.1 started: "a"'])
  assert.deepEqual(eventsSinceTurn([notice('a'), user, result]), [])
})

test('eventsSinceTurn: a notice with agentText gives the agent that text', () => {
  const ran: ChatItem = { kind: 'notice', text: 'You ran `ls`: done', at: 0, forAgent: true, agentText: 'The user ran ls: a b' }
  assert.deepEqual(eventsSinceTurn([user, result, ran]), ['The user ran ls: a b'])
})

test('withEvents: a list before the prompt; none leaves it as it is', () => {
  assert.equal(withEvents('go on', []), 'go on')
  assert.equal(withEvents('go on', ['X approved']), 'Since your last turn in mag:\n- X approved\n\ngo on')
})
