import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoWork } from '@mag/core'
import { changedRepos, defaultBranch } from './git.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

/** A repository with one commit on `branch`, no remote. */
function repo(path: string, branch: string) {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', branch)
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init')
  return path
}

const work = (r: Partial<RepoWork> & Pick<RepoWork, 'repo' | 'worktree'>): RepoWork => ({ branch: 'mag/x', prUrl: null, prState: null, ...r })

test('defaultBranch: origin/HEAD of a clone; asks the remote when it is missing; the fallback without a remote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-git-'))
  const origin = repo(join(dir, 'origin'), 'master')
  const clone = join(dir, 'clone')
  git(dir, 'clone', '-q', origin, clone)
  assert.equal(await defaultBranch(clone, 'main'), 'master')
  git(clone, 'remote', 'set-head', 'origin', '-d')
  assert.equal(await defaultBranch(clone, 'main'), 'master', 'origin/HEAD set again from the remote')
  assert.equal(await defaultBranch(repo(join(dir, 'alone'), 'master'), 'main'), 'main', 'no remote: the fallback')
  assert.equal(await defaultBranch(join(dir, 'missing'), 'dev'), 'dev', 'no repository: the fallback')
})

test('changedRepos: each repository against its own base, the fallback for one without', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-git-'))
  const lisa = repo(join(dir, 'lisa'), 'master')
  const app = repo(join(dir, 'app'), 'main')
  const lisaTree = join(dir, 'w', 'lisa')
  const appTree = join(dir, 'w', 'app')
  git(lisa, 'worktree', 'add', '-q', '-b', 'mag/x', lisaTree, 'master')
  git(app, 'worktree', 'add', '-q', '-b', 'mag/x', appTree, 'main')
  git(lisaTree, 'commit', '-q', '--allow-empty', '-m', 'change')
  const repos = [work({ repo: lisa, worktree: lisaTree, base: 'master' }), work({ repo: app, worktree: appTree })]
  assert.deepEqual(await changedRepos({ dir, feedbackSeenAt: 0, repos }, 'main'), [lisa])
  git(appTree, 'commit', '-q', '--allow-empty', '-m', 'change')
  assert.deepEqual(await changedRepos({ dir, feedbackSeenAt: 0, repos }, 'main'), [lisa, app])
})
