import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import {
  CHECKS_LABELS,
  choiceLine,
  decisionNote,
  directionReferences,
  type DirectionChoice,
  type DirectionDecision,
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
const CHECKS_PILLS: Record<ChecksVerdict, string> = { request_changes: 'red', look: 'amber', approve: 'green' }
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
      <td className="small">{open ? change.units.map((u) => <code key={u}>{u}</code>) : `${change.units.length} units`}</td>
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
          {claim.cites.map((c) => <code key={c}>{c}</code>)}
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
function DirectionButtons({ report, actions }: { report: ReviewReport; actions: DirectionActions }) {
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

/**
 * The review report (review-v2-questions-first-direction.1), as the mockup: verdict strip → direction card → question
 * cards → changes table. The evidence views, the inventory and the rest go below it (`children`); a claim's view opens
 * its diagram there (`onView`).
 */
export function ReportView({ report, fact, kind, onView, decisions, direction, expand, staticPage = false, children }: {
  report: ReviewReport
  fact: Pick<StepFact, 'counts'> | null | undefined
  kind: ReportKind
  onView: (canvasId: string) => void
  /** The project's direction decisions: references citing one show it, as yours. */
  decisions?: DirectionDecision[]
  /** The direction buttons; without them (a step's review: the approved plan) the card is read only. */
  direction?: DirectionActions
  /** The review window: every claim and change row expands its code hunks in place. */
  expand?: Expand
  /** Rendered for a static page: no buttons, folds and anchors instead (the direction buttons are not passed then). */
  staticPage?: boolean
  children?: ReactNode
}) {
  const [routineOpen, setRoutineOpen] = useState(false)
  // Ids of the cards, unique on the page (a Diff tab shows the reports of several steps): a strip chip scrolls to its card.
  const at = useId()
  const cardId = (key: string) => `card${at.replace(/[^\w-]/g, '')}-${key}`
  const toCard = (key: string) => document.getElementById(cardId(key))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const d = report.direction
  const { rows, routine } = reportChanges(report)
  return (
    <StaticContext.Provider value={staticPage}>
    <div className="report">
      <div className="reportstrip">
        <span className={`pill ${CHECKS_PILLS[report.checks]}`} title="From problem, conventions and risks only">Checks: {CHECKS_LABELS[report.checks]}</span>
        {reportStrip(report, fact, kind).map((c) => {
          const card = c.key === 'coverage' ? 'changes' : c.key
          const body = <><span className="muted small">{c.label}</span> {c.value}</>
          return staticPage
            ? <a key={c.key} className={`stripchip tone-${c.tone}`} href={`#${cardId(card)}`}>{body}</a>
            : <button key={c.key} className={`stripchip tone-${c.tone}`} title={`Go to ${c.label}`} onClick={() => toCard(card)}>{body}</button>
        })}
      </div>

      <section id={cardId('direction')} className="reportcard direction">
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
    </div>
    </StaticContext.Provider>
  )
}
