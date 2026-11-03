import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.ts'
import { startScheduler } from './scheduler.ts'
import type { Orchestrator } from './orchestrator.ts'

/** gh as the scheduler calls it: the PR from `pr`, its checks from `checks` (exit 1 when one failed, as gh does). */
function fakeGh(dir: string) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const config = join(dir, 'gh.json')
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const c = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(config)}, 'utf8'))
const a = process.argv.slice(2)
if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: 'h1', comments: [], reviews: [], mergeable: c.mergeable }))
else if (a[0] === 'pr' && a[1] === 'checks') { process.stdout.write(JSON.stringify(c.checks)); if (c.checks.some((x) => x.bucket === 'fail')) process.exit(1) }
else if (a[0] === 'api') process.stdout.write('[]')
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
