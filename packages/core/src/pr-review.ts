// Reviews of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2): a work of type review, without steps and without a
// PR of ours. Its owner (a project topic) reads the PR and its ticket, states the problem, weighs the approach, draws
// the intent and the fact with the same diff service as a step's review, and records findings by level with a verdict.
// Nothing goes to GitHub without the user's button.

import type { AgentSession, ReviewFinding, Task } from './index.ts'

/** How much a finding matters: blocker = must not merge; should_fix = fix before merge unless argued; question; nit. */
export type FindingLevel = 'blocker' | 'should_fix' | 'question' | 'nit'

export const FINDING_LEVELS: FindingLevel[] = ['blocker', 'should_fix', 'question', 'nit']

export const FINDING_LEVEL_LABELS: Record<FindingLevel, string> = { blocker: 'blocker', should_fix: 'should fix', question: 'question', nit: 'nit' }

/** The verdict on a teammate's PR, as GitHub's review events have it. */
export type PrVerdict = 'approve' | 'request_changes' | 'comment'

export const PR_VERDICTS: PrVerdict[] = ['approve', 'request_changes', 'comment']

export const PR_VERDICT_LABELS: Record<PrVerdict, string> = { approve: 'Approve', request_changes: 'Request changes', comment: 'Comment' }

/** The PR under review. */
export interface PrRef {
  url: string
  /** The project repository (path) it is a PR of. */
  repo: string
  number: number
  author: string
  /** Its base branch. */
  base: string
  /** Its head commit when mag last looked. */
  head: string
}

/** A review of a teammate's PR: what the agent understood, how it rates the approach, and its findings. */
export interface PrReview {
  pr: PrRef
  /** The problem as the agent understood it, with evidence; empty until it has reviewed. */
  problem: string
  /** Its view of the approach: right or not, better alternatives. */
  approach: string
  /** null until the agent has reviewed. */
  verdict: PrVerdict | null
  findings: ReviewFinding[]
  /** The commit it reviewed; a newer head of the PR needs another look. null until it has reviewed. */
  head: string | null
  /** Published to GitHub by the user's button. */
  posted: { at: number; url: string } | null
  /** When the verdict was recorded; null until then. */
  at: number | null
}

/** A GitHub PR link: https://github.com/<owner>/<repo>/pull/<n>. Throws when the text is not one. */
export function parsePrUrl(url: string): { url: string; owner: string; repo: string; number: number } {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i)
  if (!m) throw new Error(`Not a GitHub PR link: ${url.trim() || '(empty)'}; pass https://github.com/<owner>/<repo>/pull/<n>`)
  const [, owner, repo, n] = m
  return { url: `https://github.com/${owner}/${repo}/pull/${n}`, owner, repo, number: Number(n) }
}

/** owner/repo of a GitHub remote (https or ssh), lower case; null for another host or something else. */
export function githubSlug(remote: string | null | undefined): string | null {
  const m = remote?.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

/** A work that reviews a teammate's PR. */
export function isReview(task: Pick<Task, 'type' | 'parentId'>): boolean {
  return task.type === 'review' && !task.parentId
}

/** The project's reviews (`tasks` are the project's): in progress first, then the rest; newest first in each. */
export function projectReviews(tasks: Task[]): Task[] {
  const rank = (t: Task) => (t.status === 'in_progress' ? 0 : 1)
  return tasks.filter(isReview).sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)
}

/** The review of the PR a link names, if any; the newest when there are several. */
export function reviewOf(tasks: Task[], url: string): Task | undefined {
  const u = parsePrUrl(url).url.toLowerCase()
  return projectReviews(tasks).find((t) => t.prReview?.pr.url.toLowerCase() === u)
}

/** Findings per level, in level order; levels without findings are left out. A finding without a level counts as should_fix. */
export function findingsByLevel(findings: ReviewFinding[]): { level: FindingLevel; findings: ReviewFinding[] }[] {
  return FINDING_LEVELS.flatMap((level) => {
    const mine = findings.filter((f) => (f.level ?? 'should_fix') === level)
    return mine.length ? [{ level, findings: mine }] : []
  })
}

/** "2 blockers · 1 question", or "no findings". */
export function findingCounts(findings: ReviewFinding[]): string {
  const parts = findingsByLevel(findings).map(({ level, findings: f }) => {
    const label = FINDING_LEVEL_LABELS[level]
    return `${f.length} ${f.length > 1 && level !== 'should_fix' ? `${label}s` : label}`
  })
  return parts.join(' · ') || 'no findings'
}

/** Whether the agent has recorded a verdict on the PR as mag last saw it. */
export function reviewReady(task: Pick<Task, 'prReview'>): boolean {
  const r = task.prReview
  return !!r?.verdict && r.head === r.pr.head
}

/** The line in Needs you once a review is ready: "Review ready: Request changes · 2 blockers". */
export function reviewReadyText(review: PrReview): string {
  return `Review ready: ${review.verdict ? PR_VERDICT_LABELS[review.verdict] : '—'} · ${findingCounts(review.findings)}`
}

/** The owner topic of a review is in a turn. */
export function reviewRunning(task: Pick<Task, 'ownerSessionId'>, sessions: AgentSession[]): boolean {
  return sessions.some((s) => s.id === task.ownerSessionId && s.status === 'running')
}
