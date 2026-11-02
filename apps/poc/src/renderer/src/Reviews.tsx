import { useEffect, useState } from 'react'
import {
  FINDING_LEVEL_LABELS,
  PR_VERDICT_LABELS,
  findingCounts,
  findingsByLevel,
  parsePrUrl,
  projectReviews,
  repoNames,
  reviewRunning,
  type PrVerdict,
  type Project,
  type ReviewFinding,
  type Task,
} from '@mag/core'
import type { AppState, AwaitingPr, PrCheck } from '../../preload/api'
import { Markdown } from './Chat'
import { DIAGRAM_NAMES } from './diagrams/DiagramView'
import { FactPanel } from './FactPanel'
import { ago } from './format'
import { TicketLinks, useNow } from './Tasks'

const mag = window.mag

const VERDICT_PILLS: Record<PrVerdict, string> = { approve: 'green', request_changes: 'red', comment: 'amber' }
const LEVEL_PILLS: Record<NonNullable<ReviewFinding['level']>, string> = { blocker: 'red', should_fix: 'amber', question: 'violet', nit: '' }
const CHECK_ICONS: Record<string, string> = { pass: '✓', fail: '✗', pending: '…', skipping: '–', cancel: '–' }

/** The review's line in a list: the agent at work, its verdict, or not reviewed yet. */
function reviewStatus(work: Task | undefined, state: AppState): string {
  if (!work) return 'not reviewed'
  if (work.status !== 'in_progress') return 'closed'
  if (reviewRunning(work, state.sessions)) return 'the agent is reviewing…'
  const r = work.prReview
  if (!r?.verdict) return 'waits for the agent'
  return `${PR_VERDICT_LABELS[r.verdict]} · ${findingCounts(r.findings)}${r.head === r.pr.head ? '' : ' · new commits since'}`
}

/** "app#418", from a PR link. */
const prShort = (url: string) => {
  try {
    const p = parsePrUrl(url)
    return `${p.repo}#${p.number}`
  } catch {
    return url
  }
}

/**
 * The Reviews tab (reviews-ahent-reviuit-pr-timeitiv.2): on the left the PRs of the project's repositories that wait
 * for the user's review, a field for any PR link, and the reviews mag has; on the right the review open. A review is a
 * work of its own, owned by a project topic; nothing goes to GitHub without the user's button.
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
  const [awaiting, setAwaiting] = useState<{ prs: AwaitingPr[]; errors: string[] } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    setAwaiting(null)
    mag.awaitingReviews(project.id).then(
      (a) => !gone && setAwaiting(a),
      (e) => !gone && setAwaiting({ prs: [], errors: [String((e as Error).message ?? e)] }),
    )
    return () => void (gone = true)
  }, [project.id, nonce])
  const byUrl = (url: string) => reviews.find((r) => r.prReview?.pr.url.toLowerCase() === url.toLowerCase())
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
  const others = reviews.filter((r) => !awaiting?.prs.some((p) => p.url.toLowerCase() === r.prReview?.pr.url.toLowerCase()))
  const open = reviews.find((r) => r.id === reviewId)
  return (
    <section className="page reviews">
      <div className="reviewlist">
        <div className="tasksbar">
          <h1>Reviews</h1>
          <span className="grow" />
          <button className="link small" title="Ask GitHub again" onClick={() => setNonce(nonce + 1)}>↻</button>
        </div>
        <PasteLink busy={!!starting} onReview={start} />
        {error && <div className="banner">{error}</div>}
        <h2 className="small">Waiting for your review</h2>
        {awaiting === null ? (
          <p className="muted small">Asking GitHub…</p>
        ) : awaiting.prs.length ? (
          awaiting.prs.map((p) => {
            const work = byUrl(p.url)
            return (
              <div key={p.url} className={`reviewrow${work && work.id === reviewId ? ' on' : ''}`} role="button" tabIndex={0} onClick={() => work && onOpenReview(work.id)} onKeyDown={(e) => e.key === 'Enter' && work && onOpenReview(work.id)}>
                <div className="grow">
                  <div className="title"><span className="key">{prShort(p.url)}</span> {p.title}</div>
                  <div className="muted small">@{p.author} · {reviewStatus(work, state)}</div>
                </div>
                {!work && <button className="small" disabled={starting === p.url} onClick={(e) => (e.stopPropagation(), start(p.url))}>Review</button>}
              </div>
            )
          })
        ) : (
          <p className="muted small">No PR waits for your review in this project's repositories.</p>
        )}
        {awaiting?.errors.map((e) => <p key={e} className="muted small">GitHub: {e}</p>)}
        {others.length > 0 && (
          <>
            <h2 className="small">Reviews</h2>
            {others.map((w) => (
              <div key={w.id} className={`reviewrow${w.id === reviewId ? ' on' : ''}`} role="button" tabIndex={0} onClick={() => onOpenReview(w.id)} onKeyDown={(e) => e.key === 'Enter' && onOpenReview(w.id)}>
                <div className="grow">
                  <div className="title">{w.title}</div>
                  <div className="muted small">{w.prReview && `@${w.prReview.pr.author} · `}{reviewStatus(w, state)} · {ago(w.updatedAt, now)}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      {open ? (
        <ReviewView key={open.id} work={open} project={project} state={state} now={now} onOpenTopic={onOpenTopic} onOpenKey={onOpenKey} />
      ) : (
        <p className="muted reviewempty">Pick a PR, or paste a link: an agent reads the PR and its ticket, draws the intent and the fact, and lists findings by level. Nothing goes to GitHub without your button.</p>
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

/** A review's page: the PR, what the agent understood, intent ↔ fact, CI and the findings by level. */
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
  const running = reviewRunning(work, state.sessions)
  const diagrams = state.canvases.filter((c) => c.taskId === work.id && c.kind === 'diagram' && c.diagram && (c.role === 'intent' || c.role === 'fact'))
  const diagramsKey = diagrams.map((d) => `${d.id}@${d.version}`).join(',')
  const owner = state.sessions.find((s) => s.id === work.ownerSessionId)
  const act = (f: () => Promise<unknown>) => () => {
    setError(null)
    f().catch((e) => setError(String((e as Error).message ?? e)))
  }
  if (!r) return <p className="muted">This review has no PR.</p>
  const repo = repoNames(project)[project.repos.indexOf(r.pr.repo)] ?? r.pr.repo
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
      {running && !r.verdict && <p className="muted">The agent is reviewing: PR and ticket, problem, approach, intent, fact, findings.</p>}
      {r.problem && (
        <section>
          <h2>Problem</h2>
          <Markdown text={r.problem} onOpenTask={onOpenKey} />
        </section>
      )}
      {r.approach && (
        <section>
          <h2>Approach</h2>
          <Markdown text={r.approach} onOpenTask={onOpenKey} />
        </section>
      )}
      <section>
        <h2>Diff</h2>
        {diagrams.length > 0 && (
          <div className="difflistrows">
            {diagrams.map((d) => (
              <div key={d.id} role="button" tabIndex={0} className="diffrow" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: d.id })} onKeyDown={(e) => e.key === 'Enter' && mag.openWindow({ kind: 'canvas', canvasId: d.id })}>
                <span className="type">{d.role === 'intent' ? 'Intent' : 'Fact'} · {DIAGRAM_NAMES[d.diagram!.type]}</span>
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
      </section>
    </div>
  )
}
