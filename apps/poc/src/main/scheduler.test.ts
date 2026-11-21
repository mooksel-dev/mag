import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.ts'
import { routineTick, startScheduler } from './scheduler.ts'
import { createRoutines, type Routine, type RoutineRun } from './core/services/routines/index.ts'
import type { Orchestrator } from './orchestrator.ts'
import { projectInbox } from '@mag/core'

/**
 * gh as the scheduler calls it: the PR's state, head, comments, reviews and inline comments (open, h1, none by default),
 * its checks from `checks` (exit 1 when one failed, as gh does).
 */
function fakeGh(dir: string) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const config = join(dir, 'gh.json')
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const c = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(config)}, 'utf8'))
const a = process.argv.slice(2)
if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(JSON.stringify({ state: c.state ?? 'OPEN', isDraft: false, headRefOid: c.head ?? 'h1', comments: c.comments ?? [], reviews: c.reviews ?? [], mergeable: c.mergeable }))
else if (a[0] === 'pr' && a[1] === 'checks') { process.stdout.write(JSON.stringify(c.checks)); if (c.checks.some((x) => x.bucket === 'fail')) process.exit(1) }
else if (a[0] === 'api') process.stdout.write(JSON.stringify(c.inline ?? []))
else process.exit(2)
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  return { set: (c: object) => writeFileSync(config, JSON.stringify(c)), restore: () => void (process.env.PATH = path) }
}

async function until(f: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; !f(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error('timed out')
}

test("scheduler: a step's failed CI, then its conflict, go to fixPr with the details; cleared problems start over (ux-odna-rozmova-na-robotu.1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-sched-'))
  const gh = fakeGh(dir)
  try {
    gh.set({ mergeable: 'MERGEABLE', checks: [{ name: 'test', bucket: 'fail', link: 'https://ci/1' }, { name: 'lint', bucket: 'pass', link: '' }] })
    const store = new Store(join(dir, 'db.json'))
    const project = store.createProject('p')
    const task = store.createTask({ projectId: project.id, title: 'Login', type: 'dev', description: '', status: 'in_progress' })
    const step = store.createTask({ projectId: project.id, title: 's', type: 'dev', description: '', parentId: task.id, status: 'in_progress' })
    const pr = { repo: join(dir, 'app'), branch: 'b', worktree: join(dir, 'w', 'app'), prUrl: 'https://github.com/a/b/pull/1', prState: 'open' as const, checkError: null }
    store.updateTask(step.id, { work: { repos: [pr], dir: join(dir, 'w'), feedbackSeenAt: 0 } })
    const calls: string[] = []
    const orch = {
      isRunning: () => false,
      fixPr: (id: string, problem: string, detail: string) => (calls.push(`fix ${store.task(id).key} ${problem}:\n${detail}`), true),
      clearedPr: (id: string, cleared: string[]) => void (cleared.length && calls.push(`cleared ${cleared.join(',')}`)),
      feedback: () => false,
      review: async () => void calls.push('review'),
      develop: async () => {},
    } as unknown as Orchestrator
    const scheduler = startScheduler(store, orch)
    await until(() => calls.some((c) => c.startsWith('fix')))
    assert.deepEqual(calls, ['cleared conflict', 'fix login.1 ci:\n- app: test (https://ci/1)'])
    assert.deepEqual([store.task(step.id).work!.repos[0].ci, store.task(step.id).work!.repos[0].mergeable], ['fail', 'clean'])

    calls.length = 0
    gh.set({ mergeable: 'CONFLICTING', checks: [{ name: 'test', bucket: 'pass', link: '' }] })
    await scheduler.pollNow()
    assert.deepEqual(calls, ['cleared ci', 'fix login.1 conflict:\n- app: https://github.com/a/b/pull/1'])

    // CI still running, mergeability not known yet: nothing to fix or clear; the review goes on.
    calls.length = 0
    gh.set({ mergeable: 'UNKNOWN', checks: [{ name: 'test', bucket: 'pending', link: '' }] })
    await scheduler.pollNow()
    assert.deepEqual(calls, ['review'])
  } finally {
    gh.restore()
  }
})

test('scheduler: a review work records author replies, new commits and the merge; replies show as review_activity (inbox-what-waits-on-me.1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-sched-'))
  const gh = fakeGh(dir)
  try {
    const url = 'https://github.com/a/b/pull/7'
    gh.set({ head: 'h1', comments: [] })
    const store = new Store(join(dir, 'db.json'))
    const project = store.createProject('p')
    const work = store.createTask({ projectId: project.id, title: 'Review', type: 'review', description: '', status: 'in_progress' })
    const result = { format: 'v1' as const, sessionId: '', problem: '', approach: '', verdict: 'approve' as const, findings: [], head: 'h1', at: 1000 }
    store.updateTask(work.id, { prReview: { pr: { url, repo: 'a/b', outside: true, number: 7, author: 'olena', base: 'main', head: 'h1' }, results: { v1: result }, shown: 'v1', posted: null } })
    const orch = { isRunning: () => false, rereview: async () => {}, develop: async () => {} } as unknown as Orchestrator
    const kinds = () => projectInbox(project.id, store.data.tasks, store.sessionHeaders()).map((i) => [i.kind, i.text])
    const scheduler = startScheduler(store, orch)
    await until(() => !!store.task(work.id).prReview!.activity)
    assert.deepEqual(store.task(work.id).prReview!.activity, { lastSeenAt: 1000, authorReplies: 0, newCommits: false, state: 'open', head: 'h1', at: 0 })
    assert.deepEqual(kinds(), [['review_ready', 'Review ready: Approve · no findings']])

    gh.set({
      head: 'h2',
      comments: [{ author: { login: 'olena' }, body: 'Fixed, see h2', createdAt: new Date(2000).toISOString() }, { author: { login: 'me' }, body: 'ok', createdAt: new Date(2500).toISOString() }, { author: { login: 'olena' }, body: '[mag] bot', createdAt: new Date(2600).toISOString() }],
      reviews: [{ author: { login: 'olena' }, body: 'Old reply', submittedAt: new Date(500).toISOString() }],
      inline: [{ user: { login: 'olena' }, body: 'Done here', created_at: new Date(3000).toISOString(), path: 'a.ts', line: 3 }],
    })
    await scheduler.pollNow()
    const seen = store.task(work.id).prReview!.activity!
    assert.deepEqual([seen.authorReplies, seen.newCommits, seen.state, seen.head], [2, true, 'open', 'h2'])
    assert.ok(seen.at >= 3000)
    assert.deepEqual(kinds(), [['review_activity', 'PR activity: 2 author replies · new commits']])

    gh.set({ state: 'MERGED', head: 'h2' })
    await scheduler.pollNow()
    assert.equal(store.task(work.id).status, 'done')
    assert.equal(store.task(work.id).prReview!.activity!.state, 'merged')
    assert.deepEqual(kinds(), [], 'a merged review waits on nobody')
  } finally {
    gh.restore()
  }
})

test('peopleSyncDue: workspaces with a directory, a day after their last sync (who-is-who-people-from.1)', async () => {
  const { peopleSyncDue, PEOPLE_SYNC_EVERY_MS } = await import('./scheduler.ts')
  const w = (id: string, directories?: object) => ({ id, name: id, profile: '', notes: '', repos: [], agents: {}, integrations: {}, createdAt: 0, ...(directories && { directories }) })
  const last: Record<string, number> = { slack: 0, fresh: 10, orgs: 0 }
  const now = PEOPLE_SYNC_EVERY_MS + 5
  assert.deepEqual(peopleSyncDue([w('none'), w('off', { slack: false, githubOrgs: [] }), w('slack', { slack: true }), w('fresh', { atlassian: true }), w('orgs', { githubOrgs: ['aura'] })], (id) => last[id] ?? 0, now), ['slack', 'orgs'])
})

test('routineTick: a due slot starts once across ticks and a restart; a start that fails is logged, the others run (routines-scheduled-drafts-and-a.1)', async () => {
  const rows = { routines: [] as Routine[], runs: [] as RoutineRun[] }
  const put = <T extends { id: string }>(list: T[], x: T) => {
    const i = list.findIndex((y) => y.id === x.id)
    if (i >= 0) list[i] = x
    else list.push(x)
  }
  const records = {
    routines: () => rows.routines,
    putRoutine: (r: Routine) => put(rows.routines, r),
    removeRoutine: () => {},
    runs: () => rows.runs,
    putRun: (r: RoutineRun) => put(rows.runs, r),
    removeRuns: () => {},
  }
  const clock = { t: new Date(2026, 10, 17, 12).getTime() }
  const open = () => createRoutines({ records, now: () => clock.t })
  let routines = open()
  const a = routines.save({ workspaceId: 'w', name: 'A', trigger: { kind: 'schedule', cron: '0 9 * * thu' }, prompt: 'Do A' })
  const b = routines.save({ workspaceId: 'w', name: 'B', trigger: { kind: 'schedule', cron: '0 9 * * thu' }, prompt: 'Do B' })
  const started: string[] = []
  const run = async (id: string) => {
    if (id === a.id) throw new Error('boom')
    started.push(routines.startRun(id, 'slot').routineId)
  }
  routineTick(routines, run, clock.t)
  assert.deepEqual(started, [])
  clock.t = new Date(2026, 10, 19, 9, 0, 30).getTime()
  routineTick(routines, run, clock.t)
  routineTick(routines, run, clock.t)
  routines = open()
  routineTick(routines, run, clock.t)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(started, [b.id])
})
