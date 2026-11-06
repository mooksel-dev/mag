import { test } from 'node:test'
import assert from 'node:assert/strict'
import { popupPlace } from './popupPlace.ts'

const view = { width: 1200, height: 800 }
const popup = { width: 280, height: 160 }

test('popupPlace: below the button, right-aligned, when it fits there', () => {
  assert.deepEqual(popupPlace({ top: 100, bottom: 130, right: 600 }, popup, view), { top: 134, left: 320, maxHeight: 658 })
})

test('popupPlace: above the button when there is no room below (plan card at the bottom of the chat)', () => {
  assert.deepEqual(popupPlace({ top: 700, bottom: 730, right: 600 }, popup, view), { top: 536, left: 320, maxHeight: 688 })
})

test('popupPlace: exactly enough room below still opens below', () => {
  // below = 800 - 8 - (628 + 4) = 160
  assert.equal(popupPlace({ top: 600, bottom: 628, right: 600 }, popup, view).top, 632)
})

test('popupPlace: fits on neither side: the side with more room, kept inside the window', () => {
  const small = { width: 1200, height: 200 }
  // above = 76, below = 200 - 8 - 124 = 68: above wins, the popup is cut to 76 and starts at the margin.
  assert.deepEqual(popupPlace({ top: 88, bottom: 120, right: 600 }, popup, small), { top: 8, left: 320, maxHeight: 76 })
  // above = 28, below = 200 - 8 - 84 = 108: below wins.
  assert.deepEqual(popupPlace({ top: 40, bottom: 80, right: 600 }, popup, small), { top: 84, left: 320, maxHeight: 108 })
})

test('popupPlace: the left edge stays inside the window', () => {
  // A button near the left edge: right-aligned would start at -180.
  assert.equal(popupPlace({ top: 100, bottom: 130, right: 100 }, popup, view).left, 8)
  // A button past the right edge: kept 8px inside.
  assert.equal(popupPlace({ top: 100, bottom: 130, right: 1250 }, popup, view).left, 912)
  // A window narrower than the popup keeps the left edge.
  assert.equal(popupPlace({ top: 100, bottom: 130, right: 250 }, popup, { width: 200, height: 800 }).left, 8)
})
