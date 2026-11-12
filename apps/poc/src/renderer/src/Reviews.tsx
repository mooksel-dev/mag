import { useEffect, useState, type ReactNode } from 'react'
import {
  FINDING_LEVEL_LABELS,
  PR_VERDICTS,
  PR_VERDICT_LABELS,
  findingCounts,
  findingsFolded,
  findingsByLevel,
  pickedByDefault,
  isImported,
  prRepoName,
  reviewRunning,
  setOf,
  emptyResult,
  resultLine,
  resultOutdated,
  shownResult,
  REVIEW_FORMATS,
  shortTitle,
  type PrReview,
  type PrVerdict,
  type ReviewFormat,
  type ReviewResult,
  type Project,
  type ReviewFinding,
  type Task,
} from '@mag/core'
import type { AppState, PrCheck } from '../../preload/api'
import { Markdown } from './Chat'
import { DIAGRAM_NAMES } from './diagrams/DiagramView'
import { diagramsOf } from './DiffTab'
import { DiffSetView } from './DiffSetView'
import { FactPanel } from './FactPanel'
import { ReportView } from './ReportView'
import { ExportReviewButton, ImportedBanner } from './ReviewExport'
import { ago } from './format'
import { TicketLinks } from './Tasks'

const mag = window.mag

const VERDICT_PILLS: Record<PrVerdict, string> = { approve: 'green', request_changes: 'red', comment: 'amber' }
const LEVEL_PILLS: Record<NonNullable<ReviewFinding['level']>, string> = { blocker: 'red', should_fix: 'amber', question: 'violet', nit: '' }
const CHECK_ICONS: Record<string, string> = { pass: '✓', fail: '✗', pending: '…', skipping: '–', cancel: '–' }

/** Findings worth publishing unless the user says otherwise: blockers and should fix. */

/** The CI checks of the PR, from GitHub when the page opens. */
function Checks({ work }: { work: Task }) {
  const [checks, setChecks] = useState<PrCheck[] | string | null>(null)
  const head = work.prReview?.pr.head
  const kept = work.imported?.pr.checks
  useEffect(() => {
    // An imported review shows the checks as they were when it was exported.
    if (kept) return void setChecks(kept)
    let gone = false
    setChecks(null)
    mag.prChecks(work.id).then(
      (c) => !gone && setChecks(c),
      (e) => !gone && setChecks(String((e as Error).message ?? e).split('\n')[0]),
    )
    return () => void (gone = true)
  }, [work.id, head])
  if (checks === null) return <span className="muted small">CI: …</span>
  if (typeof checks === 'string') return <span className="muted small">CI: {checks}</span>
  if (!checks.length) return <span className="muted small">CI: no checks</span>
  const failed = checks.filter((c) => c.bucket === 'fail')
  const pending = checks.filter((c) => c.bucket === 'pending')
  return (
    <span className="chips">
      <span className={`diffchip${failed.length ? ' s-missing' : ''}`}>CI {failed.length ? `${failed.length} failed` : pending.length ? `${pending.length} pending` : 'green'}</span>
      {[...failed, ...pending].map((c) => (
        <button key={c.name} className="diffchip link" title={c.link ?? ''} onClick={() => c.link && mag.open(c.link)}>
          {CHECK_ICONS[c.bucket] ?? '?'} {c.name}
        </button>
      ))}
    </span>
  )
}

/** A canvas link of a finding (canvas:<id>#<node>) opens that diagram in its own window. */
function NodeLink({ node }: { node: string }) {
  const id = node.match(/^canvas:([\w-]+)/)?.[1]
  if (!id) return <code>{node}</code>
  return <button className="link small" title="Open the diagram" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: id })}>{node.replace(/^canvas:[\w-]+#?/, '') || 'diagram'} ⧉</button>
}

/**
 * A review's page in the artifact pane (ux-odna-rozmova-na-robotu.2): the PR, what the agent understood, its fact, CI
 * and the findings by level. Its topic is the conversation beside it.
 */
export function ReviewView({ work, project, state, now, onOpenKey, onDeleted }: {
  work: Task
  project: Project
  state: AppState
  now: number
  onOpenKey: (key: string) => void
  /** The review is gone: the pane clears. */
  onDeleted: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  // The diagram of the fact set a claim of the report opened (its evidence view).
  const [evidence, setEvidence] = useState<string | null>(null)
  const review = work.prReview
  // The result shown (v1 or v2, review-v2-part-2-v1-2.1); an empty one while its first run works.
  const r = review ? (shownResult(review) ?? emptyResult(review.shown, '')) : null
  // What the user publishes; a new review starts from its own picks.
  const [picks, setPicks] = useState<Set<number>>(new Set())
  useEffect(() => setPicks(new Set((r?.findings ?? []).flatMap((f, i) => (pickedByDefault(f) ? [i] : [])))), [r?.at, r?.format])
  const toggle = (i: number) => setPicks((p) => (p.has(i) ? new Set([...p].filter((x) => x !== i)) : new Set([...p, i])))
  const running = reviewRunning(work, state.sessions)
  // Imported from an archive (review-v2-part-2-v1-2.3): read only, nothing to run, decide or publish.
  const ro = isImported(work)
  // The fact, and any other diagram of the review (an intent of an older review shows as a plain one).
  const diagrams = diagramsOf(state.canvases.filter((c) => c.taskId === work.id))
  // The fact set in one window (povnyi-diff-nabir-pov-iazanykh.2); the rest as a list.
  const factRoot = diagrams.find((d) => d.role === 'fact')
  const fact = factRoot ? setOf(factRoot, diagrams) : []
  const rest = diagrams.filter((d) => !fact.includes(d))
  const diagramsKey = diagrams.map((d) => `${d.id}@${d.version}`).join(',')
  const act = (f: () => Promise<unknown>) => () => {
    setError(null)
    f().catch((e) => setError(String((e as Error).message ?? e)))
  }
  // A call on its way to main: the buttons wait for it.
  const [deciding, setDeciding] = useState(false)
  const whileDeciding = (f: () => Promise<unknown>) => act(() => (setDeciding(true), f().finally(() => setDeciding(false))))
  if (!review || !r) return <p className="muted">This review has no PR.</p>
  const repo = prRepoName(project, review.pr)
  const diffSection = (
    <>
      {fact.length > 0 && <DiffSetView key={fact[0].id} set={fact} step={work} findings={r.findings} />}
      {rest.length > 0 && (
        <div className="difflistrows">
          {rest.map((d) => (
            <div key={d.id} role="button" tabIndex={0} className="diffrow" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: d.id })} onKeyDown={(e) => e.key === 'Enter' && mag.openWindow({ kind: 'canvas', canvasId: d.id })}>
              <span className="type">{DIAGRAM_NAMES[d.diagram.type]}</span>
              <span className="title">{d.title}</span>
              <span className="muted small">v{d.version}</span>
              <span className="link">⧉</span>
            </div>
          ))}
        </div>
      )}
      <FactPanel step={work} diagramsKey={diagramsKey} />
    </>
  )
  // Preferring another option rejects the PR's direction: its detailed findings fold (review-v2-questions-first-direction.2).
  const folded = findingsFolded(r.report)
  const findingsBody = (
    <>
      <h2>Findings {r.verdict && <span className="muted small">{findingCounts(r.findings)}{r.report ? ' · from the report, to publish' : ''}</span>}</h2>
      {r.findings.length ? (
        findingsByLevel(r.findings).map(({ level, findings }) =>
          findings.map((f, i) => (
            <div key={`${level}${i}`} className="finding">
              {r.verdict && !ro && (
                <input type="checkbox" title="Publish this finding" aria-label="Publish this finding" checked={picks.has(r.findings.indexOf(f))} onChange={() => toggle(r.findings.indexOf(f))} />
              )}
              <span className={`pill ${LEVEL_PILLS[level]}`}>{FINDING_LEVEL_LABELS[level]}</span>
              <div className="grow">
                <div>{f.text}</div>
                <div className="small">
                  {f.where && <code>{f.where}</code>} {f.node && <NodeLink node={f.node} />}
                </div>
              </div>
            </div>
          )),
        )
      ) : (
        <p className="muted small">{r.verdict ? 'No findings.' : 'None yet.'}</p>
      )}
      {r.verdict && !ro && <Publish work={work} result={r} repo={repo} picks={picks} running={running} now={now} onError={setError} />}
    </>
  )
  const findingsSection = folded ? (
    <details className="reportfold">
      <summary>Findings: folded, you prefer another direction ({findingCounts(r.findings)})</summary>
      {findingsBody}
    </details>
  ) : (
    <section>{findingsBody}</section>
  )
  return (
    <div className="reviewview">
      <div className="taskrow">
        <button className="link" title="Open the PR on GitHub" onClick={() => mag.open(review.pr.url)}>{repo}#{review.pr.number} ↗</button>
        <span className="muted small">@{review.pr.author} · into {review.pr.base} · {r.head ? `reviewed at ${r.head.slice(0, 7)}` : 'not reviewed yet'}{r.at ? ` · ${ago(r.at, now)}` : ''}</span>
        <div className="grow" />
        {r.verdict && !r.report && <span className={`pill ${VERDICT_PILLS[r.verdict]}`}>{PR_VERDICT_LABELS[r.verdict]}</span>}
        <ExportReviewButton work={work} onError={setError} />
        <button className="small primary" title="The whole review in its own window: diagrams inline, the code behind every claim, the full diff and the agent at the side" onClick={() => mag.openWindow({ kind: 'review', taskId: work.id })}>Open review</button>
      </div>
      <h1>{shortTitle(work)}</h1>
      <div className="taskrow">
        <TicketLinks task={work} />
        <div className="grow" />
        <Checks work={work} />
      </div>
      {error && <div className="banner">{error}</div>}
      {work.needsInput && <div className="banner">{work.needsInput}</div>}
      <ImportedBanner work={work} />
      <div className="taskrow">
        {!ro && <button disabled={running} title="The agent looks at the PR as it is now: what changed, and whether its findings still hold" onClick={act(() => mag.reviewAgain(work.id))}>
          {work.status === 'in_progress' ? 'Review again' : 'Reopen review'}
        </button>}
        {!ro && work.status === 'in_progress' && <button onClick={act(() => mag.closeReview(work.id))}>Close review</button>}
        <button
          title="Delete the review for good, with its diagrams and the topic mag created for it; nothing changes on GitHub"
          onClick={act(async () => {
            if (!confirm(`Delete review ${work.key}? It goes for good, with its diagrams and the topic mag created for it; nothing changes on GitHub.`)) return
            await mag.deleteReview(work.id)
            onDeleted()
          })}
        >
          Delete review
        </button>
        <div className="grow" />
        <span className="muted small">Nothing goes to GitHub without your button.</span>
      </div>
      {review.pr.outside && !ro && (
        <div className="banner">
          {review.pr.repo} is not one of the project's repositories: mag reads the PR from GitHub, and its fact has modules by folder, without the project architecture.{' '}
          <button className="small" disabled={running} title="Pick a checkout of the repository: it joins the project, and the review looks again with its architecture" onClick={act(() => mag.connectReviewRepo(work.id).then((c) => {
            if (c && 'error' in c) throw new Error(c.error)
          }))}>Connect repo</button>
        </div>
      )}
      <FormatSwitch work={work} review={review} running={running} onError={setError} />
      {running && !r.verdict && <p className="muted">{r.format === 'v1' ? 'The agent is reviewing: problem, fact, findings and a verdict.' : 'The agent is reviewing: fact, direction and its options, problem, conventions, risks.'}</p>}
      {r.report ? (
        <ReportView
          report={r.report}
          fact={work.fact}
          kind="pr"
          decisions={project.directionDecisions}
          direction={ro ? undefined : {
            busy: running || deciding,
            discuss: whileDeciding(() => mag.discussDirection(work.id)),
            decide: (d) => whileDeciding(() => mag.decideDirection(work.id, d))(),
          }}
          onView={(id) => (fact.some((d) => d.id === id) ? setEvidence(id) : mag.openWindow({ kind: 'canvas', canvasId: id }))}>
          {evidence && fact.some((d) => d.id === evidence) && (
            <section>
              <div className="cardhead">
                <h2>Evidence</h2>
                <button className="link small" onClick={() => setEvidence(null)}>close</button>
              </div>
              <DiffSetView key={evidence} set={fact} current={evidence} step={work} findings={r.findings} />
            </section>
          )}
          {findingsSection}
          <details className="reportfold">
            <summary>Problem and approach as the agent read them</summary>
            {r.problem && <Markdown text={r.problem} onOpenTask={onOpenKey} />}
            {r.approach && <Markdown text={r.approach} onOpenTask={onOpenKey} />}
          </details>
          <details className="reportfold">
            <summary>Inventory and fact diagrams</summary>
            {diffSection}
          </details>
        </ReportView>
      ) : (
        <LegacyReviewView review={r} onOpenKey={onOpenKey} diff={diffSection} findings={findingsSection} />
      )}
    </div>
  )
}

/** A v1 result, or a review recorded before the report (review-v2-questions-first-direction.1): in the layout it had. */
function LegacyReviewView({ review: r, onOpenKey, diff, findings }: { review: ReviewResult; onOpenKey: (key: string) => void; diff: ReactNode; findings: ReactNode }) {
  return (
    <>
      {r.problem && (
        <section>
          <h2>Problem</h2>
          <Markdown text={r.problem} onOpenTask={onOpenKey} />
        </section>
      )}
      {r.approach && (
        <section>
          <h2>Does it solve it</h2>
          <Markdown text={r.approach} onOpenTask={onOpenKey} />
        </section>
      )}
      <section>
        <h2>Diff</h2>
        {diff}
      </section>
      {findings}
    </>
  )
}

/**
 * v1 | v2 (review-v2-part-2-v1-2.1): which result of the review the page shows, each with its line; Run v1 / Run v2
 * for the other format when it has no result yet or one older than the PR's head, in its own topic (Review again is
 * the shown one's). The other result stays.
 */
export function FormatSwitch({ work, review, running, onError }: { work: Task; review: PrReview; running: boolean; onError: (e: string | null) => void }) {
  const go = (f: () => Promise<unknown>) => {
    onError(null)
    f().catch((e) => onError(String((e as Error).message ?? e)))
  }
  return (
    <div className="taskrow">
      <div className="seg" role="group" aria-label="Review format">
        {REVIEW_FORMATS.map((f: ReviewFormat) => {
          const result = review.results[f]
          return (
            <button key={f} className={f === review.shown ? 'on' : ''} aria-pressed={f === review.shown} disabled={!result} title={result ? resultLine(result) || 'no result yet' : `No ${f} result yet: Run ${f}`} onClick={() => f !== review.shown && go(() => mag.showReviewResult(work.id, f))}>
              {f}
            </button>
          )
        })}
      </div>
      {!isImported(work) && REVIEW_FORMATS.filter((f) => f !== review.shown && resultOutdated(review, f)).map((f) => (
        <button key={f} className="small" disabled={running || work.status !== 'in_progress'} title={review.results[f]?.at ? `The ${f} review is of an older head: look at the PR as it is now` : `A ${f} review of the PR in its own topic, beside the other result`} onClick={() => go(() => mag.runReviewFormat(work.id, f))}>
          Run {f}
        </button>
      ))}
      <span className="muted small">{resultLine(shownResult(review)) || `${review.shown}: not reviewed yet`}</span>
    </div>
  )
}

/**
 * The user's Publish (reviews-ahent-reviuit-pr-timeitiv.3, Decision 7): the verdict and the picked findings go to the
 * PR on GitHub as the user's review, after they confirm. Nothing else ever does.
 */
function Publish({ work, result: r, repo, picks, running, now, onError }: {
  work: Task
  /** The shown result: its verdict and findings are what goes. */
  result: ReviewResult
  repo: string
  picks: Set<number>
  running: boolean
  now: number
  onError: (e: string | null) => void
}) {
  const review = work.prReview!
  const [verdict, setVerdict] = useState<PrVerdict>(r.verdict ?? 'comment')
  const [busy, setBusy] = useState(false)
  useEffect(() => setVerdict(r.verdict ?? 'comment'), [r.verdict, r.at])
  const stale = r.head !== review.pr.head
  const publish = () => {
    const n = picks.size
    if (!confirm(`Publish to ${repo}#${review.pr.number} as you: ${PR_VERDICT_LABELS[verdict]}${n ? ` with ${n} finding${n > 1 ? 's' : ''}` : ''}?${stale ? '\nThe PR has new commits since this review.' : ''}`)) return
    onError(null)
    setBusy(true)
    mag.publishReview(work.id, verdict, [...picks].sort((a, b) => a - b)).then(
      (res) => (setBusy(false), 'error' in res && onError(`GitHub: ${res.error}`)),
      (e) => (setBusy(false), onError(String((e as Error).message ?? e))),
    )
  }
  return (
    <div className="taskrow reviewpublish">
      <select value={verdict} onChange={(e) => setVerdict(e.target.value as PrVerdict)} aria-label="Verdict to publish">
        {PR_VERDICTS.map((v) => <option key={v} value={v}>{PR_VERDICT_LABELS[v]}</option>)}
      </select>
      <button className="primary" disabled={busy || running} title="Post the verdict and the picked findings to the PR as your review" onClick={publish}>
        {busy ? 'Publishing…' : `Publish to GitHub${picks.size ? ` (${picks.size})` : ''}`}
      </button>
      {review.posted && (
        <button className="link small" title="Open the published review" onClick={() => mag.open(review.posted!.url)}>published {ago(review.posted.at, now)} ↗</button>
      )}
    </div>
  )
}
