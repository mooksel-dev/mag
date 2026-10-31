import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDiagram, type SequenceDiagram } from '@mag/core'
import { BAR, layoutSequence } from './sequenceLayout.ts'

const seq = (participants: unknown[], messages: unknown[]) => normalizeDiagram({ type: 'sequence', participants, messages }) as SequenceDiagram

test('layoutSequence: columns left to right, rows top down, arrows end at the bars', () => {
  const l = layoutSequence(
    seq(
      [{ id: 'ui', label: 'Renderer' }, { id: 'main', label: 'Main process' }, { id: 'db', label: 'db.json', kind: 'file' }],
      [
        { from: 'ui', to: 'main', text: 'saveCanvas(c)', kind: 'call' },
        { from: 'main', to: 'db', text: 'write', kind: 'async' },
        { from: 'main', to: 'ui', text: 'ok', kind: 'reply' },
      ],
    ),
  )
  const [ui, main, db] = l.participants
  assert.ok(ui.x < main.x && main.x < db.x)
  assert.ok(l.messages[0].y1 < l.messages[1].y1 && l.messages[1].y1 < l.messages[2].y1)
  // The call arrives at the left side of the new bar on main; the reply leaves from it.
  assert.equal(l.messages[0].x2, main.x - BAR / 2)
  assert.equal(l.messages[2].x1, main.x - BAR / 2)
  assert.equal(l.messages[2].x2, ui.x)
  // The async message leaves the bar on main and hits db's bare lifeline.
  assert.equal(l.messages[1].x1, main.x + BAR / 2)
  assert.equal(l.messages[1].x2, db.x)
  const [bar] = l.bars
  assert.equal(l.bars.length, 1)
  assert.equal(bar.y, l.messages[0].y1)
  assert.equal(bar.y + bar.h, l.messages[2].y1)
  assert.ok(l.w >= db.x + db.w / 2 && l.h > l.messages[2].y1)
})

test('layoutSequence: long labels widen the gap; a message to itself loops and stacks a bar', () => {
  const short = layoutSequence(seq([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b', text: 'x', kind: 'async' }]))
  const long = layoutSequence(seq([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'b', text: 'a rather long message label here', kind: 'async' }]))
  assert.ok(long.participants[1].x - long.participants[0].x > short.participants[1].x - short.participants[0].x)

  const self = layoutSequence(
    seq(
      [{ id: 'a' }, { id: 'b' }],
      [
        { from: 'a', to: 'b', text: 'run', kind: 'call' },
        { from: 'b', to: 'b', text: 'check', kind: 'call' },
      ],
    ),
  )
  const loop = self.messages[1]
  assert.ok(loop.y2 > loop.y1)
  assert.equal(self.bars[1].depth, 1)
  assert.ok(self.bars[1].x > self.bars[0].x)
  assert.equal(self.bars[1].y, loop.y2)
  // Unanswered calls run to the bottom.
  assert.ok(self.bars[0].y + self.bars[0].h > loop.y2)
})

test('layoutSequence: messages to unknown participants are dropped, numbering keeps the input order', () => {
  const l = layoutSequence(
    seq([{ id: 'a' }, { id: 'b' }], [{ from: 'a', to: 'zz', text: 'lost', kind: 'call' }, { from: 'a', to: 'b', text: 'go', kind: 'call' }]),
  )
  assert.equal(l.messages.length, 1)
  assert.deepEqual(l.messages[0].label.lines, ['2. go'])
  assert.equal(l.bars[0].from, 0)
})
