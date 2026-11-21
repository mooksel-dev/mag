import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Deliverable } from './core/services/deliverables/index.ts'
import type { NewInboxItem } from './core/services/inbox/index.ts'
import type { Pack } from './core/services/packs/index.ts'
import { createRoutines, type Routine, type RoutineRun } from './core/services/routines/index.ts'
import { createRoutineRunner, failedKey, type DrafterRun } from './routine-run.ts'
import { routineOfRef } from './core/services/routines/refs.ts'

function memoryRoutines(now: () => number) {
  const rows = { routines: [] as Routine[], runs: [] as RoutineRun[] }
  const put = <T extends { id: string }>(list: T[], x: T) => {
    const i = list.findIndex((y) => y.id === x.id)
    if (i >= 0) list[i] = x
    else list.push(x)
  }
  return createRoutines({
    kinds: ['report'],
    now,
    records: {
      routines: () => rows.routines,
      putRoutine: (r) => put(rows.routines, r),
      removeRoutine: (id) => void (rows.routines = rows.routines.filter((r) => r.id !== id)),
      runs: () => rows.runs,
      putRun: (r) => put(rows.runs, r),
      removeRuns: (ids) => void (rows.runs = rows.runs.filter((r) => !ids.includes(r.id))),
    },
  })
}

const PACK: Pack = { kind: 'report', prompt: { text: 'Write the weekly report.', path: '/p/prompt.md', scope: 'workspace' }, template: null, rubric: null, rules: [{ text: '- Hyphens only', path: '/p/rules.md', scope: 'workspace' }] }

function setup(opts: { last?: boolean; draftThrows?: boolean } = {}) {
  const clock = { t: new Date(2026, 10, 17, 12, 0).getTime() }
  const routines = memoryRoutines(() => clock.t)
  const docs = new Map<string, Deliverable>()
  const calls = { draft: [] as unknown[][], lastFinal: [] as unknown[][], prompts: [] as string[], inbox: [] as NewInboxItem[], resolved: [] as string[], stopped: [] as string[] }
  const last = { id: 'd0', slug: 'ups-downs-nov-12', title: 'Ups & Downs Nov 12', versions: [{ n: 1 }] } as unknown as Deliverable
  let end: (v: { error: string | null }) => void = () => {}
  const runner = createRoutineRunner({
    routines,
    deliverables: {
      draft: (...args) => {
        calls.draft.push(args)
        if (opts.draftThrows) throw new Error('disk full')
        const d = { id: 'd1', slug: 'ups-downs', title: 'Ups & Downs', versions: [{ n: 1 }] } as unknown as Deliverable
        docs.set(d.id, d)
        return d
      },
      lastFinal: (...args) => {
        calls.lastFinal.push(args)
        return opts.last ? last : null
      },
      refOf: (d) => `acme:dlv:${d.slug}`,
      get: (id) => {
        const d = docs.get(id)
        if (!d) throw new Error(`No deliverable ${id}`)
        return d
      },
    },
    inbox: { add: (i) => void calls.inbox.push(i), resolve: (k) => void calls.resolved.push(k) },
    pack: (ws, kind) => (assert.deepEqual([ws, kind], ['w1', 'report']), PACK),
    origin: (ws) => ({ workspaceId: ws, folder: 'acme', projectId: null, topicId: null, taskId: null }),
    labelNames: (ids) => ids.map((id) => ({ l1: 'Data Removal', l2: 'Money Problems' })[id] ?? id),
    startDrafter: (_r, _run, prompt): DrafterRun => {
      calls.prompts.push(prompt)
      return { sessionId: 's1', done: new Promise((done) => (end = done)) }
    },
    stop: async (sid) => void calls.stopped.push(sid),
    timeoutMs: 50,
  })
  const routine = routines.save({ workspaceId: 'w1', title: 'Ups & Downs', schedule: '0 9 * * thu', kind: 'report', brief: 'UPS and DOWNS per epic', sources: ['jira:PRVP'], labels: ['l1', 'l2'] })
  clock.t = new Date(2026, 10, 19, 9, 0).getTime()
  const save = () => docs.get('d1')!.versions.push({ n: 2 } as Deliverable['versions'][number])
  return { clock, routines, runner, routine, calls, end: (v: { error: string | null }) => end(v), save }
}

test('a run: pack, previous issue and sources go to a headless drafter; its draft lands in the Inbox', async () => {
  const { runner, routine, routines, calls, end, save } = setup({ last: true })
  const { run, done } = runner.run(routine.id, 'slot')
  assert.equal(run.status, 'running')
  assert.deepEqual(calls.lastFinal, [['report', ['Data Removal', 'Money Problems'], 'w1']])
  assert.deepEqual(calls.draft[0].slice(0, 3), ['report', 'Ups & Downs\nUPS and DOWNS per epic', ['jira:PRVP', 'acme:dlv:ups-downs-nov-12']])
  assert.deepEqual(calls.draft[0][4], ['Data Removal', 'Money Problems'])
  const prompt = calls.prompts[0]
  for (const part of ['save_deliverable(ref "acme:dlv:ups-downs"', '["Data Removal","Money Problems"]', '- jira:PRVP', 'read("acme:dlv:ups-downs-nov-12")', 'Write the weekly report.', '- Hyphens only', 'Never publish']) assert.ok(prompt.includes(part), part)
  assert.equal(routines.runs(routine.id)[0].sessionId, 's1')
  save()
  end({ error: null })
  const ended = await done
  assert.deepEqual([ended.status, ended.deliverableRef, ended.error], ['drafted', 'acme:dlv:ups-downs', null])
  assert.deepEqual(calls.inbox, [{ key: `routine:${routine.id}:draft:${run.id}`, kind: 'draft', text: 'Draft to review: Ups & Downs', workspaceId: 'w1', ref: 'acme:dlv:ups-downs', labels: ['l1', 'l2'] }])
  assert.deepEqual(calls.resolved, [failedKey(routine.id)])
})

test('a drafter that ends without saving fails the run: an Inbox item with the error, whose ref Retry runs', async () => {
  const { runner, routine, calls, end } = setup()
  const { done } = runner.run(routine.id, 'now')
  assert.ok(calls.prompts[0].includes('Previous issue: none yet.'))
  end({ error: 'rate limited' })
  const ended = await done
  assert.deepEqual([ended.status, ended.error, ended.deliverableRef], ['failed', 'rate limited', 'acme:dlv:ups-downs'])
  assert.equal(calls.inbox[0].key, failedKey(routine.id))
  assert.equal(calls.inbox[0].text, 'Ups & Downs failed: rate limited')
  assert.equal(routineOfRef(calls.inbox[0].ref), routine.id)
})

test('a drafter past its time is stopped and the run fails with the timeout', async () => {
  const { runner, routine, calls } = setup()
  const ended = await runner.run(routine.id, 'now').done
  assert.deepEqual(calls.stopped, ['s1'])
  assert.match(ended.error!, /timed out/)
  assert.equal(calls.inbox[0].key, failedKey(routine.id))
})

test('a failure before the session (the draft) fails the run; a run going on blocks another', async () => {
  const { runner, routine, calls } = setup({ draftThrows: true })
  const ended = await runner.run(routine.id, 'now').done
  assert.deepEqual([ended.status, ended.error], ['failed', 'disk full'])
  assert.equal(calls.prompts.length, 0)
  const again = setup()
  again.runner.run(again.routine.id, 'now')
  assert.throws(() => again.runner.run(again.routine.id, 'slot'), /running already/)
})
