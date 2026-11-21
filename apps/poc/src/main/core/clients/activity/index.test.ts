import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createActivity, parsePrs, parseTickets, type Run } from './index.ts'

test('parsePrs: logins lower case, bots and reviews without an author left out', () => {
  const json = JSON.stringify([
    { number: 1, title: 'Fix', url: 'u1', author: { login: 'Bezpaluy89' }, createdAt: '2026-11-01T10:00:00Z', mergedAt: '2026-11-02T10:00:00Z', reviews: [{ author: { login: 'IKoval' }, submittedAt: '2026-11-01T12:00:00Z' }, { author: null, submittedAt: '2026-11-01T12:00:00Z' }, { author: { login: 'coderabbitai', is_bot: true }, submittedAt: '2026-11-01T12:00:00Z' }] },
    { number: 2, title: 'Bump', url: 'u2', author: { login: 'app/dependabot', is_bot: true }, createdAt: '2026-11-01T10:00:00Z', mergedAt: null, reviews: [] },
    { number: 3, title: 'Gone', url: 'u3', author: null, createdAt: '2026-11-01T10:00:00Z', mergedAt: '', reviews: [] },
  ])
  assert.deepEqual(parsePrs('/r', json), [
    { repo: '/r', number: 1, title: 'Fix', url: 'u1', author: 'bezpaluy89', createdAt: Date.parse('2026-11-01T10:00:00Z'), mergedAt: Date.parse('2026-11-02T10:00:00Z'), reviews: [{ author: 'ikoval', at: Date.parse('2026-11-01T12:00:00Z') }] },
    { repo: '/r', number: 3, title: 'Gone', url: 'u3', author: null, createdAt: Date.parse('2026-11-01T10:00:00Z'), mergedAt: null, reviews: [] },
  ])
})

test('parseTickets: key, assignee and reporter accountIds', () => {
  const json = JSON.stringify([{ key: 'PRVP-1', fields: { assignee: { accountId: 'a1' }, reporter: null, updated: '2026-11-01T10:00:00.000+0000' } }, { fields: {} }])
  assert.deepEqual(parseTickets(json), [{ key: 'PRVP-1', assignee: 'a1', reporter: null, updatedAt: Date.parse('2026-11-01T10:00:00.000+0000') }])
})

test('prs: gh pr list per GitHub repo within the dates; other hosts skipped. tickets: acli search', async () => {
  const calls: string[][] = []
  const run: Run = async (cmd, args, cwd) => {
    calls.push([cmd, ...args, cwd ?? ''])
    if (cmd === 'git') return cwd === '/gh' ? 'https://github.com/aura/app.git\n' : 'https://gitlab.com/x/y.git\n'
    if (cmd === 'gh') return '[]'
    return JSON.stringify([{ key: 'A-1', fields: {} }])
  }
  const a = createActivity({ run })
  assert.deepEqual(await a.prs(['/gh', '/gl'], Date.UTC(2026, 8, 1), Date.UTC(2026, 10, 1)), [])
  const gh = calls.filter((c) => c[0] === 'gh')
  assert.equal(gh.length, 1)
  assert.deepEqual(gh[0].slice(0, 9), ['gh', 'pr', 'list', '--repo', 'aura/app', '--state', 'all', '--search', 'updated:>=2026-09-01 created:<=2026-11-01'])
  assert.equal((await a.tickets('project = A')).length, 1)
  assert.deepEqual(calls.at(-1)?.slice(0, 5), ['acli', 'jira', 'workitem', 'search', '--jql'])
})
