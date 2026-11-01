import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { TaskWork } from '@mag/core'

const exec = promisify(execFile)

async function run(cmd: string, args: string[], cwd?: string) {
  const { stdout } = await exec(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false)

export async function repoInfo(repo: string): Promise<{ git: boolean; origin: string | null }> {
  const git = await ok(run('git', ['rev-parse', '--git-dir'], repo))
  const origin = git ? await run('git', ['remote', 'get-url', 'origin'], repo).catch(() => null) : null
  return { git, origin }
}

/** Create (or reuse) a worktree for the task branch, starting from the freshest base. */
export async function prepareWorktree(repo: string, base: string, branch: string, dir: string) {
  if (existsSync(dir)) return
  const info = await repoInfo(repo)
  if (!info.git) throw new Error(`${repo} is not a git repository. Run git init there and add a GitHub remote (e.g. gh repo create).`)
  if (!(await ok(run('git', ['rev-parse', '--verify', 'HEAD'], repo)))) throw new Error(`${repo} has no commits yet. Make an initial commit on ${base}.`)
  mkdirSync(dirname(dir), { recursive: true })
  await ok(run('git', ['fetch', 'origin', base], repo))
  const start = (await ok(run('git', ['rev-parse', '--verify', `origin/${base}`], repo))) ? `origin/${base}` : base
  const branchExists = await ok(run('git', ['rev-parse', '--verify', branch], repo))
  if (branchExists) await run('git', ['worktree', 'add', dir, branch], repo)
  else await run('git', ['worktree', 'add', '-b', branch, dir, start], repo)
}

export async function removeWorktree(repo: string, dir: string) {
  await ok(run('git', ['worktree', 'remove', '--force', dir], repo))
}

/** Uncommitted files of a checkout (untracked ones too), as git status names them. */
export async function dirtyFiles(repo: string): Promise<string[]> {
  // -z: names as they are; a rename or copy is followed by its old name, which is skipped.
  const { stdout } = await exec('git', ['status', '--porcelain', '-z', '-uall'], { cwd: repo, maxBuffer: 10 * 1024 * 1024 })
  const entries = stdout.split('\0')
  const files: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    files.push(e.slice(3))
    if (/^[RC]/.test(e)) i++
  }
  return files
}

/** The checkout's current branch; empty on a detached HEAD. */
export async function currentBranch(repo: string): Promise<string> {
  return run('git', ['branch', '--show-current'], repo)
}

/**
 * Local mode (T-50): puts the main checkout on `branch`, new from the freshest base, or the existing branch. git carries
 * uncommitted changes over and fails (changing nothing) if they conflict.
 */
export async function checkoutLocal(repo: string, base: string, branch: string) {
  const info = await repoInfo(repo)
  if (!info.git) throw new Error(`${repo} is not a git repository`)
  await ok(run('git', ['fetch', 'origin', base], repo))
  if (await ok(run('git', ['rev-parse', '--verify', `refs/heads/${branch}`], repo))) return void (await run('git', ['checkout', branch], repo))
  const start = (await ok(run('git', ['rev-parse', '--verify', `origin/${base}`], repo))) ? `origin/${base}` : base
  await run('git', ['checkout', '--no-track', '-b', branch, start], repo)
}

/** Stashes every uncommitted change (untracked files too) under `message`. */
export async function stash(repo: string, message: string) {
  await run('git', ['stash', 'push', '-u', '-m', message], repo)
}

/** Whether `ref` (a worktree's HEAD, or a branch) has commits that are not on the base yet. A missing checkout has none. */
export async function hasOwnCommits(worktree: string, base: string, ref = 'HEAD'): Promise<boolean> {
  if (!existsSync(worktree)) return false
  const from = (await ok(run('git', ['rev-parse', '--verify', `origin/${base}`], worktree))) ? `origin/${base}` : base
  const count = await run('git', ['rev-list', '--count', `${from}..${ref}`], worktree).catch(() => '0')
  return Number(count) > 0
}

/**
 * Repositories (RepoWork.repo) of a task whose branch has commits of its own. Merged ones count as changed. A local
 * repository counts by its branch: the user may have switched the checkout since.
 */
export async function changedRepos(work: TaskWork, base: string): Promise<string[]> {
  const flags = await Promise.all(work.repos.map((r) => (r.prState === 'merged' ? true : hasOwnCommits(r.worktree, base, r.local ? r.branch : 'HEAD'))))
  return work.repos.filter((_, i) => flags[i]).map((r) => r.repo)
}

export interface PrFeedback {
  author: string
  body: string
  at: number
  where?: string
}

export interface PrStatus {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  feedback: PrFeedback[]
}

/** Agents prefix their GitHub comments with this so we don't react to ourselves. */
export const AGENT_MARK = '[mag]'

export async function prState(url: string): Promise<{ state: PrStatus['state']; draft: boolean; head: string | null }> {
  const view = JSON.parse(await run('gh', ['pr', 'view', url, '--json', 'state,isDraft,headRefOid']))
  return { state: view.state, draft: !!view.isDraft, head: view.headRefOid || null }
}

export async function prFeedback(url: string): Promise<PrFeedback[]> {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error(`Not a PR url: ${url}`)
  const [, owner, repo, num] = m
  const view = JSON.parse(await run('gh', ['pr', 'view', url, '--json', 'comments,reviews']))
  const inline = JSON.parse(await run('gh', ['api', `repos/${owner}/${repo}/pulls/${num}/comments`]))

  const feedback: PrFeedback[] = [
    ...view.comments.map((c: any) => ({ author: c.author?.login ?? '?', body: c.body, at: Date.parse(c.createdAt) })),
    ...view.reviews
      .filter((r: any) => r.body?.trim())
      .map((r: any) => ({ author: r.author?.login ?? '?', body: r.body, at: Date.parse(r.submittedAt) })),
    ...inline.map((c: any) => ({
      author: c.user?.login ?? '?',
      body: c.body,
      at: Date.parse(c.created_at),
      where: `${c.path}:${c.line ?? c.original_line ?? ''}`,
    })),
  ].filter((f) => !f.body.trimStart().startsWith(AGENT_MARK))

  return feedback
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}
