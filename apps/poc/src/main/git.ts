import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { TaskWork } from '@mag/core'
import type { FileDiff, Hunk } from '@mag/diff'

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

/** Every file of the commit `sha`, with its blob sha (T-57). */
export async function treeAt(repo: string, sha: string): Promise<{ path: string; blob: string }[]> {
  const { stdout } = await exec('git', ['ls-tree', '-r', '-z', '--full-tree', sha], { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t')
      const [, type, blob] = e.slice(0, tab).split(' ')
      return { type, blob, path: e.slice(tab + 1) }
    })
    .filter((e) => e.type === 'blob')
    .map(({ path, blob }) => ({ path, blob }))
}

/** Contents of blobs by sha, read in one `git cat-file --batch`. */
export function blobs(repo: string, shas: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repo })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`))
      const buf = Buffer.concat(chunks)
      const out = new Map<string, string>()
      let at = 0
      while (at < buf.length) {
        const nl = buf.indexOf(10, at)
        if (nl < 0) break
        const [sha, type, size] = buf.subarray(at, nl).toString().split(' ')
        if (type === 'missing') {
          at = nl + 1
          continue
        }
        const n = Number(size)
        out.set(sha, buf.subarray(nl + 1, nl + 1 + n).toString('utf8'))
        at = nl + 1 + n + 1
      }
      resolve(out)
    })
    child.stdin.end(shas.join('\n') + '\n')
  })
}

/** Changed files between two commits with zero-context hunks; renames detected (T-57). */
export async function diffHunks(repo: string, base: string, head: string): Promise<FileDiff[]> {
  return parseDiff(await diffText(repo, base, head))
}

/** The zero-context diff between two commits as git prints it, renames detected: the text diffHunks parses. */
export async function diffText(repo: string, base: string, head: string): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--unified=0', base, head], { cwd: repo, maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

/** The lines (`-…`, `+…`) of one hunk of `path` (its path at head; at base when deleted) in a diffText; [] if absent. */
export function hunkLines(text: string, path: string, hunk: Hunk): string[] {
  const range = (start: number, lines: number) => `${start}${lines === 1 ? '' : `,${lines}`}`
  const header = `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`
  for (const file of parseDiffSections(text)) {
    if (file.path !== path) continue
    const at = file.lines.findIndex((l) => l.startsWith(header))
    if (at < 0) continue
    const out: string[] = []
    for (const l of file.lines.slice(at + 1)) {
      if (out.length === hunk.oldLines + hunk.newLines || !/^[-+\\]/.test(l)) break
      if (!l.startsWith('\\')) out.push(l)
    }
    return out
  }
  return []
}

/** A diffText split by file, with the path parseDiff gives each. */
function parseDiffSections(text: string): { path: string; lines: string[] }[] {
  const parts = text.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '))
  return parts.map((part) => ({ path: parseDiff(part)[0]?.path ?? '', lines: part.split('\n') }))
}

/** A unified diff, as `git diff --unified=0` prints it, into files and hunks. */
export function parseDiff(text: string): FileDiff[] {
  const out: FileDiff[] = []
  let cur: { old: string | null; new: string | null; renameFrom?: string; renameTo?: string; hunks: FileDiff['hunks'] } | null = null
  const flush = () => {
    if (!cur) return
    const from = cur.renameFrom ?? cur.old
    const to = cur.renameTo ?? cur.new
    if (to && from && (cur.renameFrom || from !== to)) out.push({ path: to, oldPath: from, status: 'rename', hunks: cur.hunks })
    else if (to && !from) out.push({ path: to, status: 'add', hunks: cur.hunks })
    else if (from && !to) out.push({ path: from, status: 'del', hunks: cur.hunks })
    else if (to) out.push({ path: to, status: 'mod', hunks: cur.hunks })
    cur = null
  }
  const strip = (p: string) => (p === '/dev/null' ? null : p.replace(/^[ab]\//, '').replace(/\t$/, ''))
  // Lines of the current hunk still to come: a removed line may itself start with "--- ".
  let left = 0
  for (const line of text.split('\n')) {
    if (left > 0 && /^[-+ ]/.test(line)) {
      left--
      continue
    }
    if (line.startsWith('\\')) continue
    left = 0
    if (line.startsWith('diff --git ')) {
      flush()
      // Paths from the header for diffs without ---/+++ (pure renames, mode changes, binaries); the lines below win.
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      cur = { old: m?.[1] ?? null, new: m?.[2] ?? null, hunks: [] }
    } else if (!cur) continue
    else if (line.startsWith('new file mode')) cur.old = null
    else if (line.startsWith('deleted file mode')) cur.new = null
    else if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12)
    else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10)
    else if (line.startsWith('--- ')) cur.old = strip(line.slice(4))
    else if (line.startsWith('+++ ')) cur.new = strip(line.slice(4))
    else if (line.startsWith('@@ ')) {
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!h) continue
      const hunk = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4] }
      cur.hunks.push(hunk)
      left = hunk.oldLines + hunk.newLines
    }
  }
  flush()
  return out
}

/** The commit `ref` points to. */
export const revParse = (repo: string, ref: string) => run('git', ['rev-parse', '--verify', `${ref}^{commit}`], repo)

/** Where `head` branched off `base`. */
export const mergeBase = (repo: string, base: string, head: string) => run('git', ['merge-base', base, head], repo)
