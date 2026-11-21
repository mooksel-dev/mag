import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkReport,
  reportWarnings,
  deltaErrors,
  deltaView,
  criteriaSources,
  isIssuesReport,
  issueFinding,
  issuesView,
  type IssuesReport,
  type LegacyReport,
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

/** A stored report from before review-v3-concise-design-first.1, with every block it had. */
const legacy: LegacyReport = {
  intent: 'Routes each request to its tenant by the host name, so tenants no longer need a header.',
  direction: {
    decisions: [{ text: 'A tenant is identified by the suffix of its host name', source: 'agent', cites: ['u1'], view: 'canvas:fact1#api' }],
    options: [
      { name: 'Suffix of the host', tradeoffs: 'no migration; breaks on custom domains', pr: true },
      { name: 'Tenant id in the token', tradeoffs: 'one source of truth; touches auth' },
      { name: 'Lookup table host → tenant', tradeoffs: 'any domain; one more query per request' },
    ],
    facts: [{ text: '3 modules learn the suffix', source: 'agent', cites: ['u1', 'u2'] }],
    references: [{ text: 'Project note: identity comes from auth', source: 'yours', cites: ['notes'] }],
  },
  problem: [
    { criterion: 'Requests reach their tenant', status: 'solved', text: 'Router picks the tenant', source: 'agent', cites: ['u2'] },
    { criterion: 'Custom domains work', status: 'not', text: 'A custom domain has no suffix', source: 'agent', cites: ['src/router.ts:40'] },
  ],
  conventions: [
    { rule: 'app layer uses services, never clients', status: 'fail', text: 'handler calls the db client', source: 'rule', cites: ['src/handler.ts:12'], view: 'canvas:fact1#handler' },
    { rule: 'tests next to code', status: 'pass', text: 'router.test.ts', source: 'agent', cites: ['u3'] },
  ],
  risks: [{ level: 'high', kind: 'security', text: 'Another tenant\'s data', mechanism: 'a crafted host maps to another tenant', source: 'agent', cites: ['src/router.ts:41-44'] }],
  questions: [{ text: 'Are custom domains in scope?', source: 'question', cites: ['ticket'] }],
  changes: [
    { title: 'Tenant from the host', why: 'the design decision', units: ['u1', 'u2'] },
    { title: 'Handler reads the tenant', why: 'breaks the layer rule', units: ['u3'] },
    { title: 'Wiring', why: 'imports and names', units: ['u4'], routine: true },
  ],
  checks: 'request_changes',
  why: 'custom domains break and a crafted host reaches another tenant',
  conclusion: 'Not mergeable yet: decide on custom domains with the author and close the crafted-host hole first.',
}

const synthetic = (): LegacyReport => structuredClone(legacy)

/** A review as an agent passes it today: issues and evidence, its direction unsettled. */
const raw = {
  intent: 'Routes each request to its tenant by the host name, so tenants no longer need a header.',
  verdict: 'request_changes',
  why: 'a crafted host reaches another tenant',
  issues: [
    { title: 'A crafted host reaches another tenant', impact: 'tenant A reads tenant B\'s invoices', kind: 'security', severity: 'blocker', owner: 'author', comment: 'Match the whole host, not its suffix: `evil-acme.com` maps to `acme`.', where: 'src/router.ts:41-44' },
    { title: 'Custom domains are not covered', impact: 'a customer on its own domain gets a 404', kind: 'scope', severity: 'should', owner: 'po', comment: 'Are custom domains in scope of this ticket?' },
    { title: 'Handler calls the db client', impact: 'the layer rule breaks', kind: 'convention', severity: 'nit', owner: 'author', comment: 'Go through the tenants service.', where: 'mag:src/handler.ts:12', raisedBy: '@ann' },
  ],
  acceptance: [
    { criterion: 'Requests reach their tenant', source: 'ticket', evidence: 'router.test.ts "picks the tenant by host"', status: 'met' },
    { criterion: 'No header needed', source: 'pr', evidence: 'no test sends the header', status: 'unverified' },
  ],
  verified: ['CI: build and test green', "@ann's thread on the handler: still open"],
  notChecked: ['load under many tenants'],
  direction: {
    decisions: [{ text: 'A tenant is identified by the suffix of its host name', source: 'agent', cites: ['src/router.ts:40'] }],
    options: [
      { name: 'Suffix of the host', tradeoffs: 'no migration; breaks on custom domains', pr: true },
      { name: 'Tenant id in the token', tradeoffs: 'one source of truth; touches auth' },
    ],
    facts: [{ text: '3 modules learn the suffix', source: 'checked', cites: ['u1', 'u2'] }],
    references: [{ text: 'Project note: identity comes from auth', source: 'user', cites: ['notes'] }],
  },
  diagram: 'canvas:fact1#api',
  conclusion: 'Not mergeable yet: close the crafted-host hole, and ask the PO about custom domains.',
}

const issuesReport = (over: Record<string, unknown> = {}): IssuesReport => {
  const { report, errors } = normalizeReport({ ...raw, ...over })
  assert.deepEqual(errors, [])
  return report
}

test('normalizeReport reads an issues report; checked from the agent is read as agent, user as yours; the diagram is a canvas id', () => {
  const r = issuesReport()
  assert.ok(isIssuesReport(r))
  assert.ok(!isIssuesReport(synthetic()))
  assert.equal(r.checks, 'request_changes')
  assert.equal(r.why, raw.why)
  assert.deepEqual(r.issues.map((i) => [i.severity, i.owner, i.where ?? '-', i.raisedBy ?? '-']), [['blocker', 'author', 'src/router.ts:41-44', '-'], ['should', 'po', '-', '-'], ['nit', 'author', 'mag:src/handler.ts:12', '@ann']])
  assert.deepEqual(r.acceptance.map((a) => [a.source, a.status]), [['ticket', 'met'], ['pr', 'unverified']])
  assert.deepEqual([r.verified.length, r.notChecked], [2, ['load under many tenants']])
  assert.equal(r.direction?.facts[0].source, 'agent')
  assert.equal(r.direction?.references[0].source, 'yours')
  assert.equal(r.diagram, 'fact1')
  assert.deepEqual(checkReport(r), [])
  assert.deepEqual(normalizeReport(JSON.stringify(raw)).errors, [])
})

test('normalizeReport: intent and conclusion are each one short paragraph, required', () => {
  const r = issuesReport()
  assert.equal(r.intent, raw.intent)
  assert.equal(r.conclusion, raw.conclusion)
  const { intent: _, conclusion: __, ...without } = raw
  const missing = normalizeReport(without).errors
  assert.ok(missing.some((e) => /^intent is required: one paragraph/.test(e)))
  assert.ok(missing.some((e) => /^conclusion is required: one paragraph/.test(e)))
  const bad = normalizeReport({ ...raw, intent: 'One.\n\nTwo.', conclusion: 'x'.repeat(601) }).errors
  assert.ok(bad.some((e) => /^intent: one paragraph, no blank lines or lists/.test(e)))
  assert.ok(bad.some((e) => /^conclusion: 601 characters; one concise paragraph, up to 600/.test(e)))
  assert.ok(normalizeReport({ ...raw, conclusion: 'Advice:\n- fix it\n- test it' }).errors.some((e) => /^conclusion: one paragraph, no blank lines or lists/.test(e)))
  assert.deepEqual(normalizeReport({ ...raw, intent: 'A line\nwrapped once.' }).errors, [])
})

test('normalizeReport: an issue has its kind, severity and owner, a ready comment, where a file:line and never a unit id; a blocker only of a kind that may block', () => {
  const issue = raw.issues[0]
  const errs = (over: Record<string, unknown>) => normalizeReport({ ...raw, issues: [{ ...issue, ...over }] }).errors
  assert.ok(errs({ where: 'u23' }).some((e) => /issues\[0\] .*where "u23" is no file:line; give path:line \(an inventory unit id or a module is not one\)/.test(e)))
  assert.ok(errs({ where: 'H3.1' }).some((e) => /where "H3.1" is no file:line/.test(e)))
  assert.ok(errs({ where: 'router' }).some((e) => /where "router" is no file:line/.test(e)))
  assert.deepEqual(errs({ where: 'src/router.ts:41' }), [])
  for (const kind of ['convention', 'naming', 'docs', 'design', 'scope', 'tests', 'question'])
    assert.ok(errs({ kind }).some((e) => new RegExp(`a ${kind} issue is never a blocker`).test(e)), kind)
  for (const kind of ['bug', 'data', 'security', 'ops', 'acceptance']) assert.deepEqual(errs({ kind }), [], kind)
  const missing = errs({ title: '', impact: '', comment: '', kind: 'style', severity: 'major', owner: 'team' })
  for (const re of [/title is required/, /impact is required/, /comment is required/, /kind must be one of bug, data/, /severity must be one of blocker, should, nit, note/, /owner must be one of author, po, user/])
    assert.ok(missing.some((e) => re.test(e)), String(re))
  const accept = normalizeReport({ ...raw, acceptance: [{ criterion: '', source: 'slack', status: 'done' }] }).errors
  for (const re of [/acceptance\[0\]: criterion is required/, /source must be one of pr, ticket, design, none/, /evidence is required/, /status must be one of met, partly, not, unverified/])
    assert.ok(accept.some((e) => re.test(e)), String(re))
})

test('normalizeReport refuses the fields of the old report with what replaces them, a verdict on the direction and wrong shapes', () => {
  const { errors } = normalizeReport({ ...raw, problem: [], conventions: [], risks: [], questions: [], changes: [], checks: { verdict: 'approve' }, verdict: 'merge', why: '' })
  for (const re of [/^problem: the report has no problem; use acceptance/, /^conventions: .*use issues \(only what is wrong, no pass list\)/, /^risks: /, /^questions: .*issues of kind question/, /^changes: /, /^checks: .*use verdict and why/, /^verdict must be one of request_changes, look, approve_with_comments, approve/, /^why is required/])
    assert.ok(errors.some((e) => re.test(e)), String(re))
  assert.ok(normalizeReport({ ...raw, direction: { ...raw.direction, verdict: 'ok' } }).errors.some((e) => /direction has no verdict: the direction is the user's call/.test(e)))
  assert.ok(normalizeReport({ ...raw, direction: 'fine' }).errors.some((e) => /direction must be an object/.test(e)))
  assert.ok(normalizeReport('nope').errors.some((e) => /report must be an object/.test(e)))
  const view = { leaning: 'Something else', confidence: 'sure' }
  const bad = normalizeReport({ ...raw, direction: { ...raw.direction, view } }).errors
  assert.ok(bad.some((e) => /leaning "Something else" is no option's name/.test(e)))
  assert.ok(bad.some((e) => /direction.view: why is required/.test(e)))
  assert.ok(bad.some((e) => /direction.view: confidence must be one of high, medium, low/.test(e)))
  const good = issuesReport({ direction: { ...raw.direction, view: { leaning: 'Tenant id in the token', why: 'auth knows it', confidence: 'medium' } } })
  assert.equal(good.direction?.view?.leaning, 'Tenant id in the token')
})

test('checkReport: never approve with a blocker; request_changes needs something to fix; approve with own issues is approve_with_comments', () => {
  const r = issuesReport()
  const [, should, raised] = r.issues
  assert.ok(checkReport({ ...r, checks: 'approve' }).some((e) => /^verdict: approve with 1 blocker \(A crafted host reaches another tenant\)/.test(e)))
  assert.ok(checkReport({ ...r, checks: 'approve_with_comments' }).some((e) => /^verdict: approve_with_comments with 1 blocker/.test(e)))
  assert.deepEqual(checkReport({ ...r, checks: 'look' }), [])
  assert.deepEqual(checkReport({ ...r, issues: [should], checks: 'request_changes' }), [])
  assert.ok(checkReport({ ...r, issues: [raised], checks: 'request_changes' }).some((e) => /request_changes with nothing to fix/.test(e)))
  assert.ok(checkReport({ ...r, issues: [should], checks: 'approve' }).some((e) => /that is approve_with_comments/.test(e)))
  // A teammate's raised nit is not the reviewer's own: approve stands.
  assert.deepEqual(checkReport({ ...r, issues: [raised], checks: 'approve' }), [])
  assert.deepEqual(checkReport({ ...r, issues: [should, raised], checks: 'approve_with_comments' }), [])
  assert.deepEqual(checkReport({ ...r, issues: [], checks: 'approve' }), [])
})

test('checkReport: a non-trivial change without criteria anywhere needs its acceptance blocker; a trivial one needs none', () => {
  const r = issuesReport({ verdict: 'approve_with_comments' })
  const none = { ...r, issues: [r.issues[1]], acceptance: [{ criterion: 'routes by host', source: 'none' as const, evidence: 'inferred from the diff', status: 'met' as const }] }
  assert.ok(checkReport(none).some((e) => /^acceptance: no criteria in the PR, its ticket or the design; .*blocker issue of kind acceptance.*trivial: true/.test(e)))
  assert.ok(checkReport({ ...none, acceptance: [] }).some((e) => /^acceptance: no criteria/.test(e)))
  assert.deepEqual(checkReport({ ...none, trivial: true }), [])
  const ask = { title: 'No acceptance criteria', impact: 'nobody can tell when it is done', kind: 'acceptance' as const, severity: 'blocker' as const, owner: 'po' as const, comment: 'What are the acceptance criteria?' }
  assert.deepEqual(checkReport({ ...none, issues: [ask], checks: 'request_changes' }), [])
  // Criteria from the design count (a step's plan), and so do the ticket's.
  assert.deepEqual(checkReport({ ...none, acceptance: [{ ...none.acceptance[0], source: 'design' }] }), [])
  assert.deepEqual(criteriaSources(r), ['pr', 'ticket'])
  assert.deepEqual(criteriaSources(none), ['none'])
})

test('checkReport: the direction either follows what settles it or is laid out, cited, with one option the change\'s', () => {
  const r = issuesReport()
  const { direction: _, ...settled } = r
  assert.ok(checkReport(settled).some((e) => /^follows: what settles the direction/.test(e)))
  assert.deepEqual(checkReport({ ...settled, follows: 'the approved plan' }), [])
  assert.ok(checkReport({ ...r, follows: 'the approved plan' }).some((e) => /^direction and follows: one of them/.test(e)))
  const d = r.direction!
  const errors = checkReport({ ...r, direction: { ...d, options: [{ ...d.options[1] }], decisions: [{ ...d.decisions[0], cites: [] }] } })
  assert.ok(errors.some((e) => /direction.decisions: .* cites nothing/.test(e)))
  assert.ok(errors.some((e) => /direction.only: with a single option/.test(e)))
  assert.ok(errors.some((e) => /exactly one option is the change's \(pr: true\), found 0/.test(e)))
  assert.deepEqual(checkReport({ ...r, direction: { ...d, options: [d.options[0]], only: 'the host is all the router has' } }), [])
})

test('reportFindings of an issues report: mag\'s blockers first, then each issue as it is, its comment to post, its title the summary; a raised one not picked', () => {
  const r = withFloor(issuesReport(), verdictFloor({ ci: ['build'], rules: [] }))
  const f = reportFindings(r)
  assert.deepEqual(f.map((x) => [x.level, x.summary ?? '-', x.where ?? '-', x.post ?? '-']), [
    ['blocker', '-', '-', '-'],
    ['blocker', 'A crafted host reaches another tenant', 'src/router.ts:41-44', '-'],
    ['should_fix', 'Custom domains are not covered', '-', '-'],
    ['nit', 'Handler calls the db client', 'mag:src/handler.ts:12', false],
  ])
  assert.equal(f[0].text, 'mag: CI failed: build')
  assert.equal(f[1].text, raw.issues[0].comment)
  assert.equal(issueFinding({ ...r.issues[1], kind: 'question' }).level, 'question')
  assert.equal(issueFinding({ ...r.issues[1], severity: 'note' }).level, 'note')
})

test('issuesView: the first five shown, the rest folded, raised ones not new; the ready line counts the new ones', () => {
  const r = issuesReport()
  const many = { ...r, issues: Array.from({ length: 7 }, (_, i) => ({ ...r.issues[1], title: `i${i}`, ...(i === 6 ? { raisedBy: '@bo' } : {}) })) }
  const v = issuesView(many)
  assert.deepEqual([v.shown.length, v.folded.map((i) => i.title), v.fresh], [5, ['i5', 'i6'], 6])
  assert.equal(reportLine(r), 'Request changes · 2 issues · Direction: your call')
  assert.equal(reportLine(r, 'step'), 'Request changes · 2 issues')
  const { direction: _, ...settled } = r
  assert.equal(reportLine({ ...settled, follows: 'ADR-4', issues: [], checks: 'approve' }), 'Approve')
  assert.equal(reportLine({ ...r, decided: decision() }), 'Request changes · 2 issues · Direction: Prefer Tenant id in the token')
})

test('the verdict is the agent\'s unless mag\'s floor is stricter; then mag attaches its blockers', () => {
  const r = issuesReport({ verdict: 'approve', issues: [], acceptance: raw.acceptance })
  const none = verdictFloor({ ci: [], rules: [] })
  assert.deepEqual(none, { verdict: 'approve', blockers: [] })
  for (const verdict of ['approve', 'approve_with_comments', 'look', 'request_changes'] as const) assert.equal(finalVerdict({ verdict }, none), verdict)
  const kept = withFloor(r, none)
  assert.equal(kept.checks, 'approve')
  assert.equal(kept.floor, undefined)
  assert.equal(kept.raisedFrom, undefined)
  // Plan ↔ fact is no floor (review-v3-concise-design-first.3): only CI and the architecture rules are, and they never lower request_changes.
  const ci = verdictFloor({ ci: ['typecheck'], rules: [] })
  assert.equal(ci.verdict, 'request_changes')
  assert.deepEqual(ci.blockers, ['CI failed: typecheck'])
  assert.equal(finalVerdict({ verdict: 'look' }, ci), 'request_changes')
  assert.equal(verdictFloor({ ci: [], rules: ['services never use services: a -> b (a.ts:3)'] }).verdict, 'request_changes')
  const raised = withFloor(r, ci)
  assert.equal(raised.checks, 'request_changes')
  assert.equal(raised.raisedFrom, 'approve')
  assert.deepEqual(raised.floor, ci)
  assert.ok(isIssuesReport(raised))
  const same = withFloor({ ...r, checks: 'request_changes' }, ci)
  assert.equal(same.checks, 'request_changes')
  assert.equal(same.raisedFrom, undefined)
  assert.deepEqual(same.floor, ci)
  // Applied again, the reviewer's own verdict is the start, not mag's earlier raise.
  const again = withFloor(withFloor(r, ci), none)
  assert.equal(again.checks, 'approve')
  assert.equal(again.raisedFrom, undefined)
  assert.equal(again.floor, undefined)
  // The reviewer's leaning on the direction never affects the verdict.
  const view = { leaning: 'Tenant id in the token', why: 'one source of truth', confidence: 'high' as const }
  assert.equal(withFloor({ ...r, direction: { ...r.direction!, view } }, none).checks, 'approve')
})

test('stepVerdict and prVerdictOf route the verdict', () => {
  assert.deepEqual(['request_changes', 'look', 'approve_with_comments', 'approve'].map((v) => stepVerdict(v as 'look')), ['changes', 'look', 'merge', 'merge'])
  assert.deepEqual(['request_changes', 'look', 'approve_with_comments', 'approve'].map((v) => prVerdictOf(v as 'look')), ['request_changes', 'comment', 'approve', 'approve'])
})

test('markChecked: only a mechanical fact of the direction citing only verified units gets mag\'s badge; no direction, nothing to mark', () => {
  const r = markChecked(issuesReport(), ['u1', 'u2', 'u3'])
  assert.equal(r.direction?.facts[0].source, 'checked')
  assert.equal(r.direction?.decisions[0].source, 'agent')
  assert.equal(r.direction?.references[0].source, 'yours')
  assert.equal(markChecked(issuesReport(), ['u1']).direction?.facts[0].source, 'agent')
  const { direction: _, ...settled } = issuesReport()
  assert.deepEqual(markChecked({ ...settled, follows: 'ADR-4' }, ['u1']), { ...settled, follows: 'ADR-4' })
  const old = markChecked(synthetic(), ['u1', 'u2'])
  assert.equal(old.direction.facts[0].source, 'checked')
  assert.equal(old.conventions[0].source, 'rule')
})

test('an issues report with a direction drafts and references like a legacy one; its open questions are its question issues', () => {
  const r = issuesReport({ issues: [{ ...raw.issues[1], kind: 'question', comment: 'Are custom domains in scope?' }], verdict: 'request_changes' })
  assert.equal(directionDraft(r, { choice: 'discuss' }), '- Why Suffix of the host over Tenant id in the token?\n- Are custom domains in scope?')
  const { direction: _, ...settled } = r
  assert.equal(directionDraft({ ...settled, follows: 'ADR-4' }, { choice: 'discuss' }), '- Are custom domains in scope?')
  assert.equal(directionCardText({ direction: undefined }, []), '')
  assert.deepEqual(directionReferences({ direction: undefined }, []), [])
  assert.deepEqual(unknownDecisions({ ...r, direction: { ...r.direction!, references: [{ text: 'x', source: 'yours', cites: ['decision:zz'] }] } }, []), ['zz'])
})

// Reports stored before review-v3-concise-design-first.1 render as they were.

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
  assert.match(block, /put it in direction\.references with source user, citing decision:<id>/)
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

test('a re-review is a delta against the round before: each previous issue fixed or open, each issue now open or new (review-v3-concise-design-first.3)', () => {
  const previous = issuesReport({ issues: raw.issues.slice(0, 2) })
  const [host, domains] = previous.issues.map((i) => i.title)
  const first = issuesReport()
  assert.deepEqual(deltaErrors(first, null), [], 'a first review has none')
  assert.match(deltaErrors(issuesReport({ delta: [{ title: host, status: 'new' }] }), null)[0], /^delta: only a re-review has one/)
  assert.match(deltaErrors(first, previous)[0], /^delta is required on a re-review: .*A crafted host reaches another tenant; Custom domains are not covered/)
  const issues = [raw.issues[1], { ...raw.issues[0], title: 'Logs leak the token', where: 'src/log.ts:3' }]
  const delta = [{ title: host, status: 'fixed' }, { title: domains, status: 'open' }, { title: 'Logs leak the token', status: 'new' }]
  assert.deepEqual(deltaErrors(issuesReport({ issues, delta }), previous), [])
  const short = issuesReport({ issues, delta: delta.slice(1) })
  assert.match(deltaErrors(short, previous)[0], /^delta: 1 fixed or open, but the previous round had 2 issues/)
  const unlisted = issuesReport({ issues, delta: delta.slice(0, 2) })
  assert.match(deltaErrors(unlisted, previous)[0], /^delta: 1 open or new, but this report has 2 issues/)
  // After a legacy report any delta goes.
  assert.deepEqual(deltaErrors(first, { checks: 'look' } as never), [])
  assert.deepEqual(deltaView({ delta: delta as never }), [
    { status: 'fixed', titles: [host] },
    { status: 'open', titles: [domains] },
    { status: 'new', titles: ['Logs leak the token'] },
  ])
  assert.deepEqual(normalizeReport({ ...raw, delta: [{ title: '', status: 'gone' }] }).errors, ['delta[0]: title is required, the issue\'s title', 'delta[0] (): status must be one of fixed, open, new'])
  assert.deepEqual(normalizeReport({ ...raw, delta: 'x' }).errors, ['delta must be a list of { title, status }'])
})

test('reportWarnings: a change of behaviour without an essential diagram warns; with one, or trivial, it does not', () => {
  assert.match(reportWarnings({}, 0).join('\n'), /no essential diagram[\s\S]*show_diagram, role review[\s\S]*boundary of kind app[\s\S]*trivial: true/)
  assert.deepEqual(reportWarnings({}, 1), [])
  assert.deepEqual(reportWarnings({ trivial: true }, 0), [])
})
