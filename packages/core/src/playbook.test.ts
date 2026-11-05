import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODE_CHECKS, DEFAULT_PLAYBOOK, DEFAULT_TEMPLATES, DEVELOPER_BAR, PRECEDENCE, contextBlocks, docDecisions, playbookOf, storedPlaybook } from './index.ts'

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

test('stance: an editable section like the others; the plan asks for a recommendation and weighs answers (ahent-vede-robotu-vlasna-pozytsiia.1)', () => {
  assert.equal(playbookOf({ playbook: { stance: 'agree softly' } }).stance, 'agree softly')
  assert.equal(playbookOf({ playbook: { stance: ' ' } }).stance, DEFAULT_PLAYBOOK.stance)
  assert.deepEqual(storedPlaybook({ ...DEFAULT_PLAYBOOK, stance: 'ours' }), { stance: 'ours' })
  assert.match(DEFAULT_PLAYBOOK.stance, /next move/)
  assert.match(DEFAULT_PLAYBOOK.stance, /skeptic/)
  assert.match(DEFAULT_PLAYBOOK.plan, /each with your recommendation and why/)
  assert.match(DEFAULT_PLAYBOOK.plan, /weigh the answer first/)
  for (const template of Object.values(DEFAULT_TEMPLATES)) assert.match(template, /# Open questions\n.*your recommendation and why/)
})

test('docDecisions: the Decisions section, with the given step\'s subsection only', () => {
  const doc = '# Problem\np\n\n# Decisions\n- draft PRs\n## T-5.1\n- only core\n## T-5.2\n- old API\n## Notes\n- kept\n\n# Plan\n1. x'
  assert.equal(docDecisions(doc), '- draft PRs\n## T-5.1\n- only core\n## T-5.2\n- old API\n## Notes\n- kept')
  assert.equal(docDecisions(doc, 'T-5.1'), '- draft PRs\n## T-5.1\n- only core\n## Notes\n- kept')
  assert.equal(docDecisions(doc, 't-5.2'), '- draft PRs\n## T-5.2\n- old API\n## Notes\n- kept')
  const keyed = '# Decisions\n- all\n## ABC-12.1\n- one\n## ABC-12.2\n- two\n## v1.2\n- kept'
  assert.equal(docDecisions(keyed, 'abc-12.2'), '- all\n## ABC-12.2\n- two\n## v1.2\n- kept', 'any work key (T-55.7); a heading of another shape stays')
  assert.equal(docDecisions('# Decisions\n## fix-login.1\n- one\n## fix-login.2\n- two', 'fix-login.1'), '## fix-login.1\n- one')
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

test('DEFAULT_PLAYBOOK: both reviews check the contract of calls, unique indexes under upserts, values read but unused (povnyi-diff-nabir-pov-iazanykh.3)', () => {
  for (const s of [DEFAULT_PLAYBOOK.review, DEFAULT_PLAYBOOK.prReview]) {
    assert.match(s, /contract of every new or changed call/)
    assert.match(s, /upsert, ensure or "create if missing" rests on a unique index/)
    assert.match(s, /Read but unused/)
  }
  assert.match(DEFAULT_PLAYBOOK.fact, /set_inventory/)
  assert.match(DEFAULT_PLAYBOOK.fact, /public and private/)
  assert.match(DEFAULT_PLAYBOOK.fact, /Mocks, fakes and test helpers are\s+never units/)
  assert.match(DEFAULT_PLAYBOOK.plan, /each entity with module, its owner/)
})

test('DEFAULT_PLAYBOOK: reviews answer the report; the verdict is the reviewer\'s over mag\'s floor, its leaning on direction has its own field (prompts-use-the-models-to.1)', () => {
  for (const s of [DEFAULT_PLAYBOOK.review, DEFAULT_PLAYBOOK.prReview]) {
    assert.match(s, /every item is a claim: text, source and cites/)
    assert.match(s, /changes: the inventory grouped into changes by importance/)
    assert.match(s, /checks: \{ verdict, why \}: your judgment[\s\S]*direction never counts/)
    assert.match(s, /mag keeps its own floor[\s\S]*attaches those blockers itself/)
    assert.match(s, /view\s+\{ leaning, why, confidence \}/)
    assert.match(s, /never give\s+it/)
    // No forced counts and no label-to-verdict mapping.
    assert.doesNotMatch(s, /2–4|2–6|request_changes with a failed rule/)
  }
  const p = DEFAULT_PLAYBOOK.prReview
  assert.match(p, /user's call: prepare it, never decide it/)
  assert.match(p, /your own leaning, if you have one, goes in direction.view/)
  // Options from the inventory first, the author's description only after.
  assert.ok(p.indexOf('set_inventory') < p.indexOf('Direction, before you read'))
  assert.ok(p.indexOf('Direction, before you read') < p.indexOf('gh pr view <url>'))
  assert.match(DEFAULT_PLAYBOOK.review, /Direction is the approved plan/)
})

test('prReviewV1: the v1 review text is its own section, editable like the others (review-v2-part-2-v1-2.1)', () => {
  assert.match(DEFAULT_PLAYBOOK.prReviewV1, /Findings with set_pr_review, each with level/)
  assert.match(DEFAULT_PLAYBOOK.prReviewV1, /Verdict: request_changes with any blocker/)
  assert.doesNotMatch(DEFAULT_PLAYBOOK.prReviewV1, /decide_direction/)
  assert.match(DEFAULT_PLAYBOOK.prReview, /decide_direction/)
  assert.equal(playbookOf({ playbook: { prReviewV1: 'ours' } }).prReviewV1, 'ours')
  assert.deepEqual(storedPlaybook({ ...DEFAULT_PLAYBOOK, prReviewV1: 'ours' }), { prReviewV1: 'ours' })
})

test('developer bar: the reviewer\'s code checks from the same constant, the deviation rule and the quality bar (prompts-use-the-models-to.3)', () => {
  assert.ok(DEVELOPER_BAR.includes(CODE_CHECKS))
  assert.ok(DEFAULT_PLAYBOOK.review.includes(CODE_CHECKS) && DEFAULT_PLAYBOOK.prReview.includes(CODE_CHECKS), 'the same checks the reviews apply')
  assert.match(DEVELOPER_BAR, /State\s+each deviation and why in §Progress and in the PR body/)
  assert.match(DEVELOPER_BAR, /correct for every valid input/)
  assert.match(DEVELOPER_BAR, /Never weaken, skip or delete a test/)
  assert.match(DEVELOPER_BAR, /Done means[\s\S]*acceptance/)
  assert.doesNotMatch(DEVELOPER_BAR, /\b[A-Z]{4,}\b/, 'no ALL-CAPS emphasis')
})
