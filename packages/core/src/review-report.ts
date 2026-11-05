// The review report (review-v2-questions-first-direction.1): a review answers fixed questions instead of listing
// findings. Direction is the user's call (the design decisions the change makes, options, facts, references; no
// verdict); Problem, Conventions and Risks are checked, and only they give the checks verdict; the inventory is grouped
// into a few changes by importance. Every item is a claim with a source badge and what it cites. Shared by the review of
// a step and of a teammate's PR; a stored review without a report is an old one and renders as before.

import type { ChangeInventory } from './inventory.ts'
import type { FindingLevel } from './pr-review.ts'
import type { ReviewFinding, ReviewVerdict, StepFact } from './index.ts'

/**
 * Where a claim comes from. checked: mag verified it against the inventory (set by mag only); agent: the reviewer's
 * reading, with code refs; yours: the user's own words (PR comments, notes, decisions); question: open, the author
 * answers; rule: a project rule fails.
 */
export type ClaimSource = 'checked' | 'agent' | 'yours' | 'question' | 'rule'

export const CLAIM_SOURCES: ClaimSource[] = ['checked', 'agent', 'yours', 'question', 'rule']

/** The sources a reviewer may give; checked is mag's. */
const AGENT_SOURCES: ClaimSource[] = ['agent', 'yours', 'question', 'rule']

export interface Claim {
  text: string
  source: ClaimSource
  /** Inventory unit ids, file:line, a PR comment, decision:<id>, a note: at least one. */
  cites: string[]
  /** The diagram of the review's set it shows on: canvas:<id>#<node>. */
  view?: string
}

/** One way to make the design decision; the PR's own design is one of them. */
export interface DirectionOption {
  name: string
  /** One line of trade-offs. */
  tradeoffs: string
  /** The option the change takes. */
  pr?: boolean
}

/** The design decision(s) the change makes and what the user needs to decide on it. Never a verdict: that is the user's. */
export interface Direction {
  /** One sentence each. */
  decisions: Claim[]
  /** 2–4 (a step: 1–4, the plan's), exactly one of them the change's. */
  options: DirectionOption[]
  /** Mechanical facts about the change's option: modules that learn the new concept, existing flows hit, new violations. */
  facts: Claim[]
  /** Project notes, ADRs, CLAUDE.md rules, earlier decisions of the user, PR threads. */
  references: Claim[]
}

export type CriterionStatus = 'solved' | 'partly' | 'not'
export const CRITERION_STATUSES: CriterionStatus[] = ['solved', 'partly', 'not']

/** An acceptance criterion of the ticket and whether the change meets it. */
export interface CriterionClaim extends Claim {
  criterion: string
  status: CriterionStatus
}

export type RuleStatus = 'pass' | 'fail'
export const RULE_STATUSES: RuleStatus[] = ['pass', 'fail']

/** A project rule and whether the change keeps it; a failed one cites the offending edges or lines. */
export interface RuleClaim extends Claim {
  rule: string
  status: RuleStatus
}

export type RiskLevel = 'high' | 'medium' | 'low'
export const RISK_LEVELS: RiskLevel[] = ['high', 'medium', 'low']
export type RiskKind = 'bug' | 'data' | 'ops' | 'security' | 'privacy'
export const RISK_KINDS: RiskKind[] = ['bug', 'data', 'ops', 'security', 'privacy']

/** A risk: text says what goes wrong, mechanism how, cites where. */
export interface RiskClaim extends Claim {
  level: RiskLevel
  kind: RiskKind
  mechanism: string
}

/** A group of the inventory's units that matters as one change; routine ones fold into one row. */
export interface ReportChange {
  title: string
  /** Why it matters; for the routine row, what it holds. */
  why: string
  /** Inventory unit ids. */
  units: string[]
  routine?: boolean
}

/** The checks verdict, from Problem, Conventions and Risks only. */
export type ChecksVerdict = 'request_changes' | 'look' | 'approve'
export const CHECKS_VERDICTS: ChecksVerdict[] = ['request_changes', 'look', 'approve']
export const CHECKS_LABELS: Record<ChecksVerdict, string> = { request_changes: 'Request changes', look: 'Look', approve: 'Approve' }

export interface ReviewReport {
  direction: Direction
  problem: CriterionClaim[]
  conventions: RuleClaim[]
  risks: RiskClaim[]
  /** To the author. */
  questions: Claim[]
  /** In order of importance; the routine row last. */
  changes: ReportChange[]
  checks: ChecksVerdict
  /** The user's call on the direction of this review (review-v2-questions-first-direction.2); a PR's review only. */
  decided?: DirectionDecision
  /** The comment to the author drafted with the call: the preferred option (prefer) or questions (discuss). */
  draft?: string
}

/** The user's call on a direction: it is fine, another option is better, or the author is asked first. */
export type DirectionChoice = 'ok' | 'prefer' | 'discuss'
export const DIRECTION_CHOICES: DirectionChoice[] = ['ok', 'prefer', 'discuss']
export const DIRECTION_CHOICE_LABELS: Record<DirectionChoice, string> = { ok: 'Direction OK', prefer: 'Prefer', discuss: 'Ask the author' }

/**
 * The user's call on the direction of a reviewed PR (review-v2-questions-first-direction.2): on the review's report and in
 * the project's list, so later reviews and plans cite it (decision:<id>) as the user's own.
 */
export interface DirectionDecision {
  id: string
  /** The review (task id) it was made on. */
  reviewId: string
  /** The PR's link. */
  pr: string
  /** The design decision the PR makes, one sentence (the report's direction.decisions). */
  decision: string
  choice: DirectionChoice
  /** With prefer: the option the user prefers, by name. */
  option?: string
  /** The principle behind it, in the user's words, when they gave one. */
  principle?: string
  at: number
}

/** Which review a report is of: a step's (direction is the approved plan) or a teammate's PR (direction is the user's call). */
export type ReportKind = 'step' | 'pr'

type Raw = Record<string, unknown>
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : [])
const strings = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : [])

/**
 * A report from what an agent passed (an object or its JSON), with what is wrong in its shape. A source of checked is
 * read as agent: only mag sets checked (markChecked). A verdict on the direction is refused.
 */
export function normalizeReport(raw: unknown): { report: ReviewReport; errors: string[] } {
  const errors: string[] = []
  let o = raw
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o)
    } catch {
      o = null
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) errors.push('report must be an object (or its JSON)')
  const r = (o && typeof o === 'object' ? o : {}) as Raw
  const claim = (c: Raw, what: string, source?: ClaimSource): Claim => {
    // Missing means the reviewer's own reading; checked is mag's to give.
    const given = (text(c?.source) || 'agent') as ClaimSource
    const out: Claim = { text: text(c?.text), source: source ?? (given === 'checked' ? 'agent' : given), cites: strings(c?.cites) }
    if (!out.text) errors.push(`${what}: text is required`)
    if (!source && !AGENT_SOURCES.includes(given) && given !== 'checked') errors.push(`${what}: source must be one of ${AGENT_SOURCES.join(', ')} (checked is mag's)`)
    if (text(c?.view)) out.view = text(c.view)
    return out
  }
  const d = (r.direction && typeof r.direction === 'object' ? r.direction : {}) as Raw
  if (!r.direction) errors.push('direction is required: decisions, options, facts, references')
  for (const k of ['verdict', 'ok', 'recommendation', 'choice'])
    if (d[k] !== undefined) errors.push(`direction has no ${k}: the direction is the user's call; give options, facts and references`)
  const direction: Direction = {
    decisions: list(d.decisions).map((c, i) => claim(typeof c === 'string' ? { text: c, source: 'agent' } : c, `direction.decisions[${i}]`)),
    options: list(d.options).map((op, i) => {
      const out: DirectionOption = { name: text(op?.name), tradeoffs: text(op?.tradeoffs) }
      if (op?.pr === true) out.pr = true
      if (!out.name) errors.push(`direction.options[${i}]: name is required`)
      if (!out.tradeoffs) errors.push(`direction.options[${i}] (${out.name}): tradeoffs is required, one line`)
      return out
    }),
    facts: list(d.facts).map((c, i) => claim(c, `direction.facts[${i}]`)),
    references: list(d.references).map((c, i) => claim(c, `direction.references[${i}]`)),
  }
  const problem = list(r.problem).map((c, i): CriterionClaim => {
    const what = `problem[${i}]`
    const status = text(c?.status) as CriterionStatus
    if (!CRITERION_STATUSES.includes(status)) errors.push(`${what}: status must be one of ${CRITERION_STATUSES.join(', ')}`)
    if (!text(c?.criterion)) errors.push(`${what}: criterion is required, the acceptance criterion as the ticket says it`)
    return { ...claim(c, what), criterion: text(c?.criterion), status }
  })
  const conventions = list(r.conventions).map((c, i): RuleClaim => {
    const what = `conventions[${i}]`
    const status = text(c?.status) as RuleStatus
    if (!RULE_STATUSES.includes(status)) errors.push(`${what}: status must be one of ${RULE_STATUSES.join(', ')}`)
    if (!text(c?.rule)) errors.push(`${what}: rule is required, the project rule it is about`)
    // A failed rule is a rule claim whatever the agent said; a passed one keeps its source.
    return { ...claim(c, what, status === 'fail' ? 'rule' : undefined), rule: text(c?.rule), status }
  })
  const risks = list(r.risks).map((c, i): RiskClaim => {
    const what = `risks[${i}]`
    const level = text(c?.level) as RiskLevel
    const kind = text(c?.kind) as RiskKind
    if (!RISK_LEVELS.includes(level)) errors.push(`${what}: level must be one of ${RISK_LEVELS.join(', ')}`)
    if (!RISK_KINDS.includes(kind)) errors.push(`${what}: kind must be one of ${RISK_KINDS.join(', ')}`)
    if (!text(c?.mechanism)) errors.push(`${what}: mechanism is required, how it goes wrong`)
    return { ...claim(c, what), level, kind, mechanism: text(c?.mechanism) }
  })
  const questions = list(r.questions).map((c, i) => claim(c, `questions[${i}]`, 'question'))
  const changes = list(r.changes).map((c, i): ReportChange => {
    const out: ReportChange = { title: text(c?.title), why: text(c?.why), units: strings(c?.units) }
    if (c?.routine === true) out.routine = true
    if (!out.title) errors.push(`changes[${i}]: title is required`)
    if (!out.why) errors.push(`changes[${i}] (${out.title}): why is required, why it matters`)
    return out
  })
  const checks = text(r.checks) as ChecksVerdict
  if (!CHECKS_VERDICTS.includes(checks)) errors.push(`checks must be one of ${CHECKS_VERDICTS.join(', ')}`)
  return { report: { direction, problem, conventions, risks, questions, changes, checks }, errors }
}

/** Every claim of a report with where it is, in page order. */
export function reportClaims(report: ReviewReport): { block: string; claim: Claim }[] {
  const d = report.direction
  return [
    ...d.decisions.map((claim) => ({ block: 'direction.decisions', claim })),
    ...d.facts.map((claim) => ({ block: 'direction.facts', claim })),
    ...d.references.map((claim) => ({ block: 'direction.references', claim })),
    ...report.problem.map((claim) => ({ block: 'problem', claim })),
    ...report.conventions.map((claim) => ({ block: 'conventions', claim })),
    ...report.risks.map((claim) => ({ block: 'risks', claim })),
    ...report.questions.map((claim) => ({ block: 'questions', claim })),
  ]
}

/** The checks verdict the claims give: Problem, Conventions and Risks only, never Direction. */
export function checksVerdict(report: Pick<ReviewReport, 'problem' | 'conventions' | 'risks'>): ChecksVerdict {
  if (report.conventions.some((c) => c.status === 'fail') || report.problem.some((c) => c.status === 'not') || report.risks.some((r) => r.level === 'high')) return 'request_changes'
  if (report.problem.some((c) => c.status === 'partly') || report.risks.some((r) => r.level === 'medium')) return 'look'
  return 'approve'
}

/**
 * What is wrong with a report against the review's inventory (empty: it may be stored): every claim cited; direction
 * with 2–4 options (a step's 1–4), exactly one the change's; 2–6 changes (fewer only with fewer units), every unit of
 * the inventory in exactly one change and no unknown unit; checks no milder than a failed rule, an unsolved criterion or
 * a high risk allow, and no stricter than approve without a finding behind it.
 */
export function checkReport(report: ReviewReport, inventory: ChangeInventory | null, kind: ReportKind = 'pr'): string[] {
  const errors: string[] = []
  for (const { block, claim } of reportClaims(report)) if (!claim.cites.length) errors.push(`${block}: "${claim.text}" cites nothing; cite inventory unit ids or file:line`)
  const d = report.direction
  if (!d.decisions.length) errors.push('direction.decisions: name the design decision(s) the change makes, one sentence each')
  const min = kind === 'step' ? 1 : 2
  if (d.options.length < min || d.options.length > 4) errors.push(`direction.options: ${min}–4 options, found ${d.options.length}${kind === 'pr' ? '; work them out before reading the author\'s description, the PR\'s own design is one of them' : ''}`)
  const own = d.options.filter((o) => o.pr).length
  if (own !== 1) errors.push(`direction.options: exactly one option is the change's (pr: true), found ${own}`)
  if (!inventory) {
    errors.push('There is no inventory yet: write it with set_inventory first; changes group its units')
  } else {
    const units = new Set(inventory.units.map((u) => u.id))
    const groups = report.changes
    const max = 6
    const least = Math.min(2, units.size)
    if (groups.length < least || groups.length > max) errors.push(`changes: ${least}–${max} changes by importance, found ${groups.length}`)
    if (groups.filter((c) => c.routine).length > 1) errors.push('changes: routine changes go in one row')
    const where = new Map<string, string[]>()
    for (const c of groups)
      for (const u of c.units) {
        if (!units.has(u)) errors.push(`changes (${c.title}): ${u} is no unit of the inventory`)
        else where.set(u, [...(where.get(u) ?? []), c.title])
      }
    for (const c of groups) if (!c.units.length) errors.push(`changes (${c.title}): no units`)
    const missing = [...units].filter((u) => !where.has(u))
    if (missing.length) errors.push(`changes: units in no change: ${missing.join(', ')}`)
    for (const [u, in_] of where) if (in_.length > 1) errors.push(`changes: ${u} is in ${in_.length} changes (${in_.join('; ')}); one each`)
  }
  const derived = checksVerdict(report)
  if (derived === 'request_changes' && report.checks !== 'request_changes')
    errors.push(`checks: ${report.checks} with a failed rule, a not-solved criterion or a high risk; it is request_changes`)
  if (derived === 'look' && report.checks === 'approve') errors.push('checks: approve with a partly solved criterion or a medium risk; it is look at most')
  if (report.checks !== 'approve' && !reportFindings(report).length)
    errors.push(`checks: ${report.checks} with nothing behind it; give the risk, rule or question behind it, or approve`)
  return errors
}

/**
 * The report with mag's checked badge: a mechanical fact of the direction (direction.facts) whose cites are all units
 * of the inventory mag verified (the units its hunks bear out). mag checks that the units are there, not that a
 * judgement is true, so every other claim keeps its source. The agent cannot give it.
 */
export function markChecked(report: ReviewReport, verified: Iterable<string>): ReviewReport {
  const ok = new Set(verified)
  const mark = (c: Claim): Claim => (c.source === 'agent' && c.cites.length && c.cites.every((x) => ok.has(x)) ? { ...c, source: 'checked' } : c)
  return { ...report, direction: { ...report.direction, facts: report.direction.facts.map(mark) } }
}

/** The step reviewer's routing verdict from the checks verdict: request_changes → changes, look → look, approve → merge. */
export function stepVerdict(checks: ChecksVerdict): ReviewVerdict {
  return checks === 'request_changes' ? 'changes' : checks === 'approve' ? 'merge' : 'look'
}

const LINE = /^[^\s:]+:\d+(?:-\d+)?$/
const RISK_FINDING: Record<RiskLevel, FindingLevel> = { high: 'blocker', medium: 'should_fix', low: 'nit' }

/**
 * The findings a report gives, for Publish and the developer's feedback: unsolved criteria, failed rules, risks and
 * questions, most severe first. where: the first file:line cite, else the first cite; node: the claim's view.
 */
export function reportFindings(report: ReviewReport): ReviewFinding[] {
  const finding = (c: Claim, level: FindingLevel, label: string): ReviewFinding => {
    const where = c.cites.find((x) => LINE.test(x)) ?? c.cites[0]
    return { text: `${label}${c.text}`, level, ...(where ? { where } : {}), ...(c.view ? { node: c.view } : {}) }
  }
  const out = [
    ...report.problem.filter((c) => c.status === 'not').map((c) => finding(c, 'blocker', `Problem: ${c.criterion}: not solved. `)),
    ...report.conventions.filter((c) => c.status === 'fail').map((c) => finding(c, 'blocker', `Convention: ${c.rule}: `)),
    ...report.risks.map((c) => finding({ ...c, text: `${c.text} (${c.mechanism})` }, RISK_FINDING[c.level], `Risk (${c.kind}): `)),
    ...report.problem.filter((c) => c.status === 'partly').map((c) => finding(c, 'should_fix', `Problem: ${c.criterion}: partly solved. `)),
    ...report.questions.map((c) => finding(c, 'question', '')),
  ]
  const rank: FindingLevel[] = ['blocker', 'should_fix', 'question', 'nit']
  return out.sort((a, b) => rank.indexOf(a.level!) - rank.indexOf(b.level!))
}

/** A chip of the verdict strip. */
export interface StripChip {
  key: 'direction' | 'problem' | 'conventions' | 'risks' | 'coverage'
  label: string
  value: string
  tone: 'good' | 'warn' | 'bad' | 'neutral'
}

/**
 * The verdict strip: direction (the user's call on a PR, the plan on a step), problem, conventions, risks and coverage
 * (the inventory against the hunks, from the stored fact).
 */
export function reportStrip(report: ReviewReport, fact: Pick<StepFact, 'counts'> | null | undefined, kind: ReportKind = 'pr'): StripChip[] {
  const solved = report.problem.filter((c) => c.status === 'solved').length
  const not = report.problem.filter((c) => c.status === 'not').length
  const failed = report.conventions.filter((c) => c.status === 'fail').length
  const high = report.risks.filter((r) => r.level === 'high').length
  const medium = report.risks.filter((r) => r.level === 'medium').length
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const gaps = fact ? fact.counts.unaccounted + fact.counts.ungrounded : null
  return [
    { key: 'direction', label: 'Direction', value: kind === 'step' ? 'the approved plan' : report.decided ? choiceLine(report.decided) : 'your call', tone: report.decided?.choice === 'prefer' ? 'bad' : report.decided?.choice === 'discuss' ? 'warn' : report.decided ? 'good' : 'neutral' },
    {
      key: 'problem',
      label: 'Problem',
      value: report.problem.length ? `${solved}/${report.problem.length} solved` : 'no criteria',
      tone: !report.problem.length ? 'neutral' : not ? 'bad' : solved < report.problem.length ? 'warn' : 'good',
    },
    { key: 'conventions', label: 'Conventions', value: failed ? `${failed} failed` : report.conventions.length ? 'pass' : 'none checked', tone: failed ? 'bad' : report.conventions.length ? 'good' : 'neutral' },
    {
      key: 'risks',
      label: 'Risks',
      value: high ? `${plural(high, 'high')}${medium ? ` · ${medium} medium` : ''}` : medium ? `${medium} medium` : report.risks.length ? plural(report.risks.length, 'low') : 'none',
      tone: high ? 'bad' : medium ? 'warn' : 'good',
    },
    { key: 'coverage', label: 'Coverage', value: gaps === null ? 'no fact' : gaps ? `${plural(gaps, 'gap')} in the inventory` : 'every block in the inventory', tone: gaps === null ? 'neutral' : gaps ? 'warn' : 'good' },
  ]
}

/** The changes table: the important rows, and the routine ones folded into one row at the end. */
export function reportChanges(report: Pick<ReviewReport, 'changes'>): { rows: ReportChange[]; routine: ReportChange | null } {
  return { rows: report.changes.filter((c) => !c.routine), routine: report.changes.find((c) => c.routine) ?? null }
}

/** "Request changes · Direction: your call" (or the user's call once made: "Direction: Prefer X"), the line of a ready review. */
export function reportLine(report: Pick<ReviewReport, 'checks' | 'decided'>, kind: ReportKind = 'pr'): string {
  return `${CHECKS_LABELS[report.checks]}${kind === 'pr' ? ` · Direction: ${report.decided ? choiceLine(report.decided).replace(/^Direction /, '') : 'your call'}` : ''}`
}

export type Tone = StripChip['tone']

/** A row of a question card: the claim, what it is about and its status. */
export interface ReportRow {
  claim: Claim
  /** The criterion, the rule, or the risk's kind and mechanism. */
  about?: string
  status?: string
  tone: Tone
}

/** A question card of the page, in order: Problem, Conventions, Risks, Open questions. */
export interface ReportCard {
  key: 'problem' | 'conventions' | 'risks' | 'questions'
  title: string
  question: string
  rows: ReportRow[]
}

const CRITERION_TONES: Record<CriterionStatus, Tone> = { solved: 'good', partly: 'warn', not: 'bad' }
const RISK_TONES: Record<RiskLevel, Tone> = { high: 'bad', medium: 'warn', low: 'neutral' }

/** The design decision(s) of a report as one line: what a direction decision is about. */
export function reportDecision(report: Pick<ReviewReport, 'direction'>): string {
  return report.direction.decisions.map((c) => c.text.replace(/\.$/, '')).join('; ')
}

/** The user prefers another option than the PR's: its detailed findings fold on the page. */
export function findingsFolded(report: Pick<ReviewReport, 'decided'> | undefined): boolean {
  return report?.decided?.choice === 'prefer'
}

/** What the call says, in a few words: "Direction OK", "Prefer <option>", "Ask the author". */
export function choiceLine(d: Pick<DirectionDecision, 'choice' | 'option'>): string {
  return d.choice === 'prefer' ? `Prefer ${d.option}` : DIRECTION_CHOICE_LABELS[d.choice]
}

/** The line a direction decision appends to the project's notes: "- Direction <PR>: <decision> → Prefer X (principle)". */
export function decisionNote(d: DirectionDecision): string {
  return `- Direction ${d.pr}: ${d.decision} → ${choiceLine(d)}${d.principle ? ` (${d.principle})` : ''}`
}

/**
 * The user's earlier direction decisions for a reviewer's prompt, newest first (at most `max`), each with the id it is
 * cited by; empty without any.
 */
export function decisionsBlock(decisions: DirectionDecision[] | undefined, max = 20): string {
  const list = [...(decisions ?? [])].sort((a, b) => b.at - a.at).slice(0, max)
  if (!list.length) return ''
  return `The user's earlier direction decisions (newest first). Where one bears on this change's direction, put it in direction.references with source yours, citing decision:<id>:
${list.map((d) => `- decision:${d.id}: ${d.pr}: ${d.decision} → ${choiceLine(d)}${d.principle ? `; principle: ${d.principle}` : ''}`).join('\n')}`
}

const DECISION_CITE = /^decision:(\S+)$/

/** The decision:<id> cites of a report that name no decision of the project. */
export function unknownDecisions(report: ReviewReport, decisions: DirectionDecision[] | undefined): string[] {
  const ids = new Set((decisions ?? []).map((d) => d.id))
  return reportClaims(report)
    .flatMap(({ claim }) => claim.cites)
    .flatMap((c) => DECISION_CITE.exec(c)?.[1] ?? [])
    .filter((id) => !ids.has(id))
}

/** A reference of the direction card with the user's earlier decisions it cites. */
export interface DirectionReference {
  claim: Claim
  decisions: DirectionDecision[]
}

/** The direction's references, those citing an earlier decision of the user (decision:<id>) as yours, with it. */
export function directionReferences(report: Pick<ReviewReport, 'direction'>, decisions: DirectionDecision[] | undefined): DirectionReference[] {
  const byId = new Map((decisions ?? []).map((d) => [d.id, d]))
  return report.direction.references.map((claim) => {
    const cited = claim.cites.flatMap((c) => byId.get(DECISION_CITE.exec(c)?.[1] ?? '') ?? [])
    return { claim: cited.length ? { ...claim, source: 'yours' } : claim, decisions: cited }
  })
}

/**
 * The comment to the author a call drafts when the agent did not word one: prefer, the option with its trade-offs against
 * the PR's; discuss, the report's open questions and why this option over the others. Empty for ok.
 */
export function directionDraft(report: Pick<ReviewReport, 'direction' | 'questions'>, d: Pick<DirectionDecision, 'choice' | 'option' | 'principle'>): string {
  const own = report.direction.options.find((o) => o.pr)
  const why = d.principle ? `\n\n${d.principle}` : ''
  if (d.choice === 'prefer') {
    const o = report.direction.options.find((x) => x.name === d.option)
    return `I'd rather go with ${d.option} than ${own?.name ?? 'the approach here'}${o ? `: ${o.tradeoffs}` : ''}.${why}`
  }
  if (d.choice === 'discuss') {
    const others = report.direction.options.filter((o) => !o.pr).map((o) => o.name)
    const asks = [...(own && others.length ? [`Why ${own.name} over ${others.join(' or ')}?`] : []), ...report.questions.map((q) => q.text)]
    return `${asks.map((q) => `- ${q}`).join('\n')}${why}`
  }
  return ''
}

/** The direction card as text: what the review's topic gets when the user wants to discuss the direction. */
export function directionCardText(report: Pick<ReviewReport, 'direction'>, decisions: DirectionDecision[] | undefined): string {
  const d = report.direction
  const claim = (c: Claim) => `- [${c.source}] ${c.text}${c.cites.length ? ` (${c.cites.join(', ')})` : ''}`
  const refs = directionReferences(report, decisions).map((r) => `${claim(r.claim)}${r.decisions.map((x) => `\n  earlier: ${decisionNote(x).slice(2)}`).join('')}`)
  return [
    `Decision${d.decisions.length > 1 ? 's' : ''}:\n${d.decisions.map(claim).join('\n')}`,
    `Options:\n${d.options.map((o) => `- ${o.name}${o.pr ? " (the PR's)" : ''}: ${o.tradeoffs}`).join('\n')}`,
    d.facts.length ? `Facts:\n${d.facts.map(claim).join('\n')}` : '',
    refs.length ? `References:\n${refs.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The question cards of a report; a failed rule and the worst risks first within their card. */
export function reportCards(report: ReviewReport): ReportCard[] {
  const byRisk = [...report.risks].sort((a, b) => RISK_LEVELS.indexOf(a.level) - RISK_LEVELS.indexOf(b.level))
  const byRule = [...report.conventions].sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1))
  return [
    { key: 'problem', title: 'Problem', question: 'Does it solve the ticket?', rows: report.problem.map((c) => ({ claim: c, about: c.criterion, status: c.status, tone: CRITERION_TONES[c.status] })) },
    { key: 'conventions', title: 'Conventions', question: "Does it keep the project's rules?", rows: byRule.map((c) => ({ claim: c, about: c.rule, status: c.status, tone: c.status === 'fail' ? 'bad' : 'good' })) },
    { key: 'risks', title: 'Risks', question: 'What can go wrong?', rows: byRisk.map((c) => ({ claim: c, about: `${c.kind}: ${c.mechanism}`, status: c.level, tone: RISK_TONES[c.level] })) },
    { key: 'questions', title: 'Open questions', question: 'What the author should answer', rows: report.questions.map((c) => ({ claim: c, tone: 'neutral' })) },
  ]
}
