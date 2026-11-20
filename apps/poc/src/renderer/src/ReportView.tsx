import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import {
  CHECKS_LABELS,
  choiceLine,
  criteriaSources,
  decisionNote,
  directionReferences,
  issuesView,
  isIssuesReport,
  type AcceptanceItem,
  type DeltaStatus,
  deltaView,
  type EvidenceStatus,
  type Issue,
  type IssueOwner,
  type IssuesReport,
  type IssueSeverity,
  type LegacyReport,
  type DirectionChoice,
  type DirectionDecision,
  type DirectionView as View,
  reportCards,
  reportChanges,
  reportStrip,
  type ChecksVerdict,
  type Claim,
  type HunkTarget,
  type ReportChange,
  type ReportKind,
  type ReviewReport,
  type StepFact,
  type Tone,
} from '@mag/core'

const TONE_PILLS: Record<Tone, string> = { good: 'green', warn: 'amber', bad: 'red', neutral: '' }
const CHECKS_PILLS: Record<ChecksVerdict, string> = { request_changes: 'red', look: 'amber', approve_with_comments: 'green', approve: 'green' }
const CHECKS_TONES: Record<ChecksVerdict, Tone> = { request_changes: 'bad', look: 'warn', approve_with_comments: 'good', approve: 'good' }
const SEVERITY_PILLS: Record<IssueSeverity, string> = { blocker: 'red', should: 'amber', nit: '', note: '' }
const EVIDENCE_PILLS: Record<EvidenceStatus, string> = { met: 'green', partly: 'amber', not: 'red', unverified: '' }
const OWNER_LABELS: Record<IssueOwner, string> = { author: 'the author', po: 'the PO', user: 'you' }
const DELTA_LABELS: Record<DeltaStatus, string> = { fixed: 'fixed', open: 'still open', new: 'new' }
const DELTA_PILLS: Record<DeltaStatus, string> = { fixed: 'green', open: 'amber', new: 'violet' }
const SOURCE_LABELS: Record<AcceptanceItem['source'], string> = { pr: 'the PR', ticket: 'the ticket', design: 'the design', none: 'nowhere (inferred)' }
const SOURCE_TITLES: Record<Claim['source'], string> = {
  checked: 'mag verified it against the inventory',
  agent: "the reviewer's reading, with code refs",
  yours: 'your own words: PR comments, notes, decisions',
  question: 'open: the author answers',
  rule: 'a project rule fails',
}

/** The id of the canvas a claim's view opens (canvas:<id>#<node>). */
export const viewCanvas = (view: string | undefined) => view?.match(/^canvas:([\w-]+)/)?.[1] ?? null

function Badge({ source }: { source: Claim['source'] }) {
  return <span className={`badge src-${source}`} title={SOURCE_TITLES[source]}>{source}</span>
}

/** What the review window expands in place: the code hunks a claim or a change row rests on (review-v2-part-2-v1-2.2). */
export type Expand = (target: HunkTarget) => ReactNode

/**
 * A static page (a review's archive, review-v2-part-2-v1-2.3): no buttons, no state; folds are <details>, links to the
 * page's own cards and diagrams are anchors.
 */
const StaticContext = createContext(false)

/** The id of a diagram on a static page: a claim's view links to it. */
export const diagramAnchor = (canvasId: string) => `diagram-${canvasId}`

/** A toggle that expands the code behind a claim or a change row: its button, and the code once open. */
function useCode(target: HunkTarget, expand: Expand | undefined): { button: ReactNode; code: ReactNode } {
  const [open, setOpen] = useState(false)
  const still = useContext(StaticContext)
  if (!expand) return { button: null, code: null }
  // Static: the code is on the page, folded.
  if (still) return { button: null, code: <details className="inline"><summary className="link small">code</summary><div className="inlinehunks">{expand(target)}</div></details> }
  return {
    button: <button className="link small" title="Show the code it rests on, here" onClick={() => setOpen(!open)}>code {open ? '▾' : '▸'}</button>,
    code: open && <div className="inlinehunks">{expand(target)}</div>,
  }
}

/** An inventory unit's id (u12): mag's own, shown as its code, never as text. */
const UNIT_ID = /^u\d+$/

/** A row of the changes table (the routine one folds: `title` is its toggle); in the window, its units' code expands under it. */
function ChangeRow({ change, expand, title, open = true }: { change: ReportChange; expand?: Expand; title?: ReactNode; open?: boolean }) {
  const { button, code } = useCode({ kind: 'change', units: change.units }, expand)
  return (
    <tr className={change.routine ? 'routine' : undefined}>
      <td>
        {title ?? <b>{change.title}</b>}
        {open && (
          <>
            <div className="small muted">{change.why}</div>
            {button}
            {code}
          </>
        )}
      </td>
      {/* Inventory unit ids are mag's own: a count here, the code behind them under "code". */}
      <td className="small muted nowrap">{change.units.length} unit{change.units.length === 1 ? '' : 's'}</td>
    </tr>
  )
}

/** A claim: its badge, text and cites; its view opens the diagram of the set it cites; in the window, its code expands. */
function ClaimLine({ claim, onView, expand, children }: { claim: Claim; onView: (canvasId: string) => void; expand?: Expand; children?: ReactNode }) {
  const canvas = viewCanvas(claim.view)
  const { button, code } = useCode({ kind: 'claim', cites: claim.cites }, expand)
  const still = useContext(StaticContext)
  const label = `${claim.view?.replace(/^canvas:[\w-]+#?/, '') || 'diagram'} ↓`
  return (
    <div className="claim">
      <Badge source={claim.source} />
      <div className="grow">
        {children}
        <div>{claim.text}</div>
        <div className="small muted">
          {claim.cites.filter((c) => !UNIT_ID.test(c)).map((c) => <code key={c}>{c}</code>)}
          {canvas && (still
            ? <a className="link small" href={`#${diagramAnchor(canvas)}`}>{label}</a>
            : <button className="link small" title="Show the diagram it cites" onClick={() => onView(canvas)}>{label}</button>)}
          {button}
        </div>
        {code}
      </div>
    </div>
  )
}

/** The user's buttons on a PR's direction card (review-v2-questions-first-direction.2). */
export interface DirectionActions {
  decide: (decision: { choice: DirectionChoice; option?: string; principle?: string }) => void
  discuss: () => void
  /** The review's topic is in a turn, or a call is on its way. */
  busy: boolean
}

/**
 * Discuss with agent first (the topic argues the options with the user), then the call: Direction OK, Prefer an option
 * other than the PR's, Ask the author; the principle in the user's words goes with it.
 */
function DirectionButtons({ report, actions }: { report: ReviewReport & { direction: NonNullable<ReviewReport['direction']> }; actions: DirectionActions }) {
  const [principle, setPrinciple] = useState('')
  const decide = (choice: DirectionChoice, option?: string) => actions.decide({ choice, ...(option ? { option } : {}), ...(principle.trim() ? { principle: principle.trim() } : {}) })
  return (
    <div className="directionbuttons">
      <div className="taskrow">
        <button className="primary" disabled={actions.busy} title="The review's agent argues the options with you beside this page, then records your call" onClick={actions.discuss}>Discuss with agent</button>
        <button disabled={actions.busy} title="The PR's direction is fine" onClick={() => decide('ok')}>Direction OK</button>
        {report.direction.options.filter((o) => !o.pr).map((o) => (
          <button key={o.name} disabled={actions.busy} title={`Prefer ${o.name}: findings fold, and a comment to the author is drafted`} onClick={() => decide('prefer', o.name)}>Prefer {o.name}</button>
        ))}
        <button disabled={actions.busy} title="Ask the author first: questions to the author are drafted" onClick={() => decide('discuss')}>Ask the author</button>
      </div>
      <input className="grow" value={principle} onChange={(e) => setPrinciple(e.target.value)} placeholder="The principle behind your call, in your words (optional)" aria-label="Principle" />
    </div>
  )
}

/**
 * The reviewer's own leaning on the direction (prompts-use-the-models-to.1), folded after the options so the user forms
 * their own view first; it never affects the checks.
 */
function DirectionView({ view }: { view: View }) {
  return (
    <details className="directionview">
      <summary className="link small">The reviewer's leaning</summary>
      <div className="claim">
        <span className="badge src-agent" title={SOURCE_TITLES.agent}>agent</span>
        <div className="grow">
          <div><b>{view.leaning}</b> <span className="pill small">{view.confidence} confidence</span></div>
          <div className="small">{view.why}</div>
          <div className="small muted">An opinion only: it does not count in the checks.</div>
        </div>
      </div>
    </details>
  )
}

/** Why the checks verdict is what it is: the reviewer's why, and mag's blockers when its floor holds (raised it or not). */
function ChecksWhy({ report }: { report: ReviewReport }) {
  if (!report.why && !report.floor) return null
  return (
    <div className="checkswhy small">
      {report.why && <div><span className="muted">Reviewer{report.raisedFrom ? ` (${CHECKS_LABELS[report.raisedFrom]})` : ''}:</span> {report.why}</div>}
      {report.floor && (
        <div>
          <span className="muted">{report.raisedFrom ? `mag raised it to ${CHECKS_LABELS[report.checks]}:` : 'mag:'}</span>
          <ul>{report.floor.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}
    </div>
  )
}

/** The user's call once made, and the comment to the author it drafted. */
function Decided({ decided, draft }: { decided: DirectionDecision; draft?: string }) {
  const still = useContext(StaticContext)
  return (
    <div className="decided">
      <div><span className="badge src-yours">yours</span> <b>{choiceLine(decided)}</b>{decided.principle && <span className="muted"> · {decided.principle}</span>}</div>
      {draft && (
        <div className="draft">
          <div className="cardhead">
            <span className="muted small">Draft to the author</span>
            {!still && <button className="link small" title="Copy the draft" onClick={() => void navigator.clipboard.writeText(draft)}>copy</button>}
          </div>
          <pre className="small">{draft}</pre>
        </div>
      )}
    </div>
  )
}

/** The report's intent, read first: what the change does and why; nothing on a report from before it was asked. */
export function ReportIntent({ report }: { report: ReviewReport }) {
  return report.intent ? <section className="reportcard"><h2>Intent</h2><p>{report.intent}</p></section> : null
}

/** The reviewer's conclusion and advice, read last; nothing on a report from before it was asked. */
export function ReportConclusion({ report }: { report: ReviewReport }) {
  return report.conclusion ? <section className="reportcard"><h2>Conclusion</h2><p>{report.conclusion}</p></section> : null
}

/** What both report views take. */
interface ReportViewProps {
  report: ReviewReport
  fact: Pick<StepFact, 'counts'> | null | undefined
  kind: ReportKind
  onView: (canvasId: string) => void
  /** The project's direction decisions: references citing one show it, as yours. */
  decisions?: DirectionDecision[]
  /** The direction buttons; without them (a step's review: the approved plan) the card is read only. */
  direction?: DirectionActions
  /** The review window: every claim, issue and change row expands its code hunks in place. */
  expand?: Expand
  /** Rendered for a static page: no buttons, folds and anchors instead (the direction buttons are not passed then). */
  staticPage?: boolean
  /** The conclusion after `children`; false when the page puts it last itself. */
  conclusion?: boolean
  /** An issues report: a checkbox per row to pick it for Publish, by its index in the review's findings (mag's blockers first). */
  pick?: { picked: (finding: number) => boolean; toggle: (finding: number) => void }
  /** An issues report: its issues fold (the user prefers another direction). */
  foldIssues?: boolean
  children?: ReactNode
}

/** A report as it was recorded: issues and evidence (today's), or the fixed questions of before. */
export function ReportView(props: ReportViewProps) {
  return (
    <StaticContext.Provider value={props.staticPage ?? false}>
      {isIssuesReport(props.report) ? <IssuesReportView {...props} report={props.report} /> : <LegacyReportView {...props} report={props.report} />}
    </StaticContext.Provider>
  )
}

/** The direction card: the decision(s), the options, the reviewer's leaning, facts, references and the user's call. */
function DirectionCard({ report, kind, onView, decisions, direction, expand, id }: Pick<ReportViewProps, 'kind' | 'onView' | 'decisions' | 'direction' | 'expand'> & { report: ReviewReport & { direction: NonNullable<ReviewReport['direction']> }; id?: string }) {
  const d = report.direction
  return (
    <section id={id} className="reportcard direction">
      <div className="cardhead">
        <h2>Direction</h2>
        <span className="pill violet">{kind === 'pr' ? (report.decided ? `Yours: ${choiceLine(report.decided)}` : 'Direction: your call') : 'The approved plan'}</span>
      </div>
      {d.decisions.map((c, i) => <ClaimLine key={i} claim={c} onView={onView} expand={expand} />)}
      {d.options.length > 0 && (
        <div className="options">
          {d.options.map((o) => (
            <div key={o.name} className={`option${o.pr ? ' pr' : ''}`}>
              <div><b>{o.name}</b>{o.pr && <span className="pill small">{kind === 'pr' ? "the PR's" : 'chosen'}</span>}</div>
              <div className="small muted">{o.tradeoffs}</div>
            </div>
          ))}
        </div>
      )}
      {d.options.length === 1 && d.only && <div className="small muted">Only one option: {d.only}</div>}
      {d.view && <DirectionView view={d.view} />}
      {d.facts.length > 0 && <h3>Facts</h3>}
      {d.facts.map((c, i) => <ClaimLine key={i} claim={c} onView={onView} expand={expand} />)}
      {d.references.length > 0 && <h3>References</h3>}
      {directionReferences(report, decisions).map((r, i) => (
        <ClaimLine key={i} claim={r.claim} onView={onView} expand={expand}>
          {r.decisions.map((x) => <div key={x.id} className="small muted">Your decision: {decisionNote(x).slice(2)}</div>)}
        </ClaimLine>
      ))}
      {kind === 'pr' && report.decided && <Decided decided={report.decided} draft={report.draft} />}
      {kind === 'pr' && direction && <DirectionButtons report={report} actions={direction} />}
    </section>
  )
}

/** A row of the issues card: mag's blocker, or an issue with its impact, place, who decides and its ready comment. */
function IssueRow({ issue, mag, expand, pick }: { issue?: Issue; mag?: string; expand?: Expand; pick?: { checked: boolean; toggle: () => void } }) {
  const { button, code } = useCode({ kind: 'claim', cites: issue?.where ? [issue.where] : [] }, issue?.where ? expand : undefined)
  const still = useContext(StaticContext)
  const box = pick && <input type="checkbox" title="Publish this issue" aria-label="Publish this issue" checked={pick.checked} onChange={pick.toggle} />
  if (!issue) {
    return (
      <div className="finding">
        {box}
        <span className="pill red">blocker</span>
        <div className="grow"><span className="badge src-checked" title="mag's own floor">mag</span> {mag}</div>
      </div>
    )
  }
  return (
    <div className="finding">
      {box}
      <span className={`pill ${SEVERITY_PILLS[issue.severity]}`}>{issue.severity}</span>
      <div className="grow">
        <div>
          <b>{issue.title}</b> <span className="muted small">{issue.kind} · decides {OWNER_LABELS[issue.owner]}</span>
          {issue.raisedBy && <span className="pill small" title="Raised in the PR's threads before: not new"> raised by {issue.raisedBy}</span>}
        </div>
        <div className="small">{issue.impact}</div>
        <div className="small muted">
          {issue.where && <code>{issue.where}</code>}
          {button}
        </div>
        {code}
        <details className="inline">
          <summary className="link small">comment</summary>
          <div className="draft">
            {!still && <button className="link small" title="Copy the comment" onClick={() => void navigator.clipboard.writeText(issue.comment)}>copy</button>}
            <pre className="small">{issue.comment}</pre>
          </div>
        </details>
      </div>
    </div>
  )
}

/**
 * The issues report (review-v3-concise-design-first.1), as the review structure of its doc: intent with the verdict →
 * issues (mag's blockers, then each issue once, the first five shown) → acceptance with its evidence → verified and not
 * checked → the direction (its card only when unsettled, else one line) → `children` (diagram, …) → the conclusion.
 */
function IssuesReportView({ report, kind, onView, decisions, direction, expand, conclusion = true, pick, foldIssues = false, children }: ReportViewProps & { report: IssuesReport }) {
  const floor = report.floor?.blockers ?? []
  const { shown, folded, fresh } = issuesView(report)
  const row = (issue: Issue, i: number) => {
    const at = floor.length + i
    return <IssueRow key={i} issue={issue} expand={expand} pick={pick && { checked: pick.picked(at), toggle: () => pick.toggle(at) }} />
  }
  const raised = report.issues.length - fresh
  const issues = (
    <>
      {floor.map((b, i) => <IssueRow key={`mag${i}`} mag={b} pick={pick && { checked: pick.picked(i), toggle: () => pick.toggle(i) }} />)}
      {shown.map((x, i) => row(x, i))}
      {folded.length > 0 && (
        <details className="inline">
          <summary className="link small">{folded.length} more</summary>
          {folded.map((x, i) => row(x, shown.length + i))}
        </details>
      )}
      {!floor.length && !report.issues.length && <p className="muted small">None.</p>}
    </>
  )
  return (
    <div className="report">
      <section className="reportcard verdictcard">
        <div className="cardhead">
          <span className={`verdict tone-${CHECKS_TONES[report.checks]}`} title="The reviewer's verdict, never below mag's floor">{CHECKS_LABELS[report.checks]}</span>
          {kind === 'pr' && report.direction && <span className="pill violet">{report.decided ? `Direction: ${choiceLine(report.decided).replace(/^Direction /, '')}` : 'Direction: your call'}</span>}
        </div>
        <p className="intent">{report.intent}</p>
        <ChecksWhy report={report} />
      </section>

      {report.delta && (
        <section className="reportcard">
          <div className="cardhead"><h2>Since the last review</h2></div>
          {deltaView(report).map((g) => (
            <div key={g.status} className="finding">
              <span className={`pill ${DELTA_PILLS[g.status]}`}>{DELTA_LABELS[g.status]}</span>
              <ul className="grow small">{g.titles.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          ))}
          {!report.delta.length && <p className="muted small">Nothing before, nothing new.</p>}
        </section>
      )}

      <section className="reportcard">
        <div className="cardhead">
          <h2>Issues</h2>
          <span className="muted small">{fresh} new{raised ? ` · ${raised} raised before` : ''}</span>
        </div>
        {foldIssues ? <details className="reportfold"><summary>Folded: you prefer another direction</summary>{issues}</details> : issues}
      </section>

      <section className="reportcard">
        <div className="cardhead">
          <h2>Acceptance</h2>
          <span className="muted small">criteria from {criteriaSources(report).map((s) => SOURCE_LABELS[s]).join(', ')}</span>
        </div>
        {report.acceptance.length ? report.acceptance.map((a, i) => (
          <div key={i} className="finding">
            <span className={`pill ${EVIDENCE_PILLS[a.status]}`}>{a.status}</span>
            <div className="grow">
              <div>{a.criterion} <span className="muted small">· {SOURCE_LABELS[a.source]}</span></div>
              <div className="small muted">{a.evidence}</div>
            </div>
          </div>
        )) : <p className="muted small">{report.trivial ? 'None needed: a trivial change.' : 'No criteria.'}</p>}
      </section>

      <section className="reportcard">
        <div className="cardhead"><h2>Verified</h2></div>
        {report.verified.length ? <ul className="small">{report.verified.map((v) => <li key={v}>{v}</li>)}</ul> : <p className="muted small">Nothing stated.</p>}
        <h3>Not checked</h3>
        {report.notChecked.length ? <ul className="small">{report.notChecked.map((v) => <li key={v}>{v}</li>)}</ul> : <p className="muted small">Nothing stated.</p>}
      </section>

      {report.direction ? (
        <DirectionCard report={{ ...report, direction: report.direction }} kind={kind} onView={onView} decisions={decisions} direction={direction} expand={expand} />
      ) : (
        <p className="small muted">Direction: follows {report.follows ?? (kind === 'step' ? 'the approved plan' : 'what the reviewer did not say')}.</p>
      )}
      {children}
      {conclusion && <ReportConclusion report={report} />}
    </div>
  )
}

/**
 * A report from before review-v3-concise-design-first.1 (review-v2-questions-first-direction.1), as it was: verdict
 * strip → direction card → question cards → changes table. The evidence views, the inventory and the rest go below it
 * (`children`); a claim's view opens its diagram there (`onView`).
 */
function LegacyReportView({ report, fact, kind, onView, decisions, direction, expand, staticPage = false, conclusion = true, children }: ReportViewProps & { report: LegacyReport }) {
  const [routineOpen, setRoutineOpen] = useState(false)
  // Ids of the cards, unique on the page (a Diff tab shows the reports of several steps): a strip chip scrolls to its card.
  const at = useId()
  const cardId = (key: string) => `card${at.replace(/[^\w-]/g, '')}-${key}`
  const toCard = (key: string) => document.getElementById(cardId(key))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const { rows, routine } = reportChanges(report)
  return (
    <div className="report">
      <ReportIntent report={report} />
      <div className="reportstrip">
        <span className={`pill ${CHECKS_PILLS[report.checks]}`} title="The reviewer's verdict on problem, conventions and risks, never below mag's floor">Checks: {CHECKS_LABELS[report.checks]}</span>
        {reportStrip(report, fact, kind).map((c) => {
          const card = c.key === 'coverage' ? 'changes' : c.key
          const body = <><span className="muted small">{c.label}</span> {c.value}</>
          return staticPage
            ? <a key={c.key} className={`stripchip tone-${c.tone}`} href={`#${cardId(card)}`}>{body}</a>
            : <button key={c.key} className={`stripchip tone-${c.tone}`} title={`Go to ${c.label}`} onClick={() => toCard(card)}>{body}</button>
        })}
      </div>
      <ChecksWhy report={report} />

      <DirectionCard id={cardId('direction')} report={report} kind={kind} onView={onView} decisions={decisions} direction={direction} expand={expand} />
      {reportCards(report).map((card) => (
        <section key={card.key} id={cardId(card.key)} className="reportcard">
          <div className="cardhead">
            <h2>{card.title}</h2>
            <span className="muted small">{card.question}</span>
          </div>
          {card.rows.length ? (
            card.rows.map((r, i) => (
              <ClaimLine key={i} claim={r.claim} onView={onView} expand={expand}>
                {(r.about || r.status) && (
                  <div className="small">
                    {r.status && <span className={`pill ${TONE_PILLS[r.tone]}`}>{r.status}</span>} {r.about}
                  </div>
                )}
              </ClaimLine>
            ))
          ) : (
            <p className="muted small">None.</p>
          )}
        </section>
      ))}

      <section id={cardId('changes')} className="reportcard">
        <div className="cardhead">
          <h2>Changes</h2>
          <span className="muted small">by importance</span>
        </div>
        <table className="changes">
          <tbody>
            {rows.map((c) => <ChangeRow key={c.title} change={c} expand={expand} />)}
            {routine && (
              <ChangeRow
                change={routine}
                expand={expand}
                open={routineOpen || staticPage}
                title={staticPage ? <b>{routine.title}</b> : <button className="link" onClick={() => setRoutineOpen(!routineOpen)}>{routineOpen ? '▾' : '▸'} {routine.title}</button>}
              />
            )}
          </tbody>
        </table>
      </section>
      {children}
      {conclusion && <ReportConclusion report={report} />}
    </div>
  )
}
