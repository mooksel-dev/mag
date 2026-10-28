import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mdSegments } from './markdown.ts'

test('mdSegments: no canvas links is one markdown segment', () => {
  assert.deepEqual(mdSegments('# Hi\n\ntext'), [{ kind: 'md', text: '# Hi\n\ntext' }])
  assert.deepEqual(mdSegments(''), [])
})

test('mdSegments: canvas links split the text, inline ones end the paragraph', () => {
  assert.deepEqual(mdSegments('Intro\n\n[Plan](canvas:c-1)\n\nsee [Map](canvas:c2) here'), [
    { kind: 'md', text: 'Intro\n\n' },
    { kind: 'canvas', id: 'c-1', title: 'Plan' },
    { kind: 'md', text: '\n\nsee ' },
    { kind: 'canvas', id: 'c2', title: 'Map' },
    { kind: 'md', text: ' here' },
  ])
})

test('mdSegments: canvas links inside fenced or inline code stay text', () => {
  const text = '```\n[A](canvas:a)\n```\n`[B](canvas:b)` [C](canvas:c)'
  assert.deepEqual(mdSegments(text), [
    { kind: 'md', text: '```\n[A](canvas:a)\n```\n`[B](canvas:b)` ' },
    { kind: 'canvas', id: 'c', title: 'C' },
  ])
})

test('mdSegments: prose rewrite applies outside code only', () => {
  const up = (s: string) => s.toUpperCase()
  assert.deepEqual(mdSegments('a `b` c [x](canvas:k) d', up), [
    { kind: 'md', text: 'A `b` C ' },
    { kind: 'canvas', id: 'k', title: 'x' },
    { kind: 'md', text: ' D' },
  ])
})
