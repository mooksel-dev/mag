import { useState, type ReactNode } from 'react'
import {
  CHECKS_LABELS,
  reportCards,
  reportChanges,
  reportStrip,
  type ChecksVerdict,
  type Claim,
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

/** A claim: its badge, text and cites; its view opens the diagram of the set it cites. */
function ClaimLine({ claim, onView, children }: { claim: Claim; onView: (canvasId: string) => void; children?: ReactNode }) {
  const canvas = viewCanvas(claim.view)
  return (
    <div className="claim">
      <Badge source={claim.source} />
      <div className="grow">
        {children}
        <div>{claim.text}</div>
        <div className="small muted">
          {claim.cites.map((c) => <code key={c}>{c}</code>)}
          {canvas && <button className="link small" title="Show the diagram it cites" onClick={() => onView(canvas)}>{claim.view!.replace(/^canvas:[\w-]+#?/, '') || 'diagram'} ↓</button>}
        </div>
      </div>
    </div>
  )
}

/**
 * The review report (review-v2-questions-first-direction.1), as the mockup: verdict strip → direction card → question
 * cards → changes table. The evidence views, the inventory and the rest go below it (`children`); a claim's view opens
 * its diagram there (`onView`).
 */
export function ReportView({ report, fact, kind, onView, children }: {
  report: ReviewReport
  fact: Pick<StepFact, 'counts'> | null | undefined
  kind: ReportKind
  onView: (canvasId: string) => void
  children?: ReactNode
}) {
  const [routineOpen, setRoutineOpen] = useState(false)
  const d = report.direction
  const { rows, routine } = reportChanges(report)
  return (
    <div className="report">
      <div className="reportstrip">
        <span className={`pill ${CHECKS_PILLS[report.checks]}`} title="From problem, conventions and risks only">Checks: {CHECKS_LABELS[report.checks]}</span>
        {reportStrip(report, fact, kind).map((c) => (
          <span key={c.key} className={`stripchip tone-${c.tone}`}>
            <span className="muted small">{c.label}</span> {c.value}
          </span>
        ))}
      </div>

      <section className="reportcard direction">
        <div className="cardhead">
          <h2>Direction</h2>
          <span className="pill violet">{kind === 'pr' ? 'Direction: your call' : 'The approved plan'}</span>
        </div>
        {d.decisions.map((c, i) => <ClaimLine key={i} claim={c} onView={onView} />)}
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
        {d.facts.map((c, i) => <ClaimLine key={i} claim={c} onView={onView} />)}
        {d.references.length > 0 && <h3>References</h3>}
        {d.references.map((c, i) => <ClaimLine key={i} claim={c} onView={onView} />)}
      </section>

      {reportCards(report).map((card) => (
        <section key={card.key} className="reportcard">
          <div className="cardhead">
            <h2>{card.title}</h2>
            <span className="muted small">{card.question}</span>
          </div>
          {card.rows.length ? (
            card.rows.map((r, i) => (
              <ClaimLine key={i} claim={r.claim} onView={onView}>
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

      <section className="reportcard">
        <div className="cardhead">
          <h2>Changes</h2>
          <span className="muted small">by importance</span>
        </div>
        <table className="changes">
          <tbody>
            {rows.map((c) => (
              <tr key={c.title}>
                <td><b>{c.title}</b><div className="small muted">{c.why}</div></td>
                <td className="small">{c.units.map((u) => <code key={u}>{u}</code>)}</td>
              </tr>
            ))}
            {routine && (
              <tr className="routine">
                <td>
                  <button className="link" onClick={() => setRoutineOpen(!routineOpen)}>{routineOpen ? '▾' : '▸'} {routine.title}</button>
                  {routineOpen && <div className="small muted">{routine.why}</div>}
                </td>
                <td className="small">{routineOpen ? routine.units.map((u) => <code key={u}>{u}</code>) : `${routine.units.length} units`}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      {children}
    </div>
  )
}
