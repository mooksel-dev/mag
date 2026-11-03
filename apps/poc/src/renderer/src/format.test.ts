import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crashMarkdown, jobPreview, threadTime } from './format.ts'

test('threadTime: now, minutes and hours today, yesterday, then a date', () => {
  const now = new Date(2026, 9, 28, 15, 0).getTime()
  assert.equal(threadTime(now - 20_000, now), 'now')
  assert.equal(threadTime(now - 5 * 60_000, now), '5m')
  assert.equal(threadTime(new Date(2026, 9, 28, 12, 30).getTime(), now), '2h')
  assert.equal(threadTime(new Date(2026, 9, 27, 23, 0).getTime(), now), 'yesterday')
  assert.equal(threadTime(new Date(2026, 9, 3, 9, 0).getTime(), now), new Date(2026, 9, 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
})

test('crashMarkdown: version, screen, error and stacks; empty sections left out', () => {
  const md = crashMarkdown({ message: 'x is undefined', screen: 'Plan', appVersion: '1.0.0', kind: 'renderer', stack: 'Error: x\n  at Plan', componentStack: '' })
  assert.equal(md, '### mag crash on Plan\n\n- App version: 1.0.0\n- Kind: renderer\n\n**Error:** x is undefined\n\n**Stack**\n```\nError: x\n  at Plan\n```')
})

test('jobPreview: the first non-empty line of a job, cut with an ellipsis', () => {
  assert.equal(jobPreview('\n  \nThe owner of the work answers your question: yes\nmore'), 'The owner of the work answers your question: yes')
  assert.equal(jobPreview(`Review the PR ${'x'.repeat(200)}`, 20), 'Review the PR xxxxxx…')
  assert.equal(jobPreview(''), '')
})
