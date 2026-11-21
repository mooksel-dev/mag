import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NewInboxItem } from './core/services/inbox/index.ts'
import { createRoutines, type Routine, type RoutineRun } from './core/services/routines/index.ts'
import { createRoutineRunner, failedKey, runKey, runOfKey, type DrafterRun } from './routine-run.ts'
import { routineOfRef } from './core/services/routines/refs.ts'

function memoryRoutines(now: () => number) {
  const rows = { routines: [] as Routine[], runs: [] as RoutineRun[] }
  const put = <T extends { id: string }>(list: T[], x: T) => {
    const i = list.findIndex((y) => y.id === x.id)
    if (i >= 0) list[i] = x
    else list.push(x)
  }
  return createRoutines({
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

type End = { error: string | null; summary: string | null }

function setup(opts: { startThrows?: boolean; projectId?: string } = {}) {
  const clock = { t: new Date(2026, 10, 17, 12, 0).getTime() }
  const routines = memoryRoutines(() => clock.t)
  const calls = { started: [] as { routine: Routine; prompt: string }[], inbox: [] as NewInboxItem[], resolved: [] as string[], stopped: [] as string[] }
  let end: (v: End) => void = () => {}
  const runner = createRoutineRunner({
    routines,
    inbox: { add: (i) => void calls.inbox.push(i), resolve: (k) => void calls.resolved.push(k) },
    folder: () => 'acme',
    startDrafter: (routine, _run, prompt): DrafterRun => {
      if (opts.startThrows) throw new Error('no agent')
      calls.started.push({ routine, prompt })
      return { sessionId: 's1', done: new Promise((done) => (end = done)) }
    },
    stop: async (sid) => void calls.stopped.push(sid),
    timeoutMs: 50,
  })
  const routine = routines.save({ workspaceId: 'w1', name: 'Weekly update', trigger: { kind: 'schedule', cron: '0 9 * * thu' }, prompt: 'Insert this week’s section into the doc.', projectId: opts.projectId ?? null })
  clock.t = new Date(2026, 10, 19, 9, 0).getTime()
  return { routines, runner, routine, calls, end: (v: End) => end(v) }
}

test('a run: the routine prompt goes to a headless session; its last line lands as one Inbox item', async () => {
  const { runner, routine, routines, calls, end } = setup({ projectId: 'p1' })
  const { run, done } = runner.run(routine.id, 'slot')
  assert.equal(run.status, 'running')
  assert.equal(calls.started[0].routine.projectId, 'p1')
  assert.match(calls.started[0].prompt, /"Weekly update"/)
  assert.match(calls.started[0].prompt, /Insert this week’s section into the doc\./)
  assert.match(calls.started[0].prompt, /save_deliverable/)
  assert.match(calls.started[0].prompt, /add_inbox_item/)
  assert.equal(routines.runs(routine.id)[0].sessionId, 's1')
  end({ error: null, summary: 'Reading Jira…\n\nChecked 4 PRs; nothing needs you.' })
  const ended = await done
  assert.deepEqual([ended.status, ended.summary, ended.deliverableRef], ['done', 'Checked 4 PRs; nothing needs you.', null])
  assert.deepEqual(calls.inbox, [{ key: runKey(routine.id, run.id), kind: 'other', text: 'Weekly update ran: Checked 4 PRs; nothing needs you.', workspaceId: 'w1', projectId: 'p1', ref: 'acme:routine:' + routine.id, labels: ['p1'] }])
  assert.deepEqual(runOfKey(calls.inbox[0].key), { routineId: routine.id, runId: run.id })
  assert.deepEqual(calls.resolved, [failedKey(routine.id)])
})

test('a run that saved a draft: the Inbox item is about the draft', async () => {
  const { runner, routine, calls, end } = setup()
  const { done } = runner.run(routine.id, 'now')
  runner.saved('other-session', 'acme:dlv:nope')
  runner.saved('s1', 'acme:dlv:weekly-update')
  end({ error: null, summary: null })
  const ended = await done
  assert.equal(ended.deliverableRef, 'acme:dlv:weekly-update')
  assert.deepEqual([calls.inbox[0].kind, calls.inbox[0].text, calls.inbox[0].ref, calls.inbox[0].labels], ['draft', 'Weekly update ran: made a draft', 'acme:dlv:weekly-update', []])
})

test('a failed run: its error in the Inbox with the routine as ref (Retry)', async () => {
  const { runner, routine, calls, end } = setup()
  const { done } = runner.run(routine.id, 'now')
  end({ error: 'the agent crashed', summary: null })
  const ended = await done
  assert.deepEqual([ended.status, ended.error], ['failed', 'the agent crashed'])
  assert.equal(calls.inbox.length, 1)
  assert.deepEqual([calls.inbox[0].key, calls.inbox[0].text], [failedKey(routine.id), 'Weekly update failed: the agent crashed'])
  assert.equal(routineOfRef(calls.inbox[0].ref), routine.id)
})

test('a run that does not end in time is stopped and fails', async () => {
  const { runner, routine, calls } = setup()
  const ended = await runner.run(routine.id, 'now').done
  assert.deepEqual([ended.status, ended.error, calls.stopped], ['failed', 'timed out after 0 min', ['s1']])
})

test('a session that cannot start fails the run; a second run while one runs is refused', async () => {
  const failing = setup({ startThrows: true })
  const ended = await failing.runner.run(failing.routine.id, 'now').done
  assert.deepEqual([ended.status, ended.error], ['failed', 'no agent'])
  const { runner, routine } = setup()
  runner.run(routine.id, 'now')
  assert.throws(() => runner.run(routine.id, 'now'), /running already/)
})
