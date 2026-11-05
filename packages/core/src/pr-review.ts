// Reviews of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.2): a work of type review, without steps and without a
// PR of ours. Its owner (a project topic) reads the PR and its ticket, states the problem, draws the fact with the same
// diff service as a step's review and checks it against the problem and the project's agreements, not against a plan
// of its own (reviews-prybraty-spysok-pr-i.1); it records findings by level with a verdict.
// Nothing goes to GitHub without the user's button.

import { repoNames, type AgentSession, type Project, type ReviewFinding, type Task } from './index.ts'
import { reportLine, type ChecksVerdict, type ReviewReport } from './review-report.ts'

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

/**
 * The format of a review's result (review-v2-part-2-v1-2.1, Decision 7): v1, findings by level with a verdict (before
 * review-v2-questions-first-direction); v2, the report of fixed questions with its direction for the user to decide.
 */
export type ReviewFormat = 'v1' | 'v2'

export const REVIEW_FORMATS: ReviewFormat[] = ['v1', 'v2']

export const REVIEW_FORMAT_LABELS: Record<ReviewFormat, string> = { v1: 'v1 · findings and a verdict', v2: 'v2 · questions and the direction' }

/** A project's format for new reviews: its setting, v2 without one. */
export const projectReviewFormat = (project: Pick<Project, 'reviewFormat'>): ReviewFormat => (project.reviewFormat === 'v1' ? 'v1' : 'v2')

/** One format's review of the PR: what the agent understood, whether the change solves it, and its findings. */
export interface ReviewResult {
  format: ReviewFormat
  /** The topic that runs this format, its own (a fresh one per format); a topic that asked (review_pr) when it did. */
  sessionId: string
  /** The problem as the agent understood it, with evidence; empty until it has reviewed. */
  problem: string
  /** How the PR solves the problem and whether it does (reviews-prybraty-spysok-pr-i.1: not the agent's own design). */
  approach: string
  /** null until the agent has reviewed. */
  verdict: PrVerdict | null
  /** The findings the user picks to publish; with a report, derived from it (reportFindings). */
  findings: ReviewFinding[]
  /**
   * v2 only: the answers to the review's questions (review-v2-questions-first-direction.1): direction (the user's call),
   * problem, conventions, risks, questions, changes; verdict is its checks verdict.
   */
  report?: ReviewReport
  /** The commit it reviewed; a newer head of the PR needs another look. null until it has reviewed. */
  head: string | null
  /** When the verdict was recorded; null until then. */
  at: number | null
}

/**
 * A review of a teammate's PR: one result per format, each from its own run (review-v2-part-2-v1-2.1), and which one
 * the page and the lists show.
 */
export interface PrReview {
  pr: PrRef
  results: Partial<Record<ReviewFormat, ReviewResult>>
  /** The result the page and the lists show: the one started last, or the user's pick. */
  shown: ReviewFormat
  /** Published to GitHub by the user's button. */
  posted: { at: number; url: string } | null
}

/** A result of `format` before its run has recorded anything. */
export const emptyResult = (format: ReviewFormat, sessionId: string): ReviewResult => ({ format, sessionId, problem: '', approach: '', verdict: null, findings: [], head: null, at: null })

/** The result the page and the lists show; null before any run of that format. */
export function shownResult(review: PrReview | null | undefined): ReviewResult | null {
  return review?.results[review.shown] ?? null
}

/** A review as stored before review-v2-part-2-v1-2.1: one result, its fields on the review. */
export interface LegacyPrReview {
  pr: PrRef
  posted: { at: number; url: string } | null
  problem?: string
  approach?: string
  verdict?: PrVerdict | null
  findings?: ReviewFinding[]
  report?: ReviewReport
  head?: string | null
  at?: number | null
}

/**
 * A stored review in today's form (review-v2-part-2-v1-2.1): one of before keeps its result as v2 when it has a report
 * (with the user's direction call and its draft), else as v1; one never reviewed has no result yet. `sessionId`: the
 * review's owner topic, which ran it. A review in today's form stays as it is.
 */
export function migratePrReview(raw: PrReview | LegacyPrReview, sessionId?: string | null): PrReview {
  if ('results' in raw && raw.results) return { pr: raw.pr, results: raw.results, shown: raw.shown === 'v1' ? 'v1' : 'v2', posted: raw.posted ?? null }
  const old = raw as LegacyPrReview
  const format: ReviewFormat = old.report ? 'v2' : 'v1'
  const reviewed = !!(old.verdict || old.report || old.head)
  const result: ReviewResult = {
    ...emptyResult(format, sessionId ?? ''),
    problem: old.problem ?? '',
    approach: old.approach ?? '',
    verdict: old.verdict ?? null,
    findings: old.findings ?? [],
    ...(old.report ? { report: old.report } : {}),
    head: old.head ?? null,
    at: old.at ?? null,
  }
  return { pr: old.pr, results: reviewed ? { [format]: result } : {}, shown: reviewed ? format : 'v2', posted: old.posted ?? null }
}

/**
 * The format a topic records into (set_pr_review): its own (`reviewFormat`, mag's topic of that format), else the
 * result it runs, the shown one first (a topic that asked for both); null when it runs none.
 */
export function formatOfTopic(review: PrReview, session: Pick<AgentSession, 'id' | 'reviewFormat'> | undefined): ReviewFormat | null {
  if (!session) return null
  if (session.reviewFormat) return session.reviewFormat
  const mine = REVIEW_FORMATS.filter((f) => review.results[f]?.sessionId === session.id)
  return mine.includes(review.shown) ? review.shown : (mine[0] ?? null)
}

/** The topics that may record a review: its owner and the topic of each result. */
export function reviewTopicIds(task: Pick<Task, 'ownerSessionId' | 'prReview'>): string[] {
  const ids = [task.ownerSessionId, ...REVIEW_FORMATS.map((f) => task.prReview?.results[f]?.sessionId)]
  return [...new Set(ids.filter((id): id is string => !!id))]
}

/** Whether a result of a format is missing or older than the PR's head: its Run button offers a run. */
export function resultOutdated(review: PrReview, format: ReviewFormat): boolean {
  const r = review.results[format]
  return !r?.at || r.head !== review.pr.head
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
  const r = shownResult(task.prReview)
  return !!r?.verdict && r.head === task.prReview!.pr.head
}

/** The line in Needs you once a review is ready: "Review ready: Request changes · 2 blockers". */
export function reviewReadyText(review: PrReview): string {
  return `Review ready: ${resultLine(shownResult(review)) || '—'}`
}

/** A result's verdict line: its report's, else "Request changes · 2 blockers"; empty before it has one. */
export function resultLine(r: ReviewResult | null): string {
  if (r?.report) return reportLine(r.report)
  return r?.verdict ? `${PR_VERDICT_LABELS[r.verdict]} · ${findingCounts(r.findings)}` : ''
}

/** The verdict a PR review keeps for GitHub from a report's checks verdict: look is a comment. */
export function prVerdictOf(checks: ChecksVerdict): PrVerdict {
  return checks === 'look' ? 'comment' : checks
}

/** A topic of a review (its owner, or the run of either format) is in a turn. */
export function reviewRunning(task: Pick<Task, 'ownerSessionId' | 'prReview'>, sessions: AgentSession[]): boolean {
  const ids = reviewTopicIds(task)
  return sessions.some((s) => ids.includes(s.id) && s.status === 'running')
}

/**
 * Where a review stands, the same in every view (reviews-normalnyi-ux-stan-reviu.1): closed (not in progress);
 * reviewing (its owner topic is in a turn); question (it asks the user); ready (a verdict on the PR's head); failed (its
 * owner topic ended in an error); outdated (a verdict on an older head); waiting (no verdict yet).
 */
export type ReviewState = 'reviewing' | 'question' | 'ready' | 'failed' | 'outdated' | 'waiting' | 'closed'

/**
 * A review's state, from its shown result (review-v2-part-2-v1-2.1); reviewing while a run of either format is in a
 * turn. A verdict on the current head outranks an errored topic: a borrowed topic that fails later keeps it ready.
 */
export function reviewState(task: Pick<Task, 'status' | 'ownerSessionId' | 'needsInput' | 'prReview'>, sessions: AgentSession[]): ReviewState {
  if (task.status !== 'in_progress') return 'closed'
  if (reviewRunning(task, sessions)) return 'reviewing'
  if (task.needsInput) return 'question'
  if (reviewReady(task)) return 'ready'
  const shown = shownResult(task.prReview)
  const topic = sessions.find((s) => s.id === (shown?.sessionId || task.ownerSessionId))
  if (topic?.status === 'error') return 'failed'
  if (shown?.verdict) return 'outdated'
  return 'waiting'
}

/** A review's line in a list: its state with its detail, "Request changes · 2 blockers", "the agent is reviewing…". */
export function reviewLine(task: Pick<Task, 'status' | 'ownerSessionId' | 'needsInput' | 'prReview'>, sessions: AgentSession[]): string {
  const verdict = resultLine(shownResult(task.prReview))
  switch (reviewState(task, sessions)) {
    case 'closed':
      return 'closed'
    case 'reviewing':
      return 'the agent is reviewing…'
    case 'question':
      return `asks: ${task.needsInput}`
    case 'ready':
      return verdict
    case 'failed':
      return 'the agent failed: review again'
    case 'outdated':
      return `${verdict} · new commits since`
    case 'waiting':
      return 'waits for the agent'
  }
}

/** The job mag gave a review's topic before `reviewOf` was recorded: it opens with this. */
const legacyJob = (url: string) => `Review the PR ${url} `

/**
 * The topic mag created for a review (`reviewOf`). Legacy: its owner topic whose first item is the job as a user item.
 * A topic of the user that asked for the review (review_pr) is never it.
 */
export function reviewTopic(task: Pick<Task, 'id' | 'ownerSessionId' | 'prReview'>, sessions: AgentSession[]): AgentSession | undefined {
  const own = sessions.find((s) => s.reviewOf === task.id)
  if (own) return own
  const owner = sessions.find((s) => s.id === task.ownerSessionId && s.role === 'chat' && !s.taskId)
  const first = owner?.items[0]
  return task.prReview && first?.kind === 'user' && first.text.startsWith(legacyJob(task.prReview.pr.url)) ? owner : undefined
}

/** The open review a topic owns, if any. */
export function reviewOfTopic(tasks: Task[], sessionId: string): Task | undefined {
  return tasks.find((t) => isReview(t) && t.status === 'in_progress' && t.ownerSessionId === sessionId)
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
  return live.head && shownResult(review)?.head && live.head !== review.pr.head ? 'rereview' : null
}
