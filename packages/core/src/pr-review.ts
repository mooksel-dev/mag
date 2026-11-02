// Reviews of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2): a work of type review, without steps and without a
// PR of ours. Its owner (a project topic) reads the PR and its ticket, states the problem, draws the fact with the same
// diff service as a step's review and checks it against the problem and the project's agreements, not against a plan
// of its own (reviews-prybraty-spysok-pr-i.1); it records findings by level with a verdict.
// Nothing goes to GitHub without the user's button.

import { repoNames, type AgentSession, type Project, type ReviewFinding, type Task } from './index.ts'

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
  /**
   * The project repository (path) it is a PR of; for a PR outside the project (`outside`), its GitHub owner/repo, lower
   * case.
   */
  repo: string
  /**
   * A PR of a repository the project has no checkout of (reviews-ahent-reviuit-pr-timeitiv.3): its changes are read from
   * GitHub, and its fact has modules by folder, without the project's architecture.
   */
  outside?: boolean
  number: number
  author: string
  /** Its base branch. */
  base: string
  /** Its head commit when mag last looked. */
  head: string
}

/** A review of a teammate's PR: what the agent understood, whether the change solves it, and its findings. */
export interface PrReview {
  pr: PrRef
  /** The problem as the agent understood it, with evidence; empty until it has reviewed. */
  problem: string
  /** How the PR solves the problem and whether it does (reviews-prybraty-spysok-pr-i.1: not the agent's own design). */
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

/** The name a PR's repository goes by: the project's name for it, else (outside the project) its repo part. */
export function prRepoName(project: Pick<Project, 'repos'>, pr: PrRef): string {
  return pr.outside ? (pr.repo.split('/')[1] ?? pr.repo) : (repoNames(project)[project.repos.indexOf(pr.repo)] ?? pr.repo)
}

/** A finding's place as a line range of a file (`src/a.ts:12`, `src/a.ts:12-20`); null when it names no line. */
export function findingPlace(where: string | undefined): { path: string; start: number; end: number } | null {
  const m = where?.trim().match(/^([^\s:]+):(\d+)(?:-(\d+))?$/)
  if (!m) return null
  const start = Number(m[2])
  const end = m[3] ? Number(m[3]) : start
  return start > 0 && end >= start ? { path: m[1].replace(/^\.\//, ''), start, end } : null
}

/** A line comment of a review on GitHub: on the PR's side of the diff, `start` when it spans several lines. */
export interface PostComment {
  path: string
  line: number
  start?: number
  body: string
}

/** What the user publishes to a teammate's PR: the review's text and its line comments. */
export interface PostReview {
  verdict: PrVerdict
  body: string
  comments: PostComment[]
}

const findingText = (f: ReviewFinding) => `**${FINDING_LEVEL_LABELS[f.level ?? 'should_fix']}**: ${f.text}`

/**
 * The review the user publishes (reviews-ahent-reviuit-pr-timeitiv.3, Decision 7): only the findings they picked, in
 * level order; one on a line of a file is a line comment, the rest go in the text. `inline: false`: everything in the
 * text (GitHub refuses a comment on a line the PR does not change). GitHub wants a text with request changes and
 * comment: without findings for it, it counts them.
 */
export function reviewToPost(verdict: PrVerdict, findings: ReviewFinding[], inline = true): PostReview {
  const picked = findingsByLevel(findings.filter((f) => f.post)).flatMap((g) => g.findings)
  const comments: PostComment[] = []
  const rest: string[] = []
  for (const f of picked) {
    const at = inline ? findingPlace(f.where) : null
    if (at) comments.push({ path: at.path, line: at.end, ...(at.end > at.start ? { start: at.start } : {}), body: findingText(f) })
    else rest.push(`- ${f.where ? `\`${f.where}\`: ` : ''}${findingText(f)}`)
  }
  const body = rest.length || verdict === 'approve' ? rest.join('\n') : picked.length ? findingCounts(picked) : PR_VERDICT_LABELS[verdict]
  return { verdict, body, comments }
}

/**
 * What a poll of a review's PR leads to (reviews-ahent-reviuit-pr-timeitiv.3): done once it is merged or closed
 * (Decision 12); a look at new commits after the agent's review (Decision 8) once mag has not asked about that head yet;
 * else nothing. A review the agent has not finished is left to it.
 */
export function reviewPollOutcome(review: PrReview, live: { state: 'OPEN' | 'MERGED' | 'CLOSED'; head: string | null }): 'done' | 'rereview' | null {
  if (live.state !== 'OPEN') return 'done'
  return live.head && review.head && live.head !== review.pr.head ? 'rereview' : null
}
