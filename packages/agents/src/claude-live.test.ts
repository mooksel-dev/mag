// Facts about a long-lived `claude -p --input-format stream-json` process (T-40.1 spike, CLI 2.1.306). The fixtures
// are recorded by spike/claude-stream.ts: stdout lines as-is, plus `{ "__stdin": … }` for what we wrote and
// `{ "__exit": … }` for how the process ended. The live adapter (T-40.2) is built on these facts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@mag/core'
import { buildLiveArgs, claudeCode, liveParser } from './claude-code.ts'

const lines = (name: string): any[] =>
  readFileSync(new URL(`./__fixtures__/claude-live-${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

const isInit = (j: any) => j.type === 'system' && j.subtype === 'init'
const results = (js: any[]) => js.filter((j) => j.type === 'result')
const userSends = (js: any[]) => js.filter((j) => j.__stdin?.type === 'user')
const backgroundLists = (js: any[]) =>
  js.filter((j) => j.subtype === 'background_tasks_changed').map((j) => j.tasks.map((t: any) => t.task_id))

test('every turn starts with system/init and ends with result, and the process stays alive in between', () => {
  for (const name of ['bg-bash', 'monitor', 'stop-task', 'interrupt', 'close-with-bg', 'send-during-wake']) {
    const js = lines(name)
    const marks = js.filter((j) => isInit(j) || j.type === 'result').map((j) => j.type)
    assert.deepEqual(marks, marks.map((_, i) => (i % 2 ? 'result' : 'system')), name)
    assert.ok(results(js).length >= 2, name)
  }
})

test('a background task wakes the agent: a new turn without our message, its result has origin task-notification', () => {
  for (const name of ['bg-bash', 'monitor']) {
    const js = lines(name)
    const [first, ...woken] = results(js)
    assert.equal(userSends(js).length, 1, name)
    assert.equal(first.origin, undefined, name)
    assert.ok(woken.length >= 1, name)
    for (const r of woken) assert.equal(r.origin?.kind, 'task-notification', name)
  }
  // Monitor wakes the agent on every line, not only when the stream ends.
  assert.deepEqual(results(lines('monitor')).map((r) => r.result), ['watching', 'got tick 1', 'got tick 2'])
})

test('background_tasks_changed carries the full list of active tasks; task_started tells which tool_use started one', () => {
  const js = lines('monitor')
  assert.deepEqual(backgroundLists(js), [['b9aa2fnzn'], []])
  const started = js.find((j) => j.subtype === 'task_started')
  assert.equal(started.is_backgrounded, true)
  const call = js.flatMap((j) => (j.type === 'assistant' ? j.message.content : [])).find((b: any) => b.id === started.tool_use_id)
  assert.equal(call.name, 'Monitor')
  // The list itself names no tool: Monitor and background Bash are both local_bash.
  const changed = js.find((j) => j.subtype === 'background_tasks_changed')
  assert.deepEqual(changed.tasks[0], { task_id: 'b9aa2fnzn', run_id: '0mvwg64ye-d0af0e6b', task_type: 'local_bash', description: 'ticks' })
})

test('a foreground tool running a few seconds also emits task_started, but with is_backgrounded false and no background list change', () => {
  const js = lines('queue')
  assert.equal(js.find((j) => j.subtype === 'task_started').is_backgrounded, false)
  assert.deepEqual(backgroundLists(js), [])
})

test('a message written during a turn joins that turn: two sends, one result', () => {
  for (const name of ['queue', 'send-during-wake']) {
    const js = lines(name)
    assert.equal(userSends(js).length, 2, name)
    assert.equal(results(js).at(-1).queued_turn_count, 0, name)
  }
  assert.equal(results(lines('queue')).length, 1)
  assert.equal(results(lines('send-during-wake')).at(-1).result, 'bg seen\n\nqueued')
})

test('interrupt ends the turn with an error result; background tasks survive and wake the agent later', () => {
  const js = lines('interrupt')
  const i = js.findIndex((j) => j.__stdin?.type === 'control_request')
  assert.deepEqual(js[i].__stdin.request, { subtype: 'interrupt' })
  const after = js.slice(i + 1)
  assert.deepEqual(after.find((j) => j.type === 'control_response'), {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'req_1', response: { still_queued: [] } },
  })
  const [interrupted, next, woken] = results(after)
  assert.equal(interrupted.subtype, 'error_during_execution')
  assert.equal(interrupted.is_error, true)
  assert.equal(interrupted.terminal_reason, 'aborted_tools')
  assert.equal(next.result, 'after')
  assert.equal(woken.origin?.kind, 'task-notification')
  // The foreground tool was stopped; the background one completed.
  const statuses = after.filter((j) => j.subtype === 'task_notification').map((j) => j.status)
  assert.deepEqual(statuses, ['stopped', 'completed'])
  assert.deepEqual(js.at(-1), { __exit: { code: 0, signal: null } })
})

test('stop_task stops one background task and does not wake the agent', () => {
  const js = lines('stop-task')
  const i = js.findIndex((j) => j.__stdin?.type === 'control_request')
  assert.deepEqual(js[i].__stdin.request, { subtype: 'stop_task', task_id: 'b1ipi4cp8' })
  const after = js.slice(i + 1)
  assert.equal(after.find((j) => j.subtype === 'task_notification').status, 'stopped')
  assert.equal(after.find((j) => j.subtype === 'task_updated').patch.status, 'killed')
  assert.deepEqual(after.find((j) => j.subtype === 'background_tasks_changed').tasks, [])
  assert.equal(after.find((j) => j.type === 'control_response').response.subtype, 'success')
  // The next turn is the one we started.
  const nextInit = after.findIndex(isInit)
  assert.ok(nextInit > after.findIndex((j) => j.__stdin?.type === 'user'))
})

test('closing stdin with a background task running: the process waits for it, wakes the agent once more, then exits 0', () => {
  const js = lines('close-with-bg')
  const closed = js.findIndex((j) => j.__stdin === 'close')
  const after = js.slice(closed + 1)
  assert.equal(after.find((j) => j.subtype === 'task_notification').status, 'completed')
  assert.equal(results(after)[0].origin?.kind, 'task-notification')
  assert.deepEqual(js.at(-1), { __exit: { code: 0, signal: null } })
})

test('SIGTERM stops background tasks (status stopped) and exits with 143', () => {
  const js = lines('sigterm')
  assert.equal(js.find((j) => j.subtype === 'task_notification').status, 'stopped')
  assert.deepEqual(backgroundLists(js).at(-1), [])
  assert.deepEqual(js.at(-1), { __exit: { code: 143, signal: null } })
})

// The live adapter on these facts (T-40.2).

/** Replays a fixture through liveParser as the handle would: our writes mark sends and interrupts. */
const replay = (name: string) => {
  const controls: [string, boolean][] = []
  const parser = liveParser((id, ok) => controls.push([id, ok]))
  const events: AgentEvent[] = []
  for (const j of lines(name)) {
    if (j.__stdin?.type === 'user') parser.sent()
    else if (j.__stdin?.request?.subtype === 'interrupt') parser.interrupting()
    else if (!j.__stdin && !j.__exit) events.push(...parser.parse(JSON.stringify(j)))
  }
  return { events, controls }
}
const marks = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === 'turn.started' || e.type === 'stopped' ? [e.type]
    : e.type === 'turn.done' ? [`done ${e.ok}`]
    : e.type === 'background' ? [`bg [${e.tasks.map((t) => t.name).join(',')}]`]
    : [],
  )

test('liveParser: a wake-up is turn.started; our own message is not', () => {
  assert.deepEqual(marks(replay('bg-bash').events), ['bg [Run delayed echo in background]', 'bg [Bash]', 'done true', 'bg []', 'turn.started', 'done true'])
  // A message written during a wake-up joins it: no second turn.started.
  assert.deepEqual(marks(replay('send-during-wake').events).filter((m) => !m.startsWith('bg')), ['done true', 'turn.started', 'done true'])
})

test('liveParser: background tasks are named after the tool that started them', () => {
  assert.deepEqual(marks(replay('monitor').events), ['bg [ticks]', 'bg [Monitor]', 'done true', 'turn.started', 'done true', 'bg []', 'turn.started', 'done true'])
  const last = replay('monitor').events.filter((e) => e.type === 'background')[1]
  assert.deepEqual(last, { type: 'background', tasks: [{ id: 'b9aa2fnzn', name: 'Monitor' }] })
})

test('liveParser: the error result of our interrupt is stopped + a finished turn, not a failed one', () => {
  const { events, controls } = replay('interrupt')
  const m = marks(events)
  assert.deepEqual(m.slice(m.indexOf('stopped'), m.indexOf('stopped') + 2), ['stopped', 'done true'])
  assert.ok(!m.includes('done false'))
  assert.deepEqual(controls, [['req_1', true]])
  // The background task survives and wakes the agent later.
  assert.equal(m.at(-2), 'turn.started')
})

test('liveParser: without an interrupt an error result stays a failed turn', () => {
  const parser = liveParser()
  parser.sent()
  assert.deepEqual(parser.parse(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's' })), [
    { type: 'turn.done', ok: false, costUsd: undefined, nativeSessionId: 's' },
  ])
  // Nothing to interrupt between turns.
  assert.equal(parser.interrupting(), false)
})

test('liveParser: stop_task answers through onControl', () => {
  const { controls } = replay('stop-task')
  assert.deepEqual(controls, [['req_1', true]])
})

test('buildLiveArgs: no prompt in argv, stream-json in and out, plus the spec', () => {
  const args = buildLiveArgs({ cwd: '/tmp', resumeId: 'abc', model: 'sonnet' })
  assert.deepEqual(args.slice(0, 6), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'abc'])
})

/** A stand-in for the CLI: answers each message with a turn, interrupts with an error result, exits on stdin end. */
const FAKE = `#!/usr/bin/env node
const { createInterface } = require('node:readline')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (process.env.FAKE_CRASH) { process.stderr.write('boom'); process.exit(3) }
createInterface({ input: process.stdin }).on('line', (l) => {
  const j = JSON.parse(l)
  if (j.type === 'user') {
    out({ type: 'system', subtype: 'init', session_id: 'n1' })
    if (j.message.content === 'hang') return
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo ' + j.message.content }] } })
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'n1' })
  } else if (j.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: {} } })
    if (j.request.subtype === 'interrupt') out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'n1' })
  }
}).on('close', () => process.exit(0))
if (process.env.FAKE_IGNORE_EOF) { process.stdin.removeAllListeners('end'); setInterval(() => {}, 1000) }
`

const fakeCli = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-fake-claude-'))
  const bin = join(dir, 'claude.cjs')
  writeFileSync(bin, FAKE)
  chmodSync(bin, 0o755)
  process.env.MAG_CLAUDE_BIN = bin
  return dir
}

const openFake = (env: Record<string, string> = {}) => {
  const events: AgentEvent[] = []
  const handle = claudeCode.open!({ cwd: fakeCli(), env }, (e) => events.push(e))
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(ok(), JSON.stringify(events))
  }
  return { handle, events, until, types: () => events.map((e) => e.type) }
}

test('open: messages go to stdin, turns end at result, close emits stopped and no error', async () => {
  const { handle, events, until, types } = openFake()
  handle.send('one')
  await until(() => types().includes('turn.done'))
  handle.send('two')
  await until(() => types().filter((t) => t === 'turn.done').length === 2)
  assert.deepEqual(events.filter((e) => e.type === 'message'), [{ type: 'message', text: 'echo one' }, { type: 'message', text: 'echo two' }])
  assert.ok(!types().includes('turn.started'), 'our own messages are not wake-ups')
  handle.close()
  await handle.done
  assert.equal(types().at(-1), 'stopped')
  assert.ok(!types().includes('error'))
})

test('open: interrupt resolves on the control response and ends the turn as stopped', async () => {
  const { handle, until, types } = openFake()
  handle.send('hang')
  await until(() => types().includes('session.started'))
  await handle.interrupt()
  await until(() => types().includes('turn.done'))
  assert.deepEqual(types().slice(-2), ['stopped', 'turn.done'])
  handle.close()
  await handle.done
})

test('open: close kills a process that does not exit on its own after the grace period', async () => {
  const { handle, types } = openFake({ FAKE_IGNORE_EOF: '1' })
  handle.close(50)
  await handle.done
  assert.deepEqual(types(), ['stopped'])
})

test('open: a crash we did not cause is an error', async () => {
  const { handle, events } = openFake({ FAKE_CRASH: '1' })
  await handle.done
  assert.deepEqual(events, [{ type: 'error', message: 'boom' }])
})
