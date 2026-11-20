// The review report. Today's (review-v3-concise-design-first.1): one list of issues, each once with its severity, who
// decides and a ready PR comment; acceptance criteria with their evidence; what was verified and what was not; the
// direction only when no design or decision settles it. One before it (review-v2-questions-first-direction.1, a
// LegacyReport) answered fixed questions (direction, problem, conventions, risks, changes) and still renders as it was.
// The verdict is the reviewer's, raised by mag only to its own floors (prompts-use-the-models-to.1). Shared by the
// review of a step and of a teammate's PR; a stored review without a report is older still and renders as before.

import { isDataUnit, unitEntity, unitLeaf, type ChangeInventory } from './inventory.ts'
import { parseFlowRef, type Diagram } from './diagram.ts'
import type { FindingLevel } from './pr-review.ts'
import type { ReviewFinding, ReviewVerdict, StepFact } from './index.ts'

/**
 * Where a claim comes from. checked: mag verified it against the inventory (set by mag only); agent: the reviewer's
 * reading, with code refs; yours: the user's own words (PR comments, notes, decisions); question: open, the author
 * answers; rule: a project rule fails.
 */
export type ClaimSource = 'checked' | 'agent' | 'yours' | 'question' | 'rule'

export const CLAIM_SOURCES: ClaimSource[] = ['checked', 'agent', 'yours', 'question', 'rule']

/**
 * The sources a reviewer gives (prompts-use-the-models-to.5, audit F9): user for the user's own words, stored as yours,
 * since "yours" read from the agent's side as its own; yours itself is still taken. checked is mag's.
 */
export const AGENT_SOURCES = ['agent', 'user', 'question', 'rule'] as const

/** A source as a reviewer gives it, as stored. */
const storedSource = (given: string): ClaimSource => (given === 'user' ? 'yours' : (given as ClaimSource))

export interface Claim {
  text: string
  /** Its essence for the user, one short line, when it becomes a finding; the text is its comment on the PR. */
  summary?: string
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

export type Confidence = 'high' | 'medium' | 'low'
export const CONFIDENCES: Confidence[] = ['high', 'medium', 'low']

/**
 * The reviewer's own leaning on the direction (prompts-use-the-models-to.1): an opinion with its own field, so an honest
 * view never has to bend the rest of the report. It never affects the checks verdict, and the user sees it folded after
 * the options, once they could form their own view.
 */
export interface DirectionView {
  /** The name of the option it leans to. */
  leaning: string
  why: string
  confidence: Confidence
}

/** The design decision(s) the change makes and what the user needs to decide on it. The call is the user's. */
export interface Direction {
  /** One sentence each. */
  decisions: Claim[]
  /** 1–N, exactly one of them the change's; a single option says why there is no other (only). */
  options: DirectionOption[]
  /** With a single option: why it is the only sensible one ("only one, because…"). */
  only?: string
  /** Mechanical facts about the change's option: modules that learn the new concept, existing flows hit, new violations. */
  facts: Claim[]
  /** Project notes, ADRs, CLAUDE.md rules, earlier decisions of the user, PR threads. */
  references: Claim[]
  view?: DirectionView
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

/**
 * The verdict: the reviewer's, never below mag's floor; strictest first. approve_with_comments: mergeable, its issues
 * are should, nit or note (an issues report only).
 */
export type ChecksVerdict = 'request_changes' | 'look' | 'approve_with_comments' | 'approve'
export const CHECKS_VERDICTS: ChecksVerdict[] = ['request_changes', 'look', 'approve_with_comments', 'approve']
export const CHECKS_LABELS: Record<ChecksVerdict, string> = { request_changes: 'Request changes', look: 'Look', approve_with_comments: 'Approve with comments', approve: 'Approve' }

/** How much an issue matters. blocker: must not merge; should: fix before merge unless argued; nit: optional; note: no action. */
export type IssueSeverity = 'blocker' | 'should' | 'nit' | 'note'
export const ISSUE_SEVERITIES: IssueSeverity[] = ['blocker', 'should', 'nit', 'note']

/** What an issue is about. */
export type IssueKind = 'bug' | 'data' | 'security' | 'ops' | 'acceptance' | 'design' | 'scope' | 'tests' | 'convention' | 'naming' | 'docs' | 'question'
export const ISSUE_KINDS: IssueKind[] = ['bug', 'data', 'security', 'ops', 'acceptance', 'design', 'scope', 'tests', 'convention', 'naming', 'docs', 'question']
/**
 * The kinds that may block a merge: what breaks for users, data, security or production, and missing or unmet
 * acceptance criteria. Never conventions, naming, docs or ticket wording.
 */
export const BLOCKER_KINDS: IssueKind[] = ['bug', 'data', 'security', 'ops', 'acceptance']

/** Who decides an issue: the PR's author, the product owner (scope, the ticket), the user. */
export type IssueOwner = 'author' | 'po' | 'user'
export const ISSUE_OWNERS: IssueOwner[] = ['author', 'po', 'user']

/** One problem of the change, said once. */
export interface Issue {
  /** Its essence, one short line. */
  title: string
  /** What goes wrong and for whom. */
  impact: string
  kind: IssueKind
  severity: IssueSeverity
  owner: IssueOwner
  /** The comment to post on the PR as it is: to the author, what to change and why. */
  comment: string
  /** file:line (or path:12-20, repo:path:12); none for an issue of the whole change. */
  where?: string
  /** Who already raised it in the PR's threads (@login): not new, not published by default. */
  raisedBy?: string
}

/** Where acceptance criteria were found: the PR, its ticket, the design (the doc, a step's plan), or nowhere. */
export type CriteriaSource = 'pr' | 'ticket' | 'design' | 'none'
export const CRITERIA_SOURCES: CriteriaSource[] = ['pr', 'ticket', 'design', 'none']

export type EvidenceStatus = 'met' | 'partly' | 'not' | 'unverified'
export const EVIDENCE_STATUSES: EvidenceStatus[] = ['met', 'partly', 'not', 'unverified']

/** An acceptance criterion and what shows the change meets it. */
export interface AcceptanceItem {
  criterion: string
  source: CriteriaSource
  /** A test by name, a CI check, a check the reviewer ran; for unverified, what would verify it. */
  evidence: string
  status: EvidenceStatus
}

/** The review report as issues and evidence (review-v3-concise-design-first.1). */
export interface IssuesReport {
  /** What the change does and why, one paragraph, shown first. */
  intent: string
  /** The verdict that stands: the reviewer's, or mag's floor when that is stricter (finalVerdict). */
  checks: ChecksVerdict
  /** The reviewer's one line on why. */
  why: string
  /** Ranked by impact, each problem once. */
  issues: Issue[]
  acceptance: AcceptanceItem[]
  /** A config, version or typo change: no criteria needed. */
  trivial?: boolean
  /** What the reviewer verified: earlier threads (fixed / open), CI, tests run. */
  verified: string[]
  /** What the verdict does not cover. */
  notChecked: string[]
  /** Only when no design or decision has settled it; the call is the user's. */
  direction?: Direction
  /** Otherwise: what settles it, one line ("the approved plan", "decision:<id>", "ADR-4"). */
  follows?: string
  /** The one diagram that shows the essence (the system view or a scenario): its canvas id. */
  diagram?: string
  /** The reviewer's conclusion and advice, one paragraph, shown last. */
  conclusion: string
  /** mag's floor when it has blockers: they are attached to the review, the reviewer does not restate them. */
  floor?: VerdictFloor
  /** The reviewer's own verdict when mag's floor raised it. */
  raisedFrom?: ChecksVerdict
  /** The user's call on the direction (a PR's review with a direction only). */
  decided?: DirectionDecision
  /** The comment to the author drafted with the call. */
  draft?: string
}

/** A stored review report: today's (issues) or one from before it (legacy), which renders as it was. */
export type ReviewReport = IssuesReport | LegacyReport

/** A report of today's form: issues and evidence. */
export const isIssuesReport = (r: ReviewReport | null | undefined): r is IssuesReport => !!r && Array.isArray((r as IssuesReport).issues)

/** A report as stored before review-v3-concise-design-first.1: answers to fixed questions. Only rendered now. */
export interface LegacyReport {
  /** What the change does and why, one paragraph, shown first; missing on a report from before it was asked. */
  intent?: string
  direction: Direction
  problem: CriterionClaim[]
  conventions: RuleClaim[]
  risks: RiskClaim[]
  /** To the author. */
  questions: Claim[]
  /** In order of importance; the routine row last. */
  changes: ReportChange[]
  /** The verdict that stands: the reviewer's, or mag's floor when that is stricter (finalVerdict). */
  checks: ChecksVerdict
  /** The reviewer's one line on why; missing on a report from before prompts-use-the-models-to.1. */
  why?: string
  /** mag's floor when it has blockers: they are attached to the review, the reviewer does not restate them. */
  floor?: VerdictFloor
  /** The reviewer's own verdict when mag's floor raised it. */
  raisedFrom?: ChecksVerdict
  /** The user's call on the direction of this review (review-v2-questions-first-direction.2); a PR's review only. */
  decided?: DirectionDecision
  /** The comment to the author drafted with the call: the preferred option (prefer) or questions (discuss). */
  draft?: string
  /** The reviewer's conclusion and advice, one paragraph, shown last; missing on a report from before it was asked. */
  conclusion?: string
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

/** The reviewer's checks verdict with its one line of why. */
export interface AgentChecks {
  verdict: ChecksVerdict
  why: string
}

/**
 * What only mag knows and owns about the change under review: plan deviations and an incomplete fact (plan ↔ fact's
 * blockers), failed CI checks, failed architecture rules. Each a line of what is wrong.
 */
export interface MagFloors {
  deviations: string[]
  ci: string[]
  rules: string[]
}

/** The mildest verdict mag allows and why: its blockers, in words; approve with none. */
export interface VerdictFloor {
  verdict: ChecksVerdict
  blockers: string[]
}

/**
 * mag's floor from what it owns: a failed CI check or architecture rule is request_changes (the developer must fix it
 * before anyone looks); a plan deviation or an incomplete fact is look (the user decides whether the plan or the code
 * is right); otherwise approve.
 */
export function verdictFloor(floors: MagFloors): VerdictFloor {
  const blockers = [...floors.ci.map((c) => `CI failed: ${c}`), ...floors.rules.map((r) => `Architecture rule failed: ${r}`), ...floors.deviations]
  const verdict: ChecksVerdict = floors.ci.length || floors.rules.length ? 'request_changes' : floors.deviations.length ? 'look' : 'approve'
  return { verdict, blockers }
}

/** The verdict that stands: the reviewer's, unless mag's floor is stricter. */
export function finalVerdict(checks: Pick<AgentChecks, 'verdict'>, floor: VerdictFloor): ChecksVerdict {
  return CHECKS_VERDICTS.indexOf(floor.verdict) < CHECKS_VERDICTS.indexOf(checks.verdict) ? floor.verdict : checks.verdict
}

/** The report with mag's floor applied: its verdict (finalVerdict), its blockers attached and the reviewer's verdict kept when raised. */
export function withFloor<R extends ReviewReport>(report: R, floor: VerdictFloor): R {
  const { floor: _, raisedFrom: __, ...rest } = report
  // A report mag raised before keeps the reviewer's own verdict in raisedFrom.
  const agent = report.raisedFrom ?? report.checks
  const checks = finalVerdict({ verdict: agent }, floor)
  return { ...rest, checks, ...(floor.blockers.length ? { floor } : {}), ...(checks !== agent ? { raisedFrom: agent } : {}) } as R
}

/** Which review a report is of: a step's (direction is the approved plan) or a teammate's PR (direction is the user's call). */
export type ReportKind = 'step' | 'pr'

type Raw = Record<string, unknown>
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : [])
/** The longest intent or conclusion a reader takes in at a glance. */
const PARAGRAPH_MAX = 600

/** What is wrong with a one-paragraph field: empty, too long, or more than a paragraph (blank lines, a list). */
function paragraphErrors(value: string, what: string, about: string): string[] {
  if (!value) return [`${what} is required: one paragraph, ${about}`]
  const errors: string[] = []
  if (value.length > PARAGRAPH_MAX) errors.push(`${what}: ${value.length} characters; one concise paragraph, up to ${PARAGRAPH_MAX}`)
  if (/\n\s*\n|^\s*([-*+•]|\d+[.)])\s/m.test(value)) errors.push(`${what}: one paragraph, no blank lines or lists`)
  return errors
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : [])

/** `path:12`, `path:12-30`, `repo:path:12`: where an issue is. */
const WHERE = /^(?:[^\s:]+:)?[^\s:]+:\d+(?:-\d+)?$/

/** A claim of the direction from what an agent passed; a source of checked is read as agent (only mag sets it). */
function readClaim(c: Raw, what: string, errors: string[]): Claim {
  const given = storedSource(text(c?.source) || 'agent')
  const out: Claim = { text: text(c?.text), source: given === 'checked' ? 'agent' : given, cites: strings(c?.cites) }
  if (!out.text) errors.push(`${what}: text is required`)
  if (!(CLAIM_SOURCES as string[]).includes(given)) errors.push(`${what}: source must be one of ${AGENT_SOURCES.join(', ')} (checked is mag's)`)
  if (text(c?.view)) out.view = text(c.view)
  if (text(c?.summary)) out.summary = text(c.summary)
  return out
}

/** The direction from what an agent passed. A verdict on it is refused: the reviewer's leaning goes in view. */
function readDirection(d: Raw, errors: string[]): Direction {
  for (const k of ['verdict', 'ok', 'recommendation', 'choice'])
    if (d[k] !== undefined) errors.push(`direction has no ${k}: the direction is the user's call; give your leaning in direction.view { leaning, why, confidence }`)
  const direction: Direction = {
    decisions: list(d.decisions).map((c, i) => readClaim(typeof c === 'string' ? { text: c, source: 'agent' } : c, `direction.decisions[${i}]`, errors)),
    options: list(d.options).map((op, i) => {
      const out: DirectionOption = { name: text(op?.name), tradeoffs: text(op?.tradeoffs) }
      if (op?.pr === true) out.pr = true
      if (!out.name) errors.push(`direction.options[${i}]: name is required`)
      if (!out.tradeoffs) errors.push(`direction.options[${i}] (${out.name}): tradeoffs is required, one line`)
      return out
    }),
    facts: list(d.facts).map((c, i) => readClaim(c, `direction.facts[${i}]`, errors)),
    references: list(d.references).map((c, i) => readClaim(c, `direction.references[${i}]`, errors)),
  }
  if (text(d.only)) direction.only = text(d.only)
  if (d.view != null) {
    const v = (typeof d.view === 'object' && !Array.isArray(d.view) ? d.view : {}) as Raw
    const view: DirectionView = { leaning: text(v.leaning), why: text(v.why), confidence: text(v.confidence) as Confidence }
    if (!view.leaning) errors.push('direction.view: leaning is required, the name of the option you lean to')
    else if (!direction.options.some((o) => o.name === view.leaning)) errors.push(`direction.view: leaning "${view.leaning}" is no option's name`)
    if (!view.why) errors.push('direction.view: why is required')
    if (!CONFIDENCES.includes(view.confidence)) errors.push(`direction.view: confidence must be one of ${CONFIDENCES.join(', ')}`)
    direction.view = view
  }
  return direction
}

/** The fields of the report before review-v3-concise-design-first.1, refused with what replaces them. */
const OLD_FIELDS: Record<string, string> = {
  problem: 'use acceptance (criterion → evidence)',
  conventions: 'use issues (only what is wrong, no pass list)',
  risks: 'use issues',
  questions: 'use issues of kind question',
  changes: 'drop it: mag keeps the inventory itself',
  checks: 'use verdict and why',
}

/**
 * A report from what an agent passed (an object or its JSON), with what is wrong in its shape: issues each with its
 * kind, severity, owner and ready comment, where a file:line (never an inventory unit id); a blocker only of a kind that
 * may block; acceptance criteria with source, evidence and status; the direction only when unsettled.
 */
export function normalizeReport(raw: unknown): { report: IssuesReport; errors: string[] } {
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
  for (const [k, instead] of Object.entries(OLD_FIELDS)) if (r[k] !== undefined) errors.push(`${k}: the report has no ${k}; ${instead}`)
  const issues = list(r.issues).map((x, i): Issue => {
    const what = `issues[${i}]`
    const issue: Issue = {
      title: text(x?.title),
      impact: text(x?.impact),
      kind: text(x?.kind) as IssueKind,
      severity: text(x?.severity) as IssueSeverity,
      owner: text(x?.owner) as IssueOwner,
      comment: text(x?.comment),
    }
    if (!issue.title) errors.push(`${what}: title is required, its essence in one line`)
    if (!issue.impact) errors.push(`${what} (${issue.title}): impact is required, what goes wrong and for whom`)
    if (!issue.comment) errors.push(`${what} (${issue.title}): comment is required, the PR comment as it is posted`)
    if (!ISSUE_KINDS.includes(issue.kind)) errors.push(`${what} (${issue.title}): kind must be one of ${ISSUE_KINDS.join(', ')}`)
    if (!ISSUE_SEVERITIES.includes(issue.severity)) errors.push(`${what} (${issue.title}): severity must be one of ${ISSUE_SEVERITIES.join(', ')}`)
    else if (issue.severity === 'blocker' && ISSUE_KINDS.includes(issue.kind) && !BLOCKER_KINDS.includes(issue.kind))
      errors.push(`${what} (${issue.title}): a ${issue.kind} issue is never a blocker (only ${BLOCKER_KINDS.join(', ')}); make it should, nit or note`)
    if (!ISSUE_OWNERS.includes(issue.owner)) errors.push(`${what} (${issue.title}): owner must be one of ${ISSUE_OWNERS.join(', ')}, who decides it`)
    const where = text(x?.where)
    if (where) {
      if (WHERE.test(where)) issue.where = where
      else errors.push(`${what} (${issue.title}): where "${where}" is no file:line; give path:line (an inventory unit id or a module is not one), or leave it out for an issue of the whole change`)
    }
    const raisedBy = text(x?.raisedBy)
    if (raisedBy) issue.raisedBy = raisedBy
    return issue
  })
  const acceptance = list(r.acceptance).map((x, i): AcceptanceItem => {
    const what = `acceptance[${i}]`
    const item: AcceptanceItem = { criterion: text(x?.criterion), source: text(x?.source) as CriteriaSource, evidence: text(x?.evidence), status: text(x?.status) as EvidenceStatus }
    if (!item.criterion) errors.push(`${what}: criterion is required, as its source says it`)
    if (!CRITERIA_SOURCES.includes(item.source)) errors.push(`${what}: source must be one of ${CRITERIA_SOURCES.join(', ')}`)
    if (!item.evidence) errors.push(`${what}: evidence is required: a test by name, a CI check, a check you ran; for unverified, what would verify it`)
    if (!EVIDENCE_STATUSES.includes(item.status)) errors.push(`${what}: status must be one of ${EVIDENCE_STATUSES.join(', ')}`)
    return item
  })
  const checks = text(r.verdict) as ChecksVerdict
  const why = text(r.why)
  if (!CHECKS_VERDICTS.includes(checks)) errors.push(`verdict must be one of ${CHECKS_VERDICTS.join(', ')}`)
  if (!why) errors.push('why is required: one line on why this verdict')
  const intent = text(r.intent)
  const conclusion = text(r.conclusion)
  errors.push(...paragraphErrors(intent, 'intent', 'what the change does and why, for a human (not how)'))
  errors.push(...paragraphErrors(conclusion, 'conclusion', 'your conclusion and advice: what to publish, whom to ask'))
  const report: IssuesReport = { intent, checks, why, issues, acceptance, verified: strings(r.verified), notChecked: strings(r.notChecked), conclusion }
  if (r.trivial === true) report.trivial = true
  if (r.direction != null) {
    if (typeof r.direction === 'object' && !Array.isArray(r.direction)) report.direction = readDirection(r.direction as Raw, errors)
    else errors.push('direction must be an object: decisions, options, facts, references')
  }
  if (text(r.follows)) report.follows = text(r.follows)
  const diagram = text(r.diagram).replace(/^canvas:/, '').replace(/#.*$/, '')
  if (diagram) report.diagram = diagram
  return { report, errors }
}

/** Every claim of a report with where it is, in page order: an issues report's are its direction's. */
export function reportClaims(report: ReviewReport): { block: string; claim: Claim }[] {
  const d = report.direction
  const direction = d
    ? [
        ...d.decisions.map((claim) => ({ block: 'direction.decisions', claim })),
        ...d.facts.map((claim) => ({ block: 'direction.facts', claim })),
        ...d.references.map((claim) => ({ block: 'direction.references', claim })),
      ]
    : []
  if (isIssuesReport(report)) return direction
  return [
    ...direction,
    ...report.problem.map((claim) => ({ block: 'problem', claim })),
    ...report.conventions.map((claim) => ({ block: 'conventions', claim })),
    ...report.risks.map((claim) => ({ block: 'risks', claim })),
    ...report.questions.map((claim) => ({ block: 'questions', claim })),
  ]
}

/** Whether a report's criteria come from somewhere: at least one of the PR, its ticket or the design. */
export const hasCriteria = (report: Pick<IssuesReport, 'acceptance'>): boolean => report.acceptance.some((a) => a.source !== 'none')

/**
 * What is wrong with a report (empty: it may be stored): a mergeable verdict without a blocker, request_changes with
 * something to fix; a non-trivial change without criteria has its blocker; the direction either settled (follows) or
 * laid out (direction: decisions, at least one option, exactly one the change's, a single one with why), every claim of
 * it cited. Counts beyond that are the reviewer's judgment.
 */
export function checkReport(report: IssuesReport): string[] {
  const errors: string[] = []
  const blockers = report.issues.filter((i) => i.severity === 'blocker')
  if ((report.checks === 'approve' || report.checks === 'approve_with_comments') && blockers.length)
    errors.push(`verdict: ${report.checks} with ${blockers.length} blocker${blockers.length > 1 ? 's' : ''} (${blockers.map((b) => b.title).join('; ')}); request_changes, or lower it and say why`)
  if (report.checks === 'request_changes' && !report.issues.some((i) => i.severity === 'blocker' || i.severity === 'should'))
    errors.push('verdict: request_changes with nothing to fix; give the blocker or should issue behind it')
  if (report.checks === 'approve' && report.issues.some((i) => !i.raisedBy && (i.severity === 'should' || i.severity === 'nit')))
    errors.push('verdict: approve with should or nit issues of your own; that is approve_with_comments')
  if (!report.trivial && !hasCriteria(report) && !blockers.some((i) => i.kind === 'acceptance'))
    errors.push('acceptance: no criteria in the PR, its ticket or the design; for a change of behaviour that is a blocker issue of kind acceptance (ask for them), or set trivial: true for a config, version or typo change')
  const d = report.direction
  if (d && report.follows) errors.push('direction and follows: one of them; follows when a design or decision settles the direction, direction when nothing does')
  if (!d && !report.follows) errors.push('follows: what settles the direction, one line (the approved plan, a decision, the ticket\'s design); or direction when nothing does')
  if (d) {
    for (const { block, claim } of reportClaims(report)) if (!claim.cites.length) errors.push(`${block}: "${claim.text}" cites nothing; cite file:line, a PR comment, decision:<id> or a note`)
    if (!d.decisions.length) errors.push('direction.decisions: name the design decision(s) the change makes, one sentence each')
    if (!d.options.length) errors.push("direction.options: at least the change's own option")
    if (d.options.length === 1 && !d.only) errors.push('direction.only: with a single option, say why it is the only sensible one ("only one, because…")')
    const own = d.options.filter((o) => o.pr).length
    if (own !== 1) errors.push(`direction.options: exactly one option is the change's (pr: true), found ${own}`)
  }
  return errors
}

/**
 * The report with mag's checked badge: a mechanical fact of the direction (direction.facts) whose cites are all units
 * of the inventory mag verified (the units its hunks bear out). mag checks that the units are there, not that a
 * judgement is true, so every other claim keeps its source. The agent cannot give it.
 */
export function markChecked<R extends ReviewReport>(report: R, verified: Iterable<string>): R {
  if (!report.direction) return report
  const ok = new Set(verified)
  const mark = (c: Claim): Claim => (c.source === 'agent' && c.cites.length && c.cites.every((x) => ok.has(x)) ? { ...c, source: 'checked' } : c)
  return { ...report, direction: { ...report.direction, facts: report.direction.facts.map(mark) } }
}

/**
 * The step reviewer's routing verdict: request_changes → changes, look → look, approve and approve_with_comments →
 * merge (its issues show with the review).
 */
export function stepVerdict(checks: ChecksVerdict): ReviewVerdict {
  return checks === 'request_changes' ? 'changes' : checks === 'look' ? 'look' : 'merge'
}

const LINE = /^[^\s:]+:\d+(?:-\d+)?$/
const RISK_FINDING: Record<RiskLevel, FindingLevel> = { high: 'blocker', medium: 'should_fix', low: 'nit' }
const SEVERITY_FINDING: Record<IssueSeverity, FindingLevel> = { blocker: 'blocker', should: 'should_fix', nit: 'nit', note: 'note' }

/** The finding an issue publishes as: its comment, its title as the summary; a question to the author is a question. One raised before is not picked. */
export function issueFinding(issue: Issue): ReviewFinding {
  const level = issue.kind === 'question' ? 'question' : SEVERITY_FINDING[issue.severity]
  return { text: issue.comment, summary: issue.title, level, ...(issue.where ? { where: issue.where } : {}), ...(issue.raisedBy ? { post: false } : {}) }
}

/**
 * The findings a report gives, for Publish and the developer's feedback: mag's blockers (its floor) first. An issues
 * report: its issues as they are, in their order. A legacy one: unsolved criteria, failed rules, risks and questions,
 * most severe first.
 */
export function reportFindings(report: ReviewReport): ReviewFinding[] {
  const floor = (report.floor?.blockers ?? []).map((b): ReviewFinding => ({ text: `mag: ${b}`, level: 'blocker' }))
  if (isIssuesReport(report)) return [...floor, ...report.issues.map(issueFinding)]
  const finding = (c: Claim, level: FindingLevel, label: string): ReviewFinding => {
    const where = c.cites.find((x) => LINE.test(x)) ?? c.cites[0]
    return { text: `${label}${c.text}`, level, ...(c.summary ? { summary: c.summary } : {}), ...(where ? { where } : {}), ...(c.view ? { node: c.view } : {}) }
  }
  const out: ReviewFinding[] = [
    ...floor,
    ...report.problem.filter((c) => c.status === 'not').map((c) => finding(c, 'blocker', `Problem: ${c.criterion}: not solved. `)),
    ...report.conventions.filter((c) => c.status === 'fail').map((c) => finding(c, 'blocker', `Convention: ${c.rule}: `)),
    ...report.risks.map((c) => finding({ ...c, text: `${c.text} (${c.mechanism})` }, RISK_FINDING[c.level], `Risk (${c.kind}): `)),
    ...report.problem.filter((c) => c.status === 'partly').map((c) => finding(c, 'should_fix', `Problem: ${c.criterion}: partly solved. `)),
    ...report.questions.map((c) => finding(c, 'question', '')),
  ]
  const rank: FindingLevel[] = ['blocker', 'should_fix', 'question', 'nit', 'note']
  return out.sort((a, b) => rank.indexOf(a.level!) - rank.indexOf(b.level!))
}

/** The issues shown before the rest fold. */
export const ISSUES_SHOWN = 5

/** The issues of a report as the page shows them: the first ISSUES_SHOWN, the rest folded; new ones are not raised before. */
export function issuesView(report: Pick<IssuesReport, 'issues'>): { shown: Issue[]; folded: Issue[]; fresh: number } {
  return { shown: report.issues.slice(0, ISSUES_SHOWN), folded: report.issues.slice(ISSUES_SHOWN), fresh: report.issues.filter((i) => !i.raisedBy).length }
}

/** The sources of a report's criteria, in their order, once each; "none" without any. */
export function criteriaSources(report: Pick<IssuesReport, 'acceptance'>): CriteriaSource[] {
  const found = CRITERIA_SOURCES.filter((s) => s !== 'none' && report.acceptance.some((a) => a.source === s))
  return found.length ? found : ['none']
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
export function reportStrip(report: LegacyReport, fact: Pick<StepFact, 'counts'> | null | undefined, kind: ReportKind = 'pr'): StripChip[] {
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
export function reportChanges(report: Pick<LegacyReport, 'changes'>): { rows: ReportChange[]; routine: ReportChange | null } {
  return { rows: report.changes.filter((c) => !c.routine), routine: report.changes.find((c) => c.routine) ?? null }
}

/**
 * "Request changes · Direction: your call" (or the user's call once made: "Direction: Prefer X"), the line of a ready
 * review; a PR's issues report says the direction only when it lays one out, else its count of issues.
 */
export function reportLine(report: ReviewReport, kind: ReportKind = 'pr'): string {
  const direction = ` · Direction: ${report.decided ? choiceLine(report.decided).replace(/^Direction /, '') : 'your call'}`
  if (!isIssuesReport(report)) return `${CHECKS_LABELS[report.checks]}${kind === 'pr' ? direction : ''}`
  const n = issuesView(report).fresh
  return `${CHECKS_LABELS[report.checks]}${n ? ` · ${n} issue${n > 1 ? 's' : ''}` : ''}${kind === 'pr' && report.direction ? direction : ''}`
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
  return (report.direction?.decisions ?? []).map((c) => c.text.replace(/\.$/, '')).join('; ')
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
  return `The user's earlier direction decisions (newest first). Where one bears on this change's direction, put it in direction.references with source user, citing decision:<id>:
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
  return (report.direction?.references ?? []).map((claim) => {
    const cited = claim.cites.flatMap((c) => byId.get(DECISION_CITE.exec(c)?.[1] ?? '') ?? [])
    return { claim: cited.length ? { ...claim, source: 'yours' } : claim, decisions: cited }
  })
}

/**
 * The comment to the author a call drafts when the agent did not word one: prefer, the option with its trade-offs against
 * the PR's; discuss, the report's open questions and why this option over the others. Empty for ok.
 */
export function directionDraft(report: ReviewReport, d: Pick<DirectionDecision, 'choice' | 'option' | 'principle'>): string {
  const options = report.direction?.options ?? []
  const own = options.find((o) => o.pr)
  const why = d.principle ? `\n\n${d.principle}` : ''
  if (d.choice === 'prefer') {
    const o = options.find((x) => x.name === d.option)
    return `I'd rather go with ${d.option} than ${own?.name ?? 'the approach here'}${o ? `: ${o.tradeoffs}` : ''}.${why}`
  }
  if (d.choice === 'discuss') {
    const others = options.filter((o) => !o.pr).map((o) => o.name)
    const questions = isIssuesReport(report) ? report.issues.filter((i) => i.kind === 'question').map((i) => i.comment) : report.questions.map((q) => q.text)
    const asks = [...(own && others.length ? [`Why ${own.name} over ${others.join(' or ')}?`] : []), ...questions]
    return `${asks.map((q) => `- ${q}`).join('\n')}${why}`
  }
  return ''
}

/** The direction card as text: what the review's topic gets when the user wants to discuss the direction. */
export function directionCardText(report: Pick<ReviewReport, 'direction'>, decisions: DirectionDecision[] | undefined): string {
  const d = report.direction
  if (!d) return ''
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
export function reportCards(report: LegacyReport): ReportCard[] {
  const byRisk = [...report.risks].sort((a, b) => RISK_LEVELS.indexOf(a.level) - RISK_LEVELS.indexOf(b.level))
  const byRule = [...report.conventions].sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1))
  return [
    { key: 'problem', title: 'Problem', question: 'Does it solve the ticket?', rows: report.problem.map((c) => ({ claim: c, about: c.criterion, status: c.status, tone: CRITERION_TONES[c.status] })) },
    { key: 'conventions', title: 'Conventions', question: "Does it keep the project's rules?", rows: byRule.map((c) => ({ claim: c, about: c.rule, status: c.status, tone: c.status === 'fail' ? 'bad' : 'good' })) },
    { key: 'risks', title: 'Risks', question: 'What can go wrong?', rows: byRisk.map((c) => ({ claim: c, about: `${c.kind}: ${c.mechanism}`, status: c.level, tone: RISK_TONES[c.level] })) },
    { key: 'questions', title: 'Open questions', question: 'What the author should answer', rows: report.questions.map((c) => ({ claim: c, tone: 'neutral' })) },
  ]
}

// The review window (review-v2-part-2-v1-2.2): every claim, diagram node and change row expands the code it rests on in
// place, and the full diff at the bottom is grouped by the report's changes.

/** A hunk of a changed file as the window has it (FileChange's, without its lines): H3, where it is. */
export interface PrHunk {
  id?: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

/** A changed file of the PR: its repository's name, path and numbered hunks. */
export interface PrFile {
  repo: string
  path: string
  oldPath?: string
  hunks: PrHunk[]
}

/** What expands its hunks: a claim (its cites), a node of a diagram, a change row (its units). */
export type HunkTarget =
  | { kind: 'claim'; cites: string[] }
  | { kind: 'node'; diagram: Diagram; node: string }
  | { kind: 'change'; units: string[] }

/** A hunk to show, with the blocks of it that are cited (`H3.2` → 2); null: all of it. */
export interface HunkPick<F extends PrFile = PrFile> {
  file: F
  hunk: PrHunk
  blocks: number[] | null
}

const HUNK_ID = /^(H\d+)(?:\.(\d+))?$/
/** `path:12`, `path:12-30`, `repo:path:12`. */
const FILE_LINE = /^(?:([^\s:]+):)?([^\s:]+):(\d+)(?:-(\d+))?$/

/**
 * The units of the inventory a diagram node stands for: a module (Component) or a participant (Sequence), its units; an
 * entity (Data), the stored models, fields and indexes on it; any node of a method's flowchart, that method. A state
 * diagram's node stands for none.
 */
export function nodeUnits(diagram: Diagram, node: string, inventory: ChangeInventory): string[] {
  const units = inventory.units
  switch (diagram.type) {
    case 'component':
    case 'sequence':
      return units.filter((u) => u.module === node).map((u) => u.id)
    case 'data': {
      const name = diagram.entities.find((e) => e.id === node)?.name ?? node
      return units.filter((u) => isDataUnit(u) && (unitEntity(u) === node || unitEntity(u) === name)).map((u) => u.id)
    }
    case 'flowchart': {
      const of = diagram.of ? parseFlowRef(diagram.of) : null
      return of ? units.filter((u) => u.kind === 'method' && u.module === of.module && unitLeaf(u.name) === of.method).map((u) => u.id) : []
    }
    case 'state':
      return []
  }
}

/**
 * The hunks a claim, a diagram node or a change row rests on, in diff order. Its refs: a claim's cites, a node's units
 * (nodeUnits), a change's units. A unit id gives its cited blocks (`H3.1`; `H3`, the whole hunk); a hunk or block id
 * itself; `file:line`, the hunk of that file containing the line, else every hunk of the file. Other cites (a PR
 * comment, decision:<id>, a note) have no code. Empty: nothing behind it in the diff.
 */
export function hunksOf<F extends PrFile>(target: HunkTarget, inventory: ChangeInventory | null | undefined, files: F[]): HunkPick<F>[] {
  const refs = target.kind === 'claim' ? target.cites : target.kind === 'change' ? target.units : inventory ? nodeUnits(target.diagram, target.node, inventory) : []
  const byUnit = new Map((inventory?.units ?? []).map((u) => [u.id, u.hunks]))
  const order: { file: F; hunk: PrHunk }[] = files.flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })))
  const picked = new Map<number, number[] | null>()
  const pick = (i: number, block: number | null) => {
    if (i < 0) return
    const was = picked.get(i)
    if (was === null) return
    picked.set(i, block === null ? null : [...new Set([...(was ?? []), block])].sort((a, b) => a - b))
  }
  const byId = (id: string) => {
    const m = HUNK_ID.exec(id)
    if (m) pick(order.findIndex((h) => h.hunk.id === m[1]), m[2] ? Number(m[2]) : null)
  }
  for (const ref of refs) {
    const unit = byUnit.get(ref)
    if (unit) {
      unit.forEach(byId)
      continue
    }
    if (HUNK_ID.test(ref)) {
      byId(ref)
      continue
    }
    const m = FILE_LINE.exec(ref)
    if (!m) continue
    const [, repo, path, from, to] = m
    const lo = Number(from)
    const hi = to ? Number(to) : lo
    const ofFile = order.flatMap((h, i) => ((h.file.path === path || h.file.oldPath === path || h.file.path.endsWith(`/${path}`)) && (!repo || h.file.repo === repo) ? [i] : []))
    const hit = ofFile.filter((i) => {
      const h = order[i].hunk
      return lo <= h.newStart + Math.max(h.newLines, 1) - 1 && hi >= h.newStart
    })
    for (const i of hit.length ? hit : ofFile) pick(i, null)
  }
  return [...picked].sort(([a], [b]) => a - b).map(([i, blocks]) => ({ ...order[i], blocks }))
}

/** A group of the full diff: a change of the report with the hunks of its units; routine, noise and the rest last. */
export interface ChangeGroup<F extends PrFile = PrFile> {
  title: string
  why: string
  kind: 'change' | 'routine' | 'noise' | 'rest'
  /** Files in diff order, each with its hunks in this group. */
  files: { file: F; hunks: HunkPick<F>[] }[]
}

const byFile = <F extends PrFile>(picks: HunkPick<F>[]): ChangeGroup<F>['files'] => {
  const out: ChangeGroup<F>['files'] = []
  for (const p of picks) {
    const at = out.find((x) => x.file === p.file)
    if (at) at.hunks.push(p)
    else out.push({ file: p.file, hunks: [p] })
  }
  return out
}

/**
 * The full diff of the window by the report's changes: each change with the hunks its units cite (a hunk two changes
 * cite shows in both), the routine row after the important ones, then the noise of the inventory, then every hunk
 * neither cites. A change without code keeps its row; empty noise and rest are left out. Without a legacy report's
 * changes or an inventory (an issues report, a v1 result, an old review), one group of every file.
 */
export function diffByChange<F extends PrFile>(report: ReviewReport | null | undefined, inventory: ChangeInventory | null | undefined, files: F[]): ChangeGroup<F>[] {
  const all = files.flatMap((file) => file.hunks.map((hunk): HunkPick<F> => ({ file, hunk, blocks: null })))
  if (!report || isIssuesReport(report) || !report.changes.length || !inventory) return all.length ? [{ title: 'Files', why: 'every file the PR changes', kind: 'rest', files: byFile(all) }] : []
  const { rows, routine } = reportChanges(report)
  const groups: ChangeGroup<F>[] = [...rows, ...(routine ? [routine] : [])].map((c) => ({
    title: c.title,
    why: c.why,
    kind: c.routine ? 'routine' : 'change',
    files: byFile(hunksOf({ kind: 'change', units: c.units }, inventory, files)),
  }))
  const noise = hunksOf({ kind: 'claim', cites: inventory.noise.flatMap((n) => n.hunks) }, inventory, files)
  if (noise.length) groups.push({ title: 'Noise', why: inventory.noise.map((n) => n.reason).join('; '), kind: 'noise', files: byFile(noise) })
  const seen = new Set(groups.flatMap((g) => g.files.flatMap((f) => f.hunks.map((h) => h.hunk))))
  const rest = all.filter((p) => !seen.has(p.hunk))
  if (rest.length) groups.push({ title: 'Not in the inventory', why: 'hunks no unit and no noise cites: tests, docs and the like', kind: 'rest', files: byFile(rest) })
  return groups
}

/** The lines of a hunk (` `, `+`, `-`), each with whether it is in one of the cited blocks (all changed lines when null). */
export function markBlocks(lines: string[], blocks: number[] | null): { line: string; cited: boolean }[] {
  let k = 0
  let inBlock = false
  return lines.map((line) => {
    const changed = line[0] === '+' || line[0] === '-'
    if (changed && !inBlock) k++
    inBlock = changed
    return { line, cited: changed && (blocks === null || blocks.includes(k)) }
  })
}
