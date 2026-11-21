import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noEvidenceNote, rulesSummary, ruleTone } from './ui/publish.ts'

test('rulesSummary counts the checked rules: green when all are met, red when one is broken, none when unchecked', () => {
  assert.deepEqual(rulesSummary([{ text: 'a', met: true }, { text: 'b', met: true }]), { text: '2 / 2 met', tone: 'green' })
  assert.deepEqual(rulesSummary([{ text: 'a', met: true }, { text: 'b', met: false }, { text: 'c' }]), { text: '1 / 2 met', tone: 'red' })
  assert.equal(rulesSummary([{ text: 'a' }]), null)
  assert.equal(rulesSummary([]), null)
})

test('a broken rule is red; a met or unchecked one stays grey', () => {
  assert.equal(ruleTone({ text: 'a', met: false }), 'red')
  assert.equal(ruleTone({ text: 'a', met: true }), 'grey')
  assert.equal(ruleTone({ text: 'a' }), 'grey')
})

test('a claim without evidence says why on hover', () => {
  assert.equal(noEvidenceNote('unverified'), 'No source: unverified.')
  assert.equal(noEvidenceNote('verified'), 'No source given.')
})
