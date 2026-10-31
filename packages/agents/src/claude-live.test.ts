// Facts about a long-lived `claude -p --input-format stream-json` process (T-40.1 spike, CLI 2.1.306). The fixtures
// are recorded by spike/claude-stream.ts: stdout lines as-is, plus `{ "__stdin": … }` for what we wrote and
// `{ "__exit": … }` for how the process ended. The live adapter (T-40.2) is built on these facts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
