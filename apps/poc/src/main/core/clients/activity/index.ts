// Activity (who-is-who-people-from.2), read-only: pull requests with their reviews through gh, Jira work items through
// acli; the raw facts "where they work" and PR stats are counted from.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { githubRepo } from '../../lib/github-remote/index.ts'

export interface PrReview {
  /** GitHub login, lower case. */
  author: string
  /** ms. */
  at: number
}

export interface Pr {
  /** The repository's path as passed to prs. */
  repo: string
  number: number
  title: string
  url: string
  /** GitHub login, lower case; null: a deleted user. */
  author: string | null
  /** ms. */
  createdAt: number
  mergedAt: number | null
  reviews: PrReview[]
}

export interface Ticket {
  key: string
  /** Atlassian accountIds. */
  assignee: string | null
  reporter: string | null
  /** ms. */
  updatedAt: number
}

export interface Activity {
  /** PRs of each GitHub repo of `repos` (paths; other hosts skipped) updated since `from` and created by `to` (ms), with reviews; bots left out. */
  prs(repos: string[], from: number, to: number): Promise<Pr[]>
  /** Work items matching `jql`, at most TICKET_LIMIT. */
  tickets(jql: string): Promise<Ticket[]>
}

/** Runs a command, its stdout; rejects when it fails. */
export type Run = (cmd: string, args: string[], cwd?: string) => Promise<string>

/** PRs per repo gh is asked for: its search's cap. */
export const PR_LIMIT = 1000
export const TICKET_LIMIT = 2000

const exec = promisify(execFile)
const defaultRun: Run = async (cmd, args, cwd) => (await exec(cmd, args, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const time = (v: unknown) => (typeof v === 'string' && v ? Date.parse(v) : NaN)
type GhUser = { login?: string; is_bot?: boolean } | null | undefined
const login = (u: GhUser) => (u?.login && !u.is_bot && !/\[bot\]$/i.test(u.login) ? u.login.toLowerCase() : null)

/** gh pr list's JSON as Prs of `repo`; reviews without an author or a time dropped. */
export function parsePrs(repo: string, json: string): Pr[] {
  const out: Pr[] = []
  for (const p of JSON.parse(json) as Record<string, unknown>[]) {
    const createdAt = time(p.createdAt)
    if (typeof p.number !== 'number' || Number.isNaN(createdAt)) continue
    const author = p.author as GhUser
    if (author && !login(author) && author.login) continue
    const reviews: PrReview[] = []
    for (const r of (p.reviews ?? []) as { author?: GhUser; submittedAt?: string }[]) {
      const who = login(r.author)
      const at = time(r.submittedAt)
      if (who && !Number.isNaN(at)) reviews.push({ author: who, at })
    }
    const merged = time(p.mergedAt)
    out.push({ repo, number: p.number, title: String(p.title ?? ''), url: String(p.url ?? ''), author: login(author), createdAt, mergedAt: Number.isNaN(merged) ? null : merged, reviews })
  }
  return out
}

/** acli's work items JSON as Tickets. */
export function parseTickets(json: string): Ticket[] {
  const out: Ticket[] = []
  for (const item of JSON.parse(json) as { key?: string; fields?: Record<string, { accountId?: string } | string | null> }[]) {
    if (!item.key) continue
    const f = item.fields ?? {}
    const id = (v: unknown) => (v && typeof v === 'object' && typeof (v as { accountId?: unknown }).accountId === 'string' ? (v as { accountId: string }).accountId : null)
    out.push({ key: item.key, assignee: id(f.assignee), reporter: id(f.reporter), updatedAt: time(f.updated) || 0 })
  }
  return out
}

export function createActivity(opts: { run?: Run } = {}): Activity {
  const run = opts.run ?? defaultRun
  return {
    async prs(repos, from, to) {
      const out: Pr[] = []
      for (const repo of repos) {
        const gh = githubRepo(await run('git', ['remote', 'get-url', 'origin'], repo).catch(() => ''))
        if (!gh) continue
        const json = await run('gh', ['pr', 'list', '--repo', `${gh.owner}/${gh.name}`, '--state', 'all', '--search', `updated:>=${day(from)} created:<=${day(to)}`, '--limit', String(PR_LIMIT), '--json', 'number,title,url,author,createdAt,mergedAt,reviews'])
        out.push(...parsePrs(repo, json))
      }
      return out
    },

    async tickets(jql) {
      return parseTickets(await run('acli', ['jira', 'workitem', 'search', '--jql', jql, '--fields', 'key,assignee,reporter,updated', '--limit', String(TICKET_LIMIT), '--json']))
    },
  }
}
