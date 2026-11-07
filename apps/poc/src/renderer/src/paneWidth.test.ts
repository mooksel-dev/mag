import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampWidth, dragWidth, parseWidth } from './paneWidth.ts'

test('clampWidth: 200–480 on the left, 240–640 on the right', () => {
  assert.equal(clampWidth(100, 'left'), 200)
  assert.equal(clampWidth(900, 'left'), 480)
  assert.equal(clampWidth(100, 'right'), 240)
  assert.equal(clampWidth(900, 'right'), 640)
  assert.equal(clampWidth(300.6, 'right'), 301)
})

test('parseWidth: nothing or garbage stored is the default (null); a stored width is clamped', () => {
  assert.equal(parseWidth(null, 'left'), null)
  assert.equal(parseWidth('', 'left'), null)
  assert.equal(parseWidth('wide', 'left'), null)
  assert.equal(parseWidth('320', 'left'), 320)
  assert.equal(parseWidth('5000', 'right'), 640)
})

test('dragWidth: the left pane grows to the right, the right pane to the left, within limits', () => {
  assert.equal(dragWidth('left', 280, 40), 320)
  assert.equal(dragWidth('right', 300, 40), 260)
  assert.equal(dragWidth('right', 300, -1000), 640)
  assert.equal(dragWidth('left', 280, -1000), 200)
})
