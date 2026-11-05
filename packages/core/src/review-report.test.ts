import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkReport,
  finalVerdict,
  verdictFloor,
  withFloor,
  decisionNote,
  decisionsBlock,
  directionCardText,
  directionDraft,
  directionReferences,
  unknownDecisions,
  type DirectionDecision,
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
  checks: { verdict: 'request_changes', why: 'custom domains break and a crafted host reaches another tenant' },
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
  assert.equal(r.checks, 'request_changes')
  assert.equal(r.why, 'custom domains break and a crafted host reaches another tenant')
  assert.deepEqual(normalizeReport(JSON.stringify(raw)).errors, [])
})

test('normalizeReport accepts the reviewer\'s view on the direction; it must lean to an option', () => {
  const view = { leaning: 'Tenant id in the token', why: 'auth already knows the tenant', confidence: 'medium' }
  const { report, errors } = normalizeReport({ ...raw, direction: { ...raw.direction, view } })
  assert.deepEqual(errors, [])
  assert.deepEqual(report.direction.view, view)
  assert.deepEqual(checkReport(report, inventory), [])
  const bad = normalizeReport({ ...raw, direction: { ...raw.direction, view: { leaning: 'Something else', confidence: 'sure' } } }).errors
  assert.ok(bad.some((e) => /leaning "Something else" is no option's name/.test(e)))
  assert.ok(bad.some((e) => /direction.view: why is required/.test(e)))
  assert.ok(bad.some((e) => /direction.view: confidence must be one of high, medium, low/.test(e)))
})

test('normalizeReport refuses a verdict on the direction and wrong shapes', () => {
  const { errors } = normalizeReport({ ...raw, direction: { ...raw.direction, verdict: 'ok' }, risks: [{ level: 'huge', kind: 'bug', text: 'x', source: 'agent', cites: ['u1'] }], checks: { verdict: 'merge' } })
  assert.ok(errors.some((e) => /direction has no verdict: the direction is the user's call; give your leaning in direction.view/.test(e)))
  assert.ok(errors.some((e) => /risks\[0\]: level must be one of/.test(e)))
  assert.ok(errors.some((e) => /risks\[0\]: mechanism is required/.test(e)))
  assert.ok(errors.some((e) => /checks.verdict must be one of/.test(e)))
  assert.ok(errors.some((e) => /checks.why is required/.test(e)))
  // The old form, a bare verdict, says what is missing.
  assert.ok(normalizeReport({ ...raw, checks: 'approve' }).errors.some((e) => /checks.verdict must be one of/.test(e)))
  assert.ok(normalizeReport('nope').errors.some((e) => /report must be an object/.test(e)))
  assert.ok(normalizeReport({ ...raw, problem: [{ criterion: 'c', status: 'solved', text: 't', source: 'mine', cites: ['u1'] }] }).errors.some((e) => /source must be one of agent, yours, question, rule/.test(e)))
})

test('checkReport: the synthetic review passes against its inventory', () => {
  assert.deepEqual(checkReport(synthetic(), inventory), [])
})

test('checkReport: claims cited, options with one of the PR, every unit in exactly one change', () => {
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
  assert.ok(errors.some((e) => /direction.only: with a single option, say why it is the only sensible one/.test(e)))
  assert.ok(errors.some((e) => /exactly one option is the change's \(pr: true\), found 0/.test(e)))
  assert.ok(errors.some((e) => /u9 is no unit of the inventory/.test(e)))
  assert.ok(errors.some((e) => /units in no change: u3, u4/.test(e)))
  assert.ok(errors.some((e) => /u2 is in 2 changes/.test(e)))
  // The agent's approve over a failed rule and a high risk is its judgment: no label decides the verdict.
  assert.ok(!errors.some((e) => /^checks/.test(e)))
  assert.ok(checkReport(r, null).some((e) => /no inventory yet/.test(e)))
  // One option with why it is the only one: accepted, for a step and a PR alike.
  const one = { ...r, direction: { ...r.direction, options: [r.direction.options[0]], only: 'the host is all the router has' } }
  assert.deepEqual(checkReport(one, inventory, 'step'), [])
  assert.deepEqual(checkReport(one, inventory), [])
  // Without the reason it is refused.
  assert.ok(checkReport({ ...one, direction: { ...one.direction, only: undefined } }, inventory, 'step').some((e) => /direction.only/.test(e)))
  // Any number of options and changes: seven changes, one per unit and three empty ones refused only for being empty.
  const seven = checkReport({ ...r, changes: Array.from({ length: 7 }, (_, i) => ({ title: `c${i}`, why: 'w', units: i < 4 ? [`u${i + 1}`] : [] })) }, inventory)
  assert.deepEqual(seven, ['changes (c4): no units', 'changes (c5): no units', 'changes (c6): no units'])
  assert.deepEqual(checkReport({ ...r, changes: [{ title: 'all', why: 'w', units: ['u1', 'u2', 'u3', 'u4'] }] }, inventory), [])
  assert.ok(checkReport({ ...r, changes: [] }, inventory).some((e) => /group the inventory into changes/.test(e)))
})

test('the verdict is the agent\'s unless mag\'s floor is stricter; then mag attaches its blockers', () => {
  const r = synthetic()
  const none = verdictFloor({ deviations: [], ci: [], rules: [] })
  assert.deepEqual(none, { verdict: 'approve', blockers: [] })
  // The agent's verdict stands without a floor, even approve over a high risk, and look over nothing mag knows.
  for (const verdict of ['approve', 'look', 'request_changes'] as const) assert.equal(finalVerdict({ verdict }, none), verdict)
  const kept = withFloor({ ...r, checks: 'approve' }, none)
  assert.equal(kept.checks, 'approve')
  assert.equal(kept.floor, undefined)
  assert.equal(kept.raisedFrom, undefined)
  // A plan deviation is look: it raises approve, never lowers request_changes.
  const deviation = verdictFloor({ deviations: ['orchestrator setReview is off the plan'], ci: [], rules: [] })
  assert.equal(deviation.verdict, 'look')
  assert.equal(finalVerdict({ verdict: 'approve' }, deviation), 'look')
  assert.equal(finalVerdict({ verdict: 'request_changes' }, deviation), 'request_changes')
  // Failed CI or a failed architecture rule is request_changes.
  const ci = verdictFloor({ deviations: ['x is off the plan'], ci: ['typecheck'], rules: [] })
  assert.equal(ci.verdict, 'request_changes')
  assert.deepEqual(ci.blockers, ['CI failed: typecheck', 'x is off the plan'])
  assert.equal(verdictFloor({ deviations: [], ci: [], rules: ['services never use services: a -> b (a.ts:3)'] }).verdict, 'request_changes')
  const raised = withFloor({ ...r, checks: 'approve' }, ci)
  assert.equal(raised.checks, 'request_changes')
  assert.equal(raised.raisedFrom, 'approve')
  assert.deepEqual(raised.floor, ci)
  // mag's blockers come first among the findings; the agent does not restate them.
  assert.deepEqual(reportFindings(raised).slice(0, 2).map((f) => [f.text, f.level]), [['mag: CI failed: typecheck', 'blocker'], ['mag: x is off the plan', 'blocker']])
  // A floor no stricter than the agent keeps its blockers attached but raises nothing.
  const same = withFloor({ ...r, checks: 'request_changes' }, deviation)
  assert.equal(same.checks, 'request_changes')
  assert.equal(same.raisedFrom, undefined)
  assert.deepEqual(same.floor, deviation)
  // Applied again, the reviewer's own verdict is the start, not mag's earlier raise.
  const again = withFloor(withFloor({ ...r, checks: 'approve' }, deviation), none)
  assert.equal(again.checks, 'approve')
  assert.equal(again.raisedFrom, undefined)
  assert.equal(again.floor, undefined)
})

test('the direction view never affects the verdict', () => {
  const r = synthetic()
  const view = { leaning: 'Tenant id in the token', why: 'one source of truth', confidence: 'high' as const }
  const floor = verdictFloor({ deviations: [], ci: [], rules: [] })
  assert.equal(withFloor({ ...r, checks: 'approve', direction: { ...r.direction, view } }, floor).checks, 'approve')
  assert.deepEqual(reportFindings({ ...r, direction: { ...r.direction, view } }), reportFindings(r))
})

test('stepVerdict and prVerdictOf route the checks verdict', () => {
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

test('checkReport: request_changes needs something to fix; look may rest on its why', () => {
  const r = synthetic()
  const clean = { ...r, problem: [r.problem[0]], conventions: [r.conventions[1]], risks: [], questions: [] }
  assert.deepEqual(checkReport({ ...clean, checks: 'approve' }, inventory), [])
  assert.deepEqual(checkReport({ ...clean, checks: 'look' }, inventory), [])
  assert.ok(checkReport({ ...clean, checks: 'request_changes' }, inventory).some((e) => /request_changes with nothing to fix/.test(e)))
  assert.deepEqual(checkReport({ ...clean, questions: r.questions, checks: 'request_changes' }, inventory), [])
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
  const pr = { results: { v2: { verdict: 'request_changes', findings: [], report: r } }, shown: 'v2' } as unknown as PrReview
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

const decision = (over: Partial<DirectionDecision> = {}): DirectionDecision => ({
  id: 'd1', reviewId: 't1', pr: 'https://github.com/acme/api/pull/1', decision: 'A tenant is identified by the suffix of its host name', choice: 'prefer', option: 'Tenant id in the token', principle: 'identity comes from auth', at: 10, ...over,
})

test('a direction decision: its notes line, the strip and line show it, the earlier ones go to the prompt newest first (review-v2-questions-first-direction.2)', () => {
  const d = decision()
  assert.equal(decisionNote(d), '- Direction https://github.com/acme/api/pull/1: A tenant is identified by the suffix of its host name → Prefer Tenant id in the token (identity comes from auth)')
  assert.equal(decisionNote(decision({ choice: 'ok', option: undefined, principle: undefined })), '- Direction https://github.com/acme/api/pull/1: A tenant is identified by the suffix of its host name → Direction OK')
  const r = { ...synthetic(), decided: d }
  assert.equal(reportLine(r), 'Request changes · Direction: Prefer Tenant id in the token')
  assert.equal(reportLine({ ...r, decided: decision({ choice: 'ok' }) }), 'Request changes · Direction: OK')
  assert.equal(reportLine({ ...r, decided: decision({ choice: 'discuss' }) }), 'Request changes · Direction: Ask the author')
  assert.deepEqual(reportStrip(r, null)[0], { key: 'direction', label: 'Direction', value: 'Prefer Tenant id in the token', tone: 'bad' })
  assert.equal(reportStrip(r, null, 'step')[0].value, 'the approved plan')

  assert.equal(decisionsBlock(undefined), '')
  const block = decisionsBlock([d, decision({ id: 'd2', choice: 'ok', option: undefined, principle: undefined, at: 20 })])
  assert.match(block, /put it in direction\.references with source yours, citing decision:<id>/)
  assert.ok(block.indexOf('decision:d2') < block.indexOf('decision:d1'))
  assert.match(block, /- decision:d1: https:\/\/github\.com\/acme\/api\/pull\/1: A tenant .* → Prefer Tenant id in the token; principle: identity comes from auth/)
})

test('directionReferences: a reference citing an earlier decision is yours, with it; unknown decision ids are found', () => {
  const r = synthetic()
  const withRef = { ...r, direction: { ...r.direction, references: [...r.direction.references, { text: 'You preferred auth for identity on api#1', source: 'agent' as const, cites: ['decision:d1'] }] } }
  const refs = directionReferences(withRef, [decision()])
  assert.deepEqual(refs.map((x) => [x.claim.source, x.decisions.map((d) => d.id)]), [['yours', []], ['yours', ['d1']]])
  assert.equal(directionReferences(withRef, [])[1].claim.source, 'agent')
  assert.deepEqual(unknownDecisions(withRef, [decision()]), [])
  assert.deepEqual(unknownDecisions(withRef, undefined), ['d1'])
  assert.match(directionCardText(withRef, [decision()]), /Options:\n- Suffix of the host \(the PR's\): no migration[\s\S]*References:[\s\S]*\[yours\] You preferred auth[\s\S]*earlier: Direction https/)
})

test('directionDraft: prefer names the option against the PR\'s, discuss asks why and the open questions, ok drafts nothing', () => {
  const r = synthetic()
  assert.equal(directionDraft(r, decision()), "I'd rather go with Tenant id in the token than Suffix of the host: one source of truth; touches auth.\n\nidentity comes from auth")
  assert.equal(directionDraft(r, { choice: 'discuss' }), '- Why Suffix of the host over Tenant id in the token or Lookup table host → tenant?\n- Are custom domains in scope?')
  assert.equal(directionDraft(r, { choice: 'ok' }), '')
})
