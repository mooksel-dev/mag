import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampWidth, dragWidth, paneKey, parseWidth, storedWidth } from './paneWidth.ts'

test('clampWidth: 220–480 on the left, 240–640 on the right', () => {
  assert.equal(clampWidth(100, 'left'), 220)
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
  assert.equal(dragWidth('left', 280, -1000), 220)
})

test('storedWidth: a window restores its own topics column width, clamped to 220–480; else the one kept before widths were per window', () => {
  const store = (kv: Record<string, string>) => (k: string) => kv[k] ?? null
  assert.equal(paneKey('left', 'p1'), 'mag.pane.left.p1')
  assert.equal(storedWidth(store({ 'mag.pane.left.p1': '300', 'mag.pane.left': '260' }), 'left', 'p1'), 300)
  assert.equal(storedWidth(store({ 'mag.pane.left.p1': '300' }), 'left', 'p2'), null)
  assert.equal(storedWidth(store({ 'mag.pane.left': '260' }), 'left', 'p2'), 260)
  assert.equal(storedWidth(store({ 'mag.pane.left.p1': '100' }), 'left', 'p1'), 220)
  assert.equal(storedWidth(store({ 'mag.pane.left.p1': '9000' }), 'left', 'p1'), 480)
  // A window reset to the default stores empty: it does not fall back to the old shared width.
  assert.equal(storedWidth(store({ 'mag.pane.left.p1': '', 'mag.pane.left': '260' }), 'left', 'p1'), null)
  assert.equal(storedWidth(store({ 'mag.pane.right': '300' }), 'right'), 300)
})
