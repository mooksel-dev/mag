import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unheardBeforeStop, withUnheard, type ChatItem } from './index.ts'

const user = (text: string): ChatItem => ({ kind: 'user', text, at: 0 })
const stopped: ChatItem = { kind: 'notice', text: 'Stopped', at: 0 }
const result: ChatItem = { kind: 'result', ok: true, at: 0 }
const reply: ChatItem = { kind: 'assistant', text: 'ok', at: 0 }
const tool: ChatItem = { kind: 'tool', id: 't', name: 'Bash', summary: '', at: 0 }

test('unheardBeforeStop: messages of a turn stopped before any reply or tool call; none once answered or sent since', () => {
  assert.deepEqual(unheardBeforeStop([user('a'), reply, result, user('b'), user('c'), stopped, result]), ['b', 'c'])
  assert.deepEqual(unheardBeforeStop([user('a'), tool, stopped, result]), [], 'it called a tool: it had the message')
  assert.deepEqual(unheardBeforeStop([user('a'), reply, stopped, result]), [])
  assert.deepEqual(unheardBeforeStop([user('a'), stopped, result, user('b')]), [], 'a message since: that turn has it')
  assert.deepEqual(unheardBeforeStop([user('a'), reply, result]), [])
})

test('withUnheard: the missed messages quoted before the prompt', () => {
  assert.equal(withUnheard('next', []), 'next')
  assert.equal(withUnheard('next', ['one\ntwo', 'three']), 'Before you were stopped I wrote this, and it may not have reached you:\n> one\n> two\n>\n> three\n\nnext')
})
