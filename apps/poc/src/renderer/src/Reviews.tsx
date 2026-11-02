import { useEffect, useState } from 'react'
import {
  FINDING_LEVEL_LABELS,
  PR_VERDICTS,
  PR_VERDICT_LABELS,
  findingCounts,
  findingsByLevel,
  prRepoName,
  projectReviews,
  reviewRunning,
  setOf,
  type PrVerdict,
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
import { ago } from './format'
import { TicketLinks, useNow } from './Tasks'

const mag = window.mag

const VERDICT_PILLS: Record<PrVerdict, string> = { approve: 'green', request_changes: 'red', comment: 'amber' }
const LEVEL_PILLS: Record<NonNullable<ReviewFinding['level']>, string> = { blocker: 'red', should_fix: 'amber', question: 'violet', nit: '' }
const CHECK_ICONS: Record<string, string> = { pass: '✓', fail: '✗', pending: '…', skipping: '–', cancel: '–' }

/** The review's line in a list: the agent at work, its verdict, or not reviewed yet. */
function reviewStatus(work: Task, state: AppState): string {
  if (work.status !== 'in_progress') return 'closed'
  if (reviewRunning(work, state.sessions)) return 'the agent is reviewing…'
  const r = work.prReview
  if (!r?.verdict) return 'waits for the agent'
  return `${PR_VERDICT_LABELS[r.verdict]} · ${findingCounts(r.findings)}${r.head === r.pr.head ? '' : ' · new commits since'}`
}

/** Findings worth publishing unless the user says otherwise: blockers and should fix. */
const pickedByDefault = (f: ReviewFinding) => f.post ?? ['blocker', 'should_fix'].includes(f.level ?? 'should_fix')

/**
 * The Reviews tab (reviews-ahent-reviuit-pr-timeitiv.2): on the left a field for a PR link and the user's reviews (no
 * list of PRs waiting for review: reviews-prybraty-spysok-pr-i.1); on the right the review open. A review is a work of
 * its own, owned by a project topic; nothing goes to GitHub without the user's button.
 */
export function ReviewsPage({ project, state, reviewId, onOpenReview, onOpenTopic, onOpenKey }: {
  project: Project
  state: AppState
  /** The review open on the right. */
  reviewId: string | null
  onOpenReview: (id: string | null) => void
  /** Show the topic in the chat aside. */
  onOpenTopic: (id: string) => void
  onOpenKey: (key: string) => void
}) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const reviews = projectReviews(tasks)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const start = (url: string) => {
    setError(null)
    setStarting(url)
    mag.startReview(project.id, url).then(
      (r) => {
        setStarting(null)
        if ('error' in r) return setError(r.error)
        onOpenReview(r.taskId)
        onOpenTopic(r.sessionId)
      },
      (e) => (setStarting(null), setError(String((e as Error).message ?? e))),
    )
  }
  const open = reviews.find((r) => r.id === reviewId)
  return (
    <section className="page reviews">
      <div className="reviewlist">
        <div className="tasksbar">
          <h1>Reviews</h1>
        </div>
        <PasteLink busy={!!starting} onReview={start} />
        {error && <div className="banner">{error}</div>}
        {reviews.length > 0 ? (
          reviews.map((w) => (
            <div key={w.id} className={`reviewrow${w.id === reviewId ? ' on' : ''}`} role="button" tabIndex={0} onClick={() => onOpenReview(w.id)} onKeyDown={(e) => e.key === 'Enter' && onOpenReview(w.id)}>
              <div className="grow">
                <div className="title">{w.title}</div>
                <div className="muted small">{w.prReview && `@${w.prReview.pr.author} · `}{reviewStatus(w, state)} · {ago(w.updatedAt, now)}</div>
              </div>
            </div>
          ))
        ) : (
          <p className="muted small">No reviews yet.</p>
        )}
      </div>
      {open ? (
        <ReviewView key={open.id} work={open} project={project} state={state} now={now} onOpenTopic={onOpenTopic} onOpenKey={onOpenKey} />
      ) : (
        <p className="muted reviewempty">Paste a PR link, or ask in chat: an agent reads the PR and its ticket, draws the fact, and checks it against the problem and the project's agreements, with findings by level. Nothing goes to GitHub without your button.</p>
      )}
    </section>
  )
}

function PasteLink({ busy, onReview }: { busy: boolean; onReview: (url: string) => void }) {
  const [url, setUrl] = useState('')
  return (
    <form className="reviewpaste" onSubmit={(e) => (e.preventDefault(), url.trim() && onReview(url.trim()))}>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a PR link…" aria-label="PR link" />
      <button type="submit" className="primary small" disabled={busy || !url.trim()}>Review</button>
    </form>
  )
}

/** The CI checks of the PR, from GitHub when the page opens. */
function Checks({ work }: { work: Task }) {
  const [checks, setChecks] = useState<PrCheck[] | string | null>(null)
  const head = work.prReview?.pr.head
  useEffect(() => {
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

/** A review's page: the PR, what the agent understood, its fact, CI and the findings by level. */
function ReviewView({ work, project, state, now, onOpenTopic, onOpenKey }: {
  work: Task
  project: Project
  state: AppState
  now: number
  onOpenTopic: (id: string) => void
  onOpenKey: (key: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const r = work.prReview
  // What the user publishes; a new review starts from its own picks.
  const [picks, setPicks] = useState<Set<number>>(new Set())
  useEffect(() => setPicks(new Set((r?.findings ?? []).flatMap((f, i) => (pickedByDefault(f) ? [i] : [])))), [r?.at])
  const toggle = (i: number) => setPicks((p) => (p.has(i) ? new Set([...p].filter((x) => x !== i)) : new Set([...p, i])))
  const running = reviewRunning(work, state.sessions)
  // The fact, and any other diagram of the review (an intent of an older review shows as a plain one).
  const diagrams = diagramsOf(state.canvases.filter((c) => c.taskId === work.id))
  // The fact set in one window (povnyi-diff-nabir-pov-iazanykh.2); the rest as a list.
  const factRoot = diagrams.find((d) => d.role === 'fact')
  const fact = factRoot ? setOf(factRoot, diagrams) : []
  const rest = diagrams.filter((d) => !fact.includes(d))
  const diagramsKey = diagrams.map((d) => `${d.id}@${d.version}`).join(',')
  const owner = state.sessions.find((s) => s.id === work.ownerSessionId)
  const act = (f: () => Promise<unknown>) => () => {
    setError(null)
    f().catch((e) => setError(String((e as Error).message ?? e)))
  }
  if (!r) return <p className="muted">This review has no PR.</p>
  const repo = prRepoName(project, r.pr)
  return (
    <div className="reviewview">
      <div className="taskrow">
        <button className="link" title="Open the PR on GitHub" onClick={() => mag.open(r.pr.url)}>{repo}#{r.pr.number} ↗</button>
        <span className="muted small">@{r.pr.author} · into {r.pr.base} · {r.head ? `reviewed at ${r.head.slice(0, 7)}` : 'not reviewed yet'}{r.at ? ` · ${ago(r.at, now)}` : ''}</span>
        <div className="grow" />
        {r.verdict && <span className={`pill ${VERDICT_PILLS[r.verdict]}`}>{PR_VERDICT_LABELS[r.verdict]}</span>}
      </div>
      <h1>{work.title.replace(/^[^:]*#\d+: /, '')}</h1>
      <div className="taskrow">
        <TicketLinks task={work} />
        <div className="grow" />
        <Checks work={work} />
      </div>
      {error && <div className="banner">{error}</div>}
      {work.needsInput && <div className="banner">{work.needsInput}</div>}
      <div className="taskrow">
        {owner && <button onClick={() => onOpenTopic(owner.id)}>Discuss in chat {running && <span className="dot inline" />}</button>}
        <button disabled={running} title="The agent looks at the PR as it is now: what changed, and whether its findings still hold" onClick={act(() => mag.reviewAgain(work.id).then(onOpenTopic))}>
          {work.status === 'in_progress' ? 'Review again' : 'Reopen review'}
        </button>
        {work.status === 'in_progress' && <button onClick={act(() => mag.closeReview(work.id))}>Close review</button>}
        <div className="grow" />
        <span className="muted small">Nothing goes to GitHub without your button.</span>
      </div>
      {r.pr.outside && (
        <div className="banner">
          {r.pr.repo} is not one of the project's repositories: mag reads the PR from GitHub, and its fact has modules by folder, without the project architecture.{' '}
          <button className="small" disabled={running} title="Pick a checkout of the repository: it joins the project, and the review looks again with its architecture" onClick={act(() => mag.connectReviewRepo(work.id).then((c) => {
            if (c && 'error' in c) throw new Error(c.error)
            if (c) onOpenTopic(c.sessionId)
          }))}>Connect repo</button>
        </div>
      )}
      {running && !r.verdict && <p className="muted">The agent is reviewing: PR and ticket, problem, fact, findings.</p>}
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
      </section>
      <section>
        <h2>Findings {r.verdict && <span className="muted small">{findingCounts(r.findings)}</span>}</h2>
        {r.findings.length ? (
          findingsByLevel(r.findings).map(({ level, findings }) =>
            findings.map((f, i) => (
              <div key={`${level}${i}`} className="finding">
                {r.verdict && (
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
        {r.verdict && <Publish work={work} repo={repo} picks={picks} running={running} now={now} onError={setError} />}
      </section>
    </div>
  )
}

/**
 * The user's Publish (reviews-ahent-reviuit-pr-timeitiv.3, Decision 7): the verdict and the picked findings go to the
 * PR on GitHub as the user's review, after they confirm. Nothing else ever does.
 */
function Publish({ work, repo, picks, running, now, onError }: {
  work: Task
  repo: string
  picks: Set<number>
  running: boolean
  now: number
  onError: (e: string | null) => void
}) {
  const r = work.prReview!
  const [verdict, setVerdict] = useState<PrVerdict>(r.verdict ?? 'comment')
  const [busy, setBusy] = useState(false)
  useEffect(() => setVerdict(r.verdict ?? 'comment'), [r.verdict, r.at])
  const stale = r.head !== r.pr.head
  const publish = () => {
    const n = picks.size
    if (!confirm(`Publish to ${repo}#${r.pr.number} as you: ${PR_VERDICT_LABELS[verdict]}${n ? ` with ${n} finding${n > 1 ? 's' : ''}` : ''}?${stale ? '\nThe PR has new commits since this review.' : ''}`)) return
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
      {r.posted && (
        <button className="link small" title="Open the published review" onClick={() => mag.open(r.posted!.url)}>published {ago(r.posted.at, now)} ↗</button>
      )}
    </div>
  )
}
