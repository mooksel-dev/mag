import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onSomeDisplay } from './bounds.ts'

const main = { x: 0, y: 25, width: 1440, height: 875 }
const right = { x: 1440, y: 0, width: 1920, height: 1080 }

test('bounds inside a display are kept', () => {
  assert.equal(onSomeDisplay({ x: 100, y: 100, width: 800, height: 600 }, [main]), true)
})

test('bounds on a display that is gone are dropped', () => {
  const b = { x: 1600, y: 100, width: 800, height: 600 }
  assert.equal(onSomeDisplay(b, [main, right]), true)
  assert.equal(onSomeDisplay(b, [main]), false)
})

test('a window hanging off the edge is kept while its title strip can be grabbed', () => {
  assert.equal(onSomeDisplay({ x: 1200, y: 100, width: 800, height: 600 }, [main]), true)
  assert.equal(onSomeDisplay({ x: 1400, y: 100, width: 800, height: 600 }, [main]), false)
})

test('a title strip above the work area is dropped', () => {
  assert.equal(onSomeDisplay({ x: 100, y: -500, width: 800, height: 600 }, [main]), false)
})
