import { useEffect, useState } from 'react'
import {
  FINDING_LEVEL_LABELS,
  PR_VERDICT_LABELS,
  findingLines,
  findingWhere,
  findingsByLevel,
  pickedByDefault,
  prRepoName,
  reviewRunning,
  shortTitle,
  shownResult,
  type FindingLevel,
  type PrVerdict,
  type Project,
  type ReviewFinding,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'

const mag = window.mag

const VERDICT_TAGS: Record<PrVerdict, string> = { approve: 'green', comment: 'amber', request_changes: 'red' }
const LEVEL_TAGS: Record<FindingLevel, string> = { blocker: 'red', should_fix: 'amber', question: 'violet', nit: '', note: '' }

/**
 * The reviews of a topic as one table at the end of its conversation (review-table): a row per PR with its verdict and
 * counts; a row opens to its findings, each with its level, its essence and the comment it makes, a checkbox (the
 * blockers picked first) and Publish selected. Open shows the whole review in the drawer.
 */
export function ReviewTable({ reviews, project, state, onOpen }: {
  reviews: Task[]
  project: Project | undefined
  state: AppState
  onOpen: (taskId: string) => void
}) {
  const [open, setOpen] = useState<string | null>(reviews.length === 1 ? reviews[0].id : null)
  const waiting = reviews.filter((t) => shownResult(t.prReview)?.verdict && !t.prReview?.posted).length
  return (
    <div className="reviewtable" aria-label="Reviews">
      <div className="rthead">
        <b>{reviews.length} review{reviews.length > 1 ? 's' : ''}</b>
        {waiting > 0 && <span className="pill amber">{waiting} wait on you</span>}
      </div>
      {reviews.filter((t) => t.prReview).map((t) => (
        <ReviewRow key={t.id} work={t} project={project} running={reviewRunning(t, state.sessions)} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} onOpen={() => onOpen(t.id)} />
      ))}
    </div>
  )
}

function ReviewRow({ work, project, running, open, onToggle, onOpen }: {
  work: Task
  project: Project | undefined
  running: boolean
  open: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const review = work.prReview!
  const r = shownResult(review)
  const pr = review.pr
  const name = project ? `${prRepoName(project, pr)}#${pr.number}` : `#${pr.number}`
  // The title after "repo#n: ".
  const title = shortTitle(work).replace(/^[^:]*#\d+:\s*/, '')
  const findings = r?.findings ?? []
  const counts = findingsByLevel(findings).map((g) => `${g.findings.length} ${FINDING_LEVEL_LABELS[g.level].toLowerCase()}${g.findings.length > 1 && g.level !== 'should_fix' ? 's' : ''}`).join(' · ')
  return (
    <div className={`rtrow${open ? ' open' : ''}`}>
      <button className="rtline" aria-expanded={open} onClick={onToggle} title={open ? 'Fold' : 'Show its findings'}>
        <span className="rtcaret" aria-hidden>{open ? '▾' : '▸'}</span>
        <code>{name}</code>
        <span className="rttitle">{title}</span>
        <span className="muted small rtcounts">{running ? 'reviewing…' : counts || (r?.verdict ? 'no findings' : 'not reviewed yet')}</span>
        {r?.verdict ? <span className={`pill ${VERDICT_TAGS[r.verdict]}`}>{PR_VERDICT_LABELS[r.verdict]}</span> : <span />}
        {review.posted ? <span className="pill green" title="Published to the PR">posted</span> : <span />}
      </button>
      <button className="small rtopen" onClick={onOpen} title="The whole review: problem, direction, diagrams">Open</button>
      {open && r && <Findings work={work} findings={findings} verdict={r.verdict} at={r.at} running={running} name={name} />}
    </div>
  )
}

function Findings({ work, findings, verdict, at, running, name }: {
  work: Task
  findings: ReviewFinding[]
  verdict: PrVerdict | null
  at: number | null
  running: boolean
  name: string
}) {
  const initial = () => new Set(findings.flatMap((f, i) => (pickedByDefault(f) ? [i] : [])))
  const [picks, setPicks] = useState<Set<number>>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [all_, setShowAll] = useState(false)
  // A new run of the review: its findings, its defaults.
  useEffect(() => setPicks(initial()), [at]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!findings.length) return <p className="muted small rtempty">{verdict ? 'No findings.' : 'Not reviewed yet.'}</p>
  const all = picks.size === findings.length
  const toggle = (i: number) => setPicks((p) => { const n = new Set(p); if (!n.delete(i)) n.add(i); return n })
  // In level order, as they are published.
  const order = findings.map((f, i) => ({ f, i })).sort((a, b) => LEVELS.indexOf(a.f.level ?? 'should_fix') - LEVELS.indexOf(b.f.level ?? 'should_fix'))
  // The first ones, the most important; a picked one always shows.
  const shown = all_ ? order : order.filter((x, n) => n < FIRST || picks.has(x.i))
  const hidden = order.length - shown.length
  const publish = () => {
    const v = verdict ?? 'comment'
    if (!confirm(`Publish to ${name} as you: ${PR_VERDICT_LABELS[v]}${picks.size ? ` with ${picks.size} finding${picks.size > 1 ? 's' : ''}` : ''}?`)) return
    setBusy(true)
    setError(null)
    mag.publishReview(work.id, v, [...picks].sort((a, b) => a - b)).then(
      (res) => { setBusy(false); if ('error' in res) setError(`GitHub: ${res.error}`) },
      (e: Error) => { setBusy(false); setError(String(e.message ?? e)) },
    )
  }
  return (
    <div className="rtfindings">
      <label className="rtall small">
        <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = picks.size > 0 && !all }} onChange={() => setPicks(all ? new Set() : new Set(findings.map((_, i) => i)))} />
        {all ? 'Unselect all' : 'Select all'}
      </label>
      {shown.map(({ f, i }) => {
        const { summary, comment } = findingLines(f)
        const where = findingWhere(f)
        return (
          <label key={i} className="rtfinding">
            <input type="checkbox" checked={picks.has(i)} onChange={() => toggle(i)} />
            <span className={`pill ${LEVEL_TAGS[f.level ?? 'should_fix']}`}>{FINDING_LEVEL_LABELS[f.level ?? 'should_fix']}</span>
            <span className="rtbody">
              <span className="rtsum">{summary}{where && <span className="rtwhere small muted"> · {where}</span>}</span>
              {comment && <span className="rtcomment small muted"><span className="rtsaid">Comment:</span> {comment}</span>}
            </span>
          </label>
        )
      })}
      {hidden > 0 && <button type="button" className="link small rtmore" onClick={() => setShowAll(true)}>… {hidden} more</button>}
      <div className="rtpublish">
        {error && <span className="error small">{error}</span>}
        <div className="grow" />
        <button className="primary" disabled={busy || running || !picks.size} title="Post the verdict and the picked findings to the PR as your review" onClick={publish}>
          {busy ? 'Publishing…' : `Publish selected (${picks.size})`}
        </button>
      </div>
    </div>
  )
}

const LEVELS: FindingLevel[] = ['blocker', 'should_fix', 'question', 'nit', 'note']
/** Findings shown before "… N more". */
const FIRST = 6
