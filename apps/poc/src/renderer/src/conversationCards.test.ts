import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatItem, StepFact } from '@mag/core'
import { MAX_ROWS, factCard, foldEvents, integrationCard, mergeCard, stepLabel } from './conversationCards.ts'

const step = { id: 's3', key: 'review-v2.3', title: 'Archive' }
const counts = (c: Partial<StepFact['counts']>): StepFact['counts'] => ({ match: 0, differs: 0, missing: 0, unplanned: 0, unaccounted: 0, ungrounded: 0, ...c })
const pr = (n: number, more: object = {}) => ({ prUrl: `https://github.com/o/r/pull/${n}`, prState: 'open' as const, ...more })

test('stepLabel: the step number of a key, else the key', () => {
  assert.equal(stepLabel({ key: 'abc-12.3' }), 'Step 3')
  assert.equal(stepLabel({ key: 'ABC-12' }), 'ABC-12')
})

test('mergeCard: title, verdict chip, PR health, plan ↔ fact and findings as tagged rows, minor notes folded; no raw threshold text', () => {
  const card = mergeCard({
    step,
    review: { verdict: 'look', withContext: true, findings: [{ text: 'Export a real review and import it here', level: 'should_fix' }, { text: 'naming', where: 'a.ts:3', level: 'nit' }] },
    fact: { counts: counts({ match: 33, differs: 1 }), canvasId: 'c1' },
    look: true,
    prs: [pr(91, { ci: 'pass', mergeable: 'clean' })],
  })
  assert.equal(card.title, 'Step 3 · Archive — look before merging')
  assert.deepEqual(card.verdict, { label: 'look', tone: 'warn' })
  assert.equal(card.tone, 'warn')
  assert.deepEqual(card.stats, ['CI passes', 'merges cleanly'])
  assert.deepEqual(card.rows, [
    { tag: 'otherwise', text: '1 plan change done otherwise' },
    { tag: 'as planned', text: '33 plan changes done as planned' },
    { tag: 'check by hand', lead: undefined, text: 'Export a real review and import it here' },
  ])
  assert.deepEqual(card.details, [{ summary: '1 minor note from the agent review', lines: ['a.ts:3 — naming'] }])
  assert.deepEqual(card.buttons.map((b) => [b.kind, b.label]), [['open_pr', 'Open PR ↗'], ['fact', 'Plan ↔ fact'], ['review_window', 'Open review window']])
  assert.ok(![card.title, ...card.rows.map((r) => r.text)].some((t) => /look before merge:|deviation/.test(t)))
})

test('mergeCard: over five rows keeps the heaviest in order, the rest fold; several PRs are named; changes and merge verdicts', () => {
  const findings = Array.from({ length: 6 }, (_, i) => ({ text: `f${i}`, level: i === 5 ? ('blocker' as const) : ('question' as const) }))
  const card = mergeCard({ step, review: { verdict: 'changes', withContext: false, findings }, fact: { counts: counts({ match: 2 }), canvasId: null }, look: true, prs: [pr(1, { ci: 'fail' }), pr(2, { mergeable: 'conflict' })] })
  assert.equal(card.title, 'Step 3 · Archive — changes asked')
  assert.deepEqual([card.tone, card.verdict?.tone], ['bad', 'bad'])
  assert.equal(card.rows.length, MAX_ROWS)
  assert.deepEqual(card.rows.map((r) => r.text), ['f0', 'f1', 'f2', 'f3', 'f5'], 'the blocker stays, the plain match and the last question fold')
  assert.deepEqual(card.details, [{ summary: '2 more', lines: ['as planned: 2 plan changes done as planned', 'check by hand: f4'] }])
  assert.deepEqual(card.stats, ['PR #1: CI fails', 'PR #2: conflicts with base'])
  assert.deepEqual(card.buttons.map((b) => b.label), ['PR #1 ↗', 'PR #2 ↗', 'Open review window'])

  const merge = mergeCard({ step: null, review: { verdict: 'merge', withContext: true, findings: [] }, look: false, prs: [pr(5)] })
  assert.deepEqual([merge.title, merge.tone, merge.verdict?.label], ['Ready to merge', 'good', 'merge'])
  assert.deepEqual(merge.rows, [{ text: 'Owner review found nothing to check' }])
  assert.equal(mergeCard({ step, look: false, prs: [] }).verdict, null)
})

const item = (status: 'match' | 'differs' | 'missing' | 'unplanned', phrase: string) => ({ status, phrase }) as never

test('factCard: deviations tagged, what the inventory leaves out to check by hand, the rest folded', () => {
  const view = {
    items: [item('differs', 'orchestrator: setPrReview has another signature than planned'), item('missing', 'store: sessions.reviewFormat is planned, not done'), item('unplanned', 'new entity LegacyPrReview'), item('match', 'a is done as planned')],
    additions: [{ module: 'core', line: '+2 helpers in core', changes: [{ diff: 'add', kind: 'element', name: 'x', key: 'k' }, { diff: 'add', kind: 'call', name: 'y', key: 'a -> b#y' }] }],
    outsidePlan: { modules: [{ module: 'main-entry', changes: [{}, {}] }], line: 'Also changed outside the plan: main-entry (2)' },
    check: { unaccounted: [{ id: 'b1' }], ungrounded: [], unknown: [], otherModule: [] },
    inventory: { units: 3, summary: [] },
  } as never
  const card = factCard({ key: 'w.1', title: 'v1/v2' }, view)
  assert.equal(card.title, 'Step 1 · Plan ↔ fact')
  assert.deepEqual(card.verdict, { label: '3 deviations: look', tone: 'warn' })
  assert.deepEqual(card.rows.map((r) => [r.tag, r.text]), [
    ['otherwise', 'orchestrator: setPrReview has another signature than planned'],
    ['not done', 'store: sessions.reviewFormat is planned, not done'],
    ['new', 'new entity LegacyPrReview'],
    ['check by hand', '1 block of changed code the inventory does not name'],
  ])
  assert.deepEqual(card.details.map((d) => d.summary), ['+2 helpers in core', 'Also changed outside the plan: main-entry (2)', '1 as planned'])
  assert.deepEqual(card.details[0].lines, ['add x', 'add b#y'])
  assert.deepEqual(factCard({ key: 'w.1', title: '' }, view, true).verdict, { label: '3 deviations', tone: 'neutral' })

  const clean = { items: [item('match', 'a')], additions: [], outsidePlan: { modules: [], line: '' }, check: { unaccounted: [], ungrounded: [], unknown: [], otherModule: [] }, inventory: { units: 1, summary: [] } } as never
  assert.deepEqual(factCard({ key: 'w.1', title: '' }, clean).verdict, { label: '1 as planned', tone: 'good' })
  assert.deepEqual(factCard({ key: 'w.1', title: '' }, clean).rows, [{ text: 'No deviations from the plan' }])
  const review = factCard({ key: 'R-1', title: '', review: true }, { ...(clean as object), inventory: null } as never)
  assert.deepEqual([review.title, review.verdict?.label, review.rows[0].text], ['Fact of the PR', 'does not cover the PR yet', 'No inventory of the changes yet'])
})

test('integrationCard: off with Enable: reads auto first, Ask each and Auto; only Auto without a chat to ask in; the enabled state has no buttons', () => {
  const off = integrationCard({ server: 'claude.ai Slack', role: 'developer', why: 'read the thread', status: 'off' }, true)
  assert.equal(off.title, 'claude.ai Slack is off for the developer role')
  assert.deepEqual(off.verdict, { label: 'off', tone: 'warn' })
  assert.deepEqual(off.rows, [{ lead: 'The agent wants it to', text: 'read the thread' }])
  assert.deepEqual(off.buttons.map((b) => b.kind === 'enable' && [b.label, b.mode]), [['Enable: reads auto, writes ask', 'reads'], ['Ask each', 'ask'], ['Auto', 'auto']])
  const arch = integrationCard({ server: 'claude.ai Slack', role: 'architect', why: '', status: 'off' }, false)
  assert.deepEqual(arch.buttons.map((b) => b.label), ['Auto'])
  assert.deepEqual(arch.rows, [])
  const on = integrationCard({ server: 'claude.ai Slack', role: 'developer', why: '', status: 'ask' }, true)
  assert.deepEqual([on.title, on.verdict?.label, on.tone, on.buttons.length], ['claude.ai Slack is on for the developer role', 'on · ask', 'good', 0])
})

test('foldEvents: a run of tools, notices and jobs is one line; messages, replies and cards break runs; ok turn ends alone vanish', () => {
  const items: ChatItem[] = [
    { kind: 'notice', text: 'x.3 started', at: 1 },
    { kind: 'tool', id: 't1', name: 'mcp__mag__update_doc', summary: '', ok: true, at: 2 },
    { kind: 'tool', id: 't2', name: 'mcp__mag__update_doc', summary: '', ok: false, at: 3 },
    { kind: 'job', title: 'Review of x.3', text: '…', at: 4 },
    { kind: 'assistant', text: 'Done', at: 5 },
    { kind: 'result', ok: true, at: 6 },
    { kind: 'user', text: 'ok', at: 7 },
    { kind: 'result', ok: false, at: 8 },
    { kind: 'notice', text: 'a', at: 9 },
    { kind: 'notice', text: 'b', at: 9 },
    { kind: 'notice', text: 'c', at: 9 },
    { kind: 'notice', text: 'd', at: 9 },
    { kind: 'notice', text: 'e', at: 9 },
  ]
  const lines = foldEvents(items)
  assert.deepEqual(lines.map((l) => (l.kind === 'events' ? `${l.n}: ${l.mark}${l.label} (${l.items.length})` : `${l.n}: ${l.item.kind}`)), [
    '0: ✗x.3 started · update_doc ×2 · Review of x.3 (4)',
    '4: assistant',
    '6: user',
    '7: result',
    '8: a · b · c · +2 more (5)',
  ])
})
