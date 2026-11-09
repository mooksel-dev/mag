import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canvasHref, mdSegments, parseCanvasHref } from './markdown.ts'

test('mdSegments: no canvas links is one markdown segment', () => {
  assert.deepEqual(mdSegments('# Hi\n\ntext'), [{ kind: 'md', text: '# Hi\n\ntext' }])
  assert.deepEqual(mdSegments(''), [])
})

test('mdSegments: a canvas link alone on its line is a card, one inside a sentence stays an inline link', () => {
  assert.deepEqual(mdSegments('Intro\n\n[Plan](canvas:c-1)\n\nsee [Map](canvas:c2) here'), [
    { kind: 'md', text: 'Intro\n\n' },
    { kind: 'canvas', id: 'c-1', title: 'Plan' },
    { kind: 'md', text: '\n\nsee [Map](#canvas:c2) here' },
  ])
})

test('mdSegments: a canvas link inside a list item keeps the list whole', () => {
  // The case of the bug: "Data: [A](canvas:bb7efde8)." in a list split into "A" and "." paragraphs.
  assert.deepEqual(mdSegments('- Data: [A](canvas:bb7efde8).\n- [B](canvas:b1)\n- next'), [
    { kind: 'md', text: '- Data: [A](#canvas:bb7efde8).\n- [B](#canvas:b1)\n- next' },
  ])
  assert.deepEqual(mdSegments('1. one\n   [A](canvas:a)\n2. two'), [{ kind: 'md', text: '1. one\n   [A](#canvas:a)\n2. two' }])
  assert.deepEqual(mdSegments('> [A](canvas:a)'), [{ kind: 'md', text: '> [A](#canvas:a)' }])
})

test('mdSegments: a canvas link with text after it on its line stays inline', () => {
  assert.deepEqual(mdSegments('[A](canvas:a) and [B](canvas:b)'), [{ kind: 'md', text: '[A](#canvas:a) and [B](#canvas:b)' }])
  assert.deepEqual(mdSegments('[A](canvas:a).'), [{ kind: 'md', text: '[A](#canvas:a).' }])
  assert.deepEqual(mdSegments('[A](canvas:a) `x`'), [{ kind: 'md', text: '[A](#canvas:a) `x`' }])
})

test('mdSegments: canvas links alone on consecutive lines are cards each', () => {
  assert.deepEqual(mdSegments('Diagrams:\n[A](canvas:a)  \n[B](canvas:b#n1)\ndone'), [
    { kind: 'md', text: 'Diagrams:\n' },
    { kind: 'canvas', id: 'a', title: 'A' },
    { kind: 'canvas', id: 'b', title: 'B', node: 'n1' },
    { kind: 'md', text: '\ndone' },
  ])
})

test('mdSegments: an inline canvas link without a title shows its id; its node goes into the href', () => {
  assert.deepEqual(mdSegments('see [](canvas:c1) and [S](canvas:c1#task-store)'), [
    { kind: 'md', text: 'see [c1](#canvas:c1) and [S](#canvas:c1/task-store)' },
  ])
})

test('mdSegments: the prose rewrite does not touch an inline canvas link', () => {
  const up = (s: string) => s.toUpperCase()
  assert.deepEqual(mdSegments('a [x](canvas:k) b', up), [{ kind: 'md', text: 'A [x](#canvas:k) B' }])
})

test('canvasHref and parseCanvasHref round-trip; other hrefs are not canvas links', () => {
  assert.deepEqual(parseCanvasHref(canvasHref('c-1')), { id: 'c-1' })
  assert.deepEqual(parseCanvasHref(canvasHref('c1', 'a.b:c-d')), { id: 'c1', node: 'a.b:c-d' })
  assert.equal(parseCanvasHref('#task:T-1'), null)
  assert.equal(parseCanvasHref('https://x/#canvas:c1'), null)
})

test('mdSegments: canvas links inside fenced or inline code stay text', () => {
  const text = '```\n[A](canvas:a)\n```\n`[B](canvas:b)` [C](canvas:c)'
  assert.deepEqual(mdSegments(text), [{ kind: 'md', text: '```\n[A](canvas:a)\n```\n`[B](canvas:b)` [C](#canvas:c)' }])
  assert.deepEqual(mdSegments('`x`\n[C](canvas:c)'), [{ kind: 'md', text: '`x`\n' }, { kind: 'canvas', id: 'c', title: 'C' }])
})

test('mdSegments: prose rewrite applies outside code only', () => {
  const up = (s: string) => s.toUpperCase()
  assert.deepEqual(mdSegments('a `b` c\n[x](canvas:k)\nd', up), [
    { kind: 'md', text: 'A `b` C\n' },
    { kind: 'canvas', id: 'k', title: 'x' },
    { kind: 'md', text: '\nD' },
  ])
})

test('mdSegments: a link to a deleted canvas is its title as plain inline text (right-panel-only-what-is.1)', () => {
  const gone = new Set(['a', 'n'])
  assert.deepEqual(mdSegments('see [A](canvas:a) and [B](canvas:b)', undefined, gone), [{ kind: 'md', text: 'see A and [B](#canvas:b)' }])
  // Alone on its line it is no card; the next link on its own line still is.
  assert.deepEqual(mdSegments('[A](canvas:a#node)\n[B](canvas:b)', undefined, gone), [{ kind: 'md', text: 'A\n' }, { kind: 'canvas', id: 'b', title: 'B' }])
  assert.deepEqual(mdSegments('x [](canvas:n) y', undefined, gone), [{ kind: 'md', text: 'x n y' }])
  assert.deepEqual(mdSegments('`[A](canvas:a)`', undefined, gone), [{ kind: 'md', text: '`[A](canvas:a)`' }], 'code stays as written')
})

test('mdSegments: canvas:<id>#<node> links a node of a diagram', () => {
  assert.deepEqual(mdSegments('[Store](canvas:c1#task-store)\n[All](canvas:c1)'), [
    { kind: 'canvas', id: 'c1', title: 'Store', node: 'task-store' },
    { kind: 'canvas', id: 'c1', title: 'All' },
  ])
})
