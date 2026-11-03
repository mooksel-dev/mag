import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoFixOf, ciState, prProblems, type RepoWork, type TaskWork } from './index.ts'

test('ciState: a failed check wins, then a running one; no checks is none (ux-odna-rozmova-na-robotu.1)', () => {
  assert.equal(ciState([{ bucket: 'pass' }, { bucket: 'fail' }, { bucket: 'pending' }]), 'fail')
  assert.equal(ciState([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending')
  assert.equal(ciState([{ bucket: 'pass' }, { bucket: 'skipping' }, { bucket: 'cancel' }]), 'pass')
  assert.equal(ciState([]), 'none')
})

const repo = (patch: Partial<RepoWork>): RepoWork => ({ repo: '/r', branch: 'b', worktree: '/w', prUrl: 'https://github.com/a/b/pull/1', prState: 'open', ...patch })
const work = (...repos: RepoWork[]): TaskWork => ({ repos, dir: '/d', feedbackSeenAt: 0 })

test('prProblems: CI first, then a conflict; a pending CI or an unknown mergeability clears nothing (ux-odna-rozmova-na-robotu.1)', () => {
  assert.deepEqual(prProblems(work(repo({ ci: 'fail', mergeable: 'conflict' }))), { problem: 'ci', cleared: [] })
  assert.deepEqual(prProblems(work(repo({ ci: 'pass', mergeable: 'conflict' }))), { problem: 'conflict', cleared: ['ci'] })
  assert.deepEqual(prProblems(work(repo({ ci: 'pending', mergeable: 'unknown' }))), { problem: null, cleared: [] })
  assert.deepEqual(prProblems(work(repo({ ci: 'none', mergeable: 'clean' }), repo({ ci: 'pass', mergeable: 'clean' }))), { problem: null, cleared: ['ci', 'conflict'] })
  // No checks yet (just pushed): not a fix.
  assert.deepEqual(prProblems(work(repo({ ci: 'none', mergeable: 'clean' }))), { problem: null, cleared: ['conflict'] })
  // Merged or closed PRs and repos without one do not count.
  assert.deepEqual(prProblems(work(repo({ ci: 'fail', prState: 'merged', mergeable: 'clean' }), repo({ ci: 'pass', mergeable: 'clean' }), repo({ prUrl: null, prState: null }))), { problem: null, cleared: ['ci', 'conflict'] })
})

test('autoFixOf: none before the first try', () => {
  assert.deepEqual(autoFixOf({}), { ci: 0, conflict: 0, continue: 0 })
  assert.deepEqual(autoFixOf({ autoFix: { ci: 1, conflict: 0, continue: 1 } }), { ci: 1, conflict: 0, continue: 1 })
})
