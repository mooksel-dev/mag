import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionHeader } from '@mag/core'
import type { Claim, Deliverable, VersionVerdict } from '../../main/core/services/deliverables/types.ts'
import { claimFails, lineDiff, markClaims, placeClaims, plainSpan, topicDeliverables } from './deliverableText.ts'

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

const claim = (id: string, text: string, over: Partial<Claim> = {}): Claim => ({ id, text, kind: 'fact', refs: ['o/r#1'], query: null, person: null, check: 'ok', why: null, ...over })

test('placeClaims: the first span outside code; changed, cross-paragraph and overlapping spans are not placed', () => {
  const md = '```\n34 PRs\n```\nWe merged 34 PRs.\n\nNext para.'
  const r = placeClaims(md, [claim('a', '34 PRs'), claim('b', 'merged 34'), claim('c', 'gone'), claim('d', 'PRs.\n\nNext')])
  assert.equal(r.md, '```\n34 PRs\n```\nWe merged \u20630\u2063.\n\nNext para.')
  assert.deepEqual(r.unplaced.map((c) => c.id), ['b', 'c', 'd'])
})

test('markClaims: underlined with its evidence, red when mag\'s check or a verifier blocker fails it; hover text is inert', () => {
  const verdict: VersionVerdict = { verdict: 'changes', findings: [{ claimId: 'b', text: 'Counts 31', level: 'blocker' }], verifierSessionId: 's', fresh: false, at: 1 }
  const claims = [claim('a', '**34 PRs**', { kind: 'count', query: 'gh pr list | wc -l', refs: ['https://x.io/a_b*c*'] }), claim('b', 'the queue'), claim('c', 'faster', { refs: [], check: 'missing_ref', why: 'No refs.' })]
  const { md, unplaced } = markClaims('We merged **34 PRs**; the queue is faster.', claims, verdict)
  assert.deepEqual(unplaced, [])
  assert.match(md, /^We merged <span class="claimhl" tabindex="0" data-claim="a">\*\*34 PRs\*\*<span class="claimpop"/)
  assert.match(md, /<b>https&#58;&#47;&#47;x&#46;io&#47;a&#95;b&#42;c&#42;<\/b>/)
  assert.match(md, /<code>gh pr list &#124; wc &#45;l<\/code>/)
  assert.match(md, /<span class="claimhl bad" tabindex="0" data-claim="b">the queue.*Verifier&#58; Counts 31/)
  assert.match(md, /<span class="claimhl bad" tabindex="0" data-claim="c">faster.*missing ref&#58; No refs&#46;.*No source given\./)
  assert.equal(claimFails(claims[1], { ...verdict, findings: [{ claimId: 'b', text: 'x', level: 'nit' }] }), false)
  assert.equal(plainSpan('**34** [PRs](http://x) `y`'), '34 PRs y')
})
