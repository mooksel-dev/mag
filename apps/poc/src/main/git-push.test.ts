import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedPush } from './git-push.ts'

const BASES = ['main', 'develop']

test('blockedPush: a push that names no target branch is blocked, since in a checkout on main it goes to main (topics-a-tree-of-agent.1)', () => {
  for (const c of [
    'git push',
    'git push origin',
    'git push -u origin',
    'git push origin HEAD',
    'git push -u origin HEAD',
    'git push origin @',
    'git push origin HEAD~1',
    'git -C /r push',
    'git -C "/Users/me/my repo" push origin',
    'git --no-pager -c push.default=current push',
    'git add . && git commit -m "x; y" && git push',
    'cd /r; git push origin',
    'git push --all origin',
    'git push --mirror origin',
    'git push origin refs/heads/*:refs/heads/*',
    'GIT_TRACE=1 git push origin',
    'git push -o ci.skip origin',
  ])
    assert.match(blockedPush(c, BASES) ?? '', /does not name the branch/, c)
})

test('blockedPush: a push to a base branch is blocked however it is spelled', () => {
  for (const c of ['git push origin main', 'git push origin HEAD:main', 'git push origin +main', 'git push origin feat:refs/heads/develop', 'git push origin :main', 'git push --delete origin main', 'git push origin feat main'])
    assert.match(blockedPush(c, BASES) ?? '', /pushes to the base branch/, c)
})

test('blockedPush: a named feature branch, tags and anything but git push pass', () => {
  for (const c of [
    'git push origin fix-typo',
    'git push -u origin fix-typo',
    'git -C /r push origin HEAD:fix-typo',
    'git push origin feat:feat',
    'git push origin --tags',
    'git push origin refs/tags/v1',
    'git status && git log --oneline',
    'echo "git push"',
    'gh pr comment 4 -b "git push"',
    'git commit -m "git push"',
  ])
    assert.equal(blockedPush(c, BASES), null, c)
})
