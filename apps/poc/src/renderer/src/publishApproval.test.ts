import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishView } from './publishApproval.ts'

test("publishView: a Slack write's card names the channel, is final, previews mrkdwn and carries the broken rules", () => {
  const v = publishView({ kind: 'slack', target: 'data-removal', label: 'Slack #data-removal' }, { channel: 'data-removal', message: 'Hi @olena\n*Ups*' })
  assert.deepEqual(v.dest, { icon: 'hash', service: 'Slack', name: '#data-removal', final: true })
  assert.match(v.html ?? '', /^<div class="slack">Hi @olena<br><b>Ups<\/b><\/div>$/)
  assert.deepEqual(v.rules, [
    { text: 'no blank line before "*Ups*"', met: false },
    { text: 'unresolved @olena', met: false },
    { text: 'under 40,000 characters', met: true },
  ])
})

test('publishView: a write with no text and no named target; an unknown write keeps its label', () => {
  const close = publishView({ kind: 'github', target: '', label: 'GitHub' }, { command: 'gh pr close 4' })
  assert.deepEqual(close.dest, { icon: 'pr', service: 'GitHub', name: 'target not named', final: false })
  assert.equal(close.html, null)
  assert.deepEqual(close.rules, [])
  const other = publishView({ kind: 'other', target: 'Thing', label: 'Thing · mystery' }, {})
  assert.deepEqual(other.dest, { icon: 'send', service: undefined, name: 'Thing · mystery', final: false })
})
