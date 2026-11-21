import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionHeader } from '@mag/core'
import type { Deliverable } from '../../main/core/services/deliverables/types.ts'
import { lineDiff, topicDeliverables } from './deliverableText.ts'

const session = (id: string, parentId: string | null = null) => ({ id, parentId }) as unknown as SessionHeader
const dlv = (id: string, topicId: string | null, updatedAt: number) => ({ id, topicId, updatedAt }) as Deliverable

test('topicDeliverables: those made in the topic or under it, newest first', () => {
  const sessions = [session('t'), session('sub', 't'), session('other')]
  const deliverables = [dlv('a', 't', 1), dlv('b', 'sub', 3), dlv('c', 'other', 2), dlv('d', null, 4)]
  assert.deepEqual(topicDeliverables(sessions[0], { sessions, deliverables }).map((d) => d.id), ['b', 'a'])
  assert.deepEqual(topicDeliverables(sessions[1], { sessions, deliverables }).map((d) => d.id), ['b'])
  assert.deepEqual(topicDeliverables(null, { sessions, deliverables }), [])
})

test('lineDiff: kept, removed and added lines in order', () => {
  assert.deepEqual(lineDiff('# T\na\nb\nc\n', '# T\na\nB\nc\nd\n'), [
    { op: 'same', text: '# T' },
    { op: 'same', text: 'a' },
    { op: 'del', text: 'b' },
    { op: 'add', text: 'B' },
    { op: 'same', text: 'c' },
    { op: 'add', text: 'd' },
  ])
  assert.deepEqual(lineDiff('x', 'x'), [{ op: 'same', text: 'x' }])
  assert.deepEqual(lineDiff('', 'y\n'), [{ op: 'add', text: 'y' }])
})
