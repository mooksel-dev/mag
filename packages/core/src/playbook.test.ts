import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PLAYBOOK, DEFAULT_TEMPLATES, PRECEDENCE, contextBlocks, docDecisions, playbookOf, storedPlaybook } from './index.ts'

test('playbookOf: own sections win, empty or missing ones and bad rounds fall back to the default', () => {
  assert.deepEqual(playbookOf({}), DEFAULT_PLAYBOOK)
  assert.deepEqual(playbookOf({ playbook: null }), DEFAULT_PLAYBOOK)
  const p = playbookOf({ playbook: { step: 'ours', review: '  ', reviewRounds: 0 } })
  assert.deepEqual(p, { ...DEFAULT_PLAYBOOK, step: 'ours', reviewRounds: 0 })
  assert.equal(playbookOf({ playbook: { reviewRounds: -1 } }).reviewRounds, DEFAULT_PLAYBOOK.reviewRounds)
  assert.equal(playbookOf({ playbook: { reviewRounds: 1.5 } }).reviewRounds, DEFAULT_PLAYBOOK.reviewRounds)
})

test('storedPlaybook: keeps only what differs from the default; null when nothing does', () => {
  assert.equal(storedPlaybook(DEFAULT_PLAYBOOK), null)
  assert.equal(storedPlaybook({ ...DEFAULT_PLAYBOOK, plan: '' }), null)
  assert.deepEqual(storedPlaybook({ ...DEFAULT_PLAYBOOK, plan: 'ours', reviewRounds: 3 }), { plan: 'ours', reviewRounds: 3 })
})

test('docDecisions: the Decisions section, with the given step\'s subsection only', () => {
  const doc = '# Problem\np\n\n# Decisions\n- draft PRs\n## T-5.1\n- only core\n## T-5.2\n- old API\n## Notes\n- kept\n\n# Plan\n1. x'
  assert.equal(docDecisions(doc), '- draft PRs\n## T-5.1\n- only core\n## T-5.2\n- old API\n## Notes\n- kept')
  assert.equal(docDecisions(doc, 'T-5.1'), '- draft PRs\n## T-5.1\n- only core\n## Notes\n- kept')
  assert.equal(docDecisions(doc, 't-5.2'), '- draft PRs\n## T-5.2\n- old API\n## Notes\n- kept')
  assert.equal(docDecisions('# Problem\np'), '')
  assert.equal(docDecisions('# Рішення\n1. Опція A\n\n# Plan'), '1. Опція A')
  assert.equal(docDecisions('# Decisions\n```\n# not a heading\n```\n- a\n# Plan'), '```\n# not a heading\n```\n- a')
})

test('contextBlocks: decisions with the precedence, then the notes; empty parts left out', () => {
  assert.equal(contextBlocks({}), '')
  assert.equal(contextBlocks({ notes: ' n ' }), '## Project notes\nn')
  assert.equal(contextBlocks({ decisions: '- a', notes: 'n' }), `## Decisions\n- a\n${PRECEDENCE}\n\n## Project notes\nn`)
  assert.match(contextBlocks({ decisions: '' }), /^## Decisions\n\(none recorded yet/)
})

test('the dev template has a Decisions section that docDecisions reads', () => {
  assert.match(docDecisions(DEFAULT_TEMPLATES.dev), /override the project's playbook/)
})
