import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LINK_SERVICES, PR_STATE_COLORS, prNumber, prPillState, prRepo, prTooltip, ticketTooltip } from './linkServices.ts'

const url = 'https://github.com/o/app/pull/34'

test('LINK_SERVICES: every service has a name, an icon and a color', () => {
  for (const s of Object.values(LINK_SERVICES)) {
    assert.ok(s.name)
    assert.match(s.icon, /^M/)
    assert.match(s.color, /^#[0-9a-f]{6}$/)
  }
  assert.deepEqual(Object.keys(PR_STATE_COLORS).sort(), ['closed', 'draft', 'merged', 'open'])
})

test('prPillState: an open draft is draft; a draft flag on a merged PR is ignored', () => {
  assert.equal(prPillState({ prState: 'open' }), 'open')
  assert.equal(prPillState({ prState: 'open', prDraft: true }), 'draft')
  assert.equal(prPillState({ prState: 'merged', prDraft: true }), 'merged')
  assert.equal(prPillState({ prState: 'closed' }), 'closed')
  assert.equal(prPillState({ prState: null }), null)
})

test('prNumber and prRepo from a PR URL', () => {
  assert.equal(prNumber(url), '#34')
  assert.equal(prNumber('https://x/y'), '#?')
  assert.equal(prRepo(url), 'o/app')
  assert.equal(prRepo('https://x/y'), null)
})

test('prTooltip: name, repo and state, URL', () => {
  assert.equal(prTooltip({ prUrl: url, prState: 'open', prDraft: true }), `PR #34\no/app · draft\n${url}\n⌥-click copies the link`)
  assert.match(prTooltip({ prUrl: url, prState: null }), /not checked yet/)
})

test('ticketTooltip: the key when known, the URL', () => {
  assert.equal(ticketTooltip({ url: 'https://x.atlassian.net/browse/ABC-12', key: 'ABC-12' }), 'ABC-12\nhttps://x.atlassian.net/browse/ABC-12\n⌥-click copies the link')
  assert.equal(ticketTooltip({ url: 'https://github.com/o/r/issues/5' }), 'https://github.com/o/r/issues/5\n⌥-click copies the link')
})
