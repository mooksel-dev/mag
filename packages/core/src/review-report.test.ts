import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkReport,
  checksVerdict,
  markChecked,
  normalizeReport,
  prVerdictOf,
  reportCards,
  reportChanges,
  reportFindings,
  reportLine,
  reportStrip,
  reviewReadyText,
  stepVerdict,
  type ChangeInventory,
  type PrReview,
  type ReviewReport,
} from './index.ts'

const inventory: ChangeInventory = {
  summary: ['identity by suffix'],
  units: ['u1', 'u2', 'u3', 'u4'].map((id) => ({ id, kind: 'method' as const, module: 'api', name: `f${id}`, change: 'add' as const, logic: 'trivial' as const, hunks: ['H1'] })),
  noise: [],
}

/** A synthetic review with every block of the report. */
const raw = {
  direction: {
    decisions: [{ text: 'A tenant is identified by the suffix of its host name', source: 'agent', cites: ['u1'], view: 'canvas:fact1#api' }],
    options: [
      { name: 'Suffix of the host', tradeoffs: 'no migration; breaks on custom domains', pr: true },
      { name: 'Tenant id in the token', tradeoffs: 'one source of truth; touches auth' },
      { name: 'Lookup table host → tenant', tradeoffs: 'any domain; one more query per request' },
    ],
    facts: [{ text: '3 modules learn the suffix', source: 'checked', cites: ['u1', 'u2'] }],
    references: [{ text: 'Project note: identity comes from auth', source: 'yours', cites: ['notes'] }],
  },
  problem: [
    { criterion: 'Requests reach their tenant', status: 'solved', text: 'Router picks the tenant', source: 'agent', cites: ['u2'] },
    { criterion: 'Custom domains work', status: 'not', text: 'A custom domain has no suffix', source: 'agent', cites: ['src/router.ts:40'] },
  ],
  conventions: [
    { rule: 'app layer uses services, never clients', status: 'fail', text: 'handler calls the db client', source: 'agent', cites: ['src/handler.ts:12'], view: 'canvas:fact1#handler' },
    { rule: 'tests next to code', status: 'pass', text: 'router.test.ts', source: 'agent', cites: ['u3'] },
  ],
  risks: [{ level: 'high', kind: 'security', text: 'Another tenant\'s data', mechanism: 'a crafted host maps to another tenant', source: 'agent', cites: ['src/router.ts:41-44'] }],
  questions: [{ text: 'Are custom domains in scope?', cites: ['ticket'] }],
  changes: [
    { title: 'Tenant from the host', why: 'the design decision', units: ['u1', 'u2'] },
    { title: 'Handler reads the tenant', why: 'breaks the layer rule', units: ['u3'] },
    { title: 'Wiring', why: 'imports and names', units: ['u4'], routine: true },
  ],
  checks: 'request_changes',
}

const synthetic = (): ReviewReport => {
  const { report, errors } = normalizeReport(raw)
  assert.deepEqual(errors, [])
  return report
}

test('normalizeReport reads every block; checked from the agent is read as agent, a failed rule is a rule claim, questions are questions', () => {
  const r = synthetic()
  assert.equal(r.direction.options.length, 3)
  assert.equal(r.direction.facts[0].source, 'agent')
  assert.equal(r.conventions[0].source, 'rule')
  assert.equal(r.conventions[1].source, 'agent')
  assert.equal(r.questions[0].source, 'question')
  assert.equal(r.direction.decisions[0].view, 'canvas:fact1#api')
  assert.deepEqual(normalizeReport(JSON.stringify(raw)).errors, [])
})

test('normalizeReport refuses a verdict on the direction and wrong shapes', () => {
  const { errors } = normalizeReport({ ...raw, direction: { ...raw.direction, verdict: 'ok' }, risks: [{ level: 'huge', kind: 'bug', text: 'x', source: 'agent', cites: ['u1'] }], checks: 'merge' })
  assert.ok(errors.some((e) => /direction has no verdict: the direction is the user's call/.test(e)))
  assert.ok(errors.some((e) => /risks\[0\]: level must be one of/.test(e)))
  assert.ok(errors.some((e) => /risks\[0\]: mechanism is required/.test(e)))
  assert.ok(errors.some((e) => /checks must be one of/.test(e)))
  assert.ok(normalizeReport('nope').errors.some((e) => /report must be an object/.test(e)))
  assert.ok(normalizeReport({ ...raw, problem: [{ criterion: 'c', status: 'solved', text: 't', source: 'mine', cites: ['u1'] }] }).errors.some((e) => /source must be one of agent, yours, question, rule/.test(e)))
})

test('checkReport: the synthetic review passes against its inventory', () => {
  assert.deepEqual(checkReport(synthetic(), inventory), [])
})

test('checkReport: claims cited, options with one of the PR, every unit in exactly one change, checks consistent', () => {
  const r = synthetic()
  const bad: ReviewReport = {
    ...r,
    direction: { ...r.direction, options: [{ ...r.direction.options[1] }], decisions: [{ ...r.direction.decisions[0], cites: [] }] },
    changes: [
      { title: 'A', why: 'x', units: ['u1', 'u2'] },
      { title: 'B', why: 'y', units: ['u2', 'u9'] },
    ],
    checks: 'approve',
  }
  const errors = checkReport(bad, inventory)
  assert.ok(errors.some((e) => /direction.decisions: .* cites nothing/.test(e)))
  assert.ok(errors.some((e) => /direction.options: 2–4 options, found 1; work them out before reading the author's description/.test(e)))
  assert.ok(errors.some((e) => /exactly one option is the change's \(pr: true\), found 0/.test(e)))
  assert.ok(errors.some((e) => /u9 is no unit of the inventory/.test(e)))
  assert.ok(errors.some((e) => /units in no change: u3, u4/.test(e)))
  assert.ok(errors.some((e) => /u2 is in 2 changes/.test(e)))
  assert.ok(errors.some((e) => /checks: approve with a failed rule, a not-solved criterion or a high risk/.test(e)))
  assert.ok(checkReport(r, null).some((e) => /no inventory yet/.test(e)))
  // A step's direction is the approved plan: one option is enough.
  const step = { ...r, direction: { ...r.direction, options: [r.direction.options[0]] } }
  assert.deepEqual(checkReport(step, inventory, 'step'), [])
  // Seven changes are too many; a one-unit inventory takes one.
  assert.ok(checkReport({ ...r, changes: Array.from({ length: 7 }, (_, i) => ({ title: `c${i}`, why: 'w', units: i < 4 ? [`u${i + 1}`] : [] })) }, inventory).some((e) => /2–6 changes/.test(e)))
  assert.deepEqual(checkReport({ ...r, changes: [{ title: 'one', why: 'w', units: ['u1'] }] }, { ...inventory, units: inventory.units.slice(0, 1) }), [])
})

test('checksVerdict comes from problem, conventions and risks only', () => {
  const r = synthetic()
  assert.equal(checksVerdict(r), 'request_changes')
  const clean = { ...r, problem: [r.problem[0]], conventions: [r.conventions[1]], risks: [] }
  assert.equal(checksVerdict(clean), 'approve')
  assert.equal(checksVerdict({ ...clean, risks: [{ ...r.risks[0], level: 'medium' }] }), 'look')
  // Direction never counts: a report with no PR option still approves on its checks.
  assert.equal(checksVerdict({ ...clean, direction: { decisions: [], options: [], facts: [], references: [] } } as ReviewReport), 'approve')
  assert.deepEqual([stepVerdict('request_changes'), stepVerdict('look'), stepVerdict('approve')], ['changes', 'look', 'merge'])
  assert.deepEqual([prVerdictOf('request_changes'), prVerdictOf('look'), prVerdictOf('approve')], ['request_changes', 'comment', 'approve'])
})

test('markChecked: only a mechanical fact citing only verified units gets mag\'s badge; judgements keep theirs', () => {
  const r = markChecked(synthetic(), ['u1', 'u2', 'u3'])
  assert.equal(r.direction.facts[0].source, 'checked')
  assert.equal(r.direction.decisions[0].source, 'agent')
  assert.equal(r.problem[0].source, 'agent')
  assert.equal(r.conventions[1].source, 'agent')
  assert.equal(r.conventions[0].source, 'rule')
  assert.equal(r.direction.references[0].source, 'yours')
  assert.equal(markChecked(synthetic(), ['u1']).direction.facts[0].source, 'agent')
})

test('checkReport: request_changes or look needs a finding behind it', () => {
  const r = synthetic()
  const clean = { ...r, problem: [r.problem[0]], conventions: [r.conventions[1]], risks: [], questions: [] }
  assert.deepEqual(checkReport({ ...clean, checks: 'approve' }, inventory), [])
  for (const checks of ['request_changes', 'look'] as const)
    assert.ok(checkReport({ ...clean, checks }, inventory).some((e) => /nothing behind it; give the risk, rule or question behind it/.test(e)))
  assert.deepEqual(checkReport({ ...clean, questions: r.questions, checks: 'look' }, inventory), [])
})

test('reportFindings: unsolved criteria, failed rules, risks and questions, most severe first, with where and node', () => {
  const f = reportFindings(synthetic())
  assert.deepEqual(f.map((x) => x.level), ['blocker', 'blocker', 'blocker', 'question'])
  assert.match(f[0].text, /^Problem: Custom domains work: not solved\./)
  assert.equal(f[0].where, 'src/router.ts:40')
  assert.equal(f[1].node, 'canvas:fact1#handler')
  assert.match(f[2].text, /^Risk \(security\): .*crafted host/)
  assert.equal(f[2].where, 'src/router.ts:41-44')
  assert.equal(f[3].text, 'Are custom domains in scope?')
})

test('the page model: strip, changes with routine folded, evidence views, ready line', () => {
  const r = synthetic()
  const strip = reportStrip(r, { counts: { match: 0, differs: 0, missing: 0, unplanned: 0, unaccounted: 1, ungrounded: 0 } })
  assert.deepEqual(strip.map((c) => `${c.key}: ${c.value} (${c.tone})`), [
    'direction: your call (neutral)',
    'problem: 1/2 solved (bad)',
    'conventions: 1 failed (bad)',
    'risks: 1 high (bad)',
    'coverage: 1 gap in the inventory (warn)',
  ])
  assert.equal(reportStrip(r, null, 'step')[0].value, 'the approved plan')
  assert.equal(reportStrip(r, null)[4].value, 'no fact')
  const { rows, routine } = reportChanges(r)
  assert.deepEqual(rows.map((c) => c.title), ['Tenant from the host', 'Handler reads the tenant'])
  assert.equal(routine?.title, 'Wiring')
  assert.equal(reportLine(r), 'Request changes · Direction: your call')
  assert.equal(reportLine(r, 'step'), 'Request changes')
  const pr = { verdict: 'request_changes', findings: [], report: r } as unknown as PrReview
  assert.equal(reviewReadyText(pr), 'Review ready: Request changes · Direction: your call')
})

test('reportCards: every question block as a card, failed rules and worst risks first', () => {
  const r = synthetic()
  const cards = reportCards({ ...r, risks: [{ ...r.risks[0], level: 'low' }, r.risks[0]] })
  assert.deepEqual(cards.map((c) => `${c.title}: ${c.rows.map((x) => `${x.status ?? '-'}/${x.tone}/${x.claim.source}`).join(', ')}`), [
    'Problem: solved/good/agent, not/bad/agent',
    'Conventions: fail/bad/rule, pass/good/agent',
    'Risks: high/bad/agent, low/neutral/agent',
    'Open questions: -/neutral/question',
  ])
  assert.equal(cards[0].rows[1].about, 'Custom domains work')
  assert.equal(cards[2].rows[0].about, 'security: a crafted host maps to another tenant')
})
