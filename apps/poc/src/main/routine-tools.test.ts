import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Project } from '@mag/core'
import type { NewInboxItem } from './core/services/inbox/index.ts'
import { createRoutines, type Routine, type RoutineRun } from './core/services/routines/index.ts'
import { choiceArg, nextRuns, routineTool, type RoutineCaller } from './routine-tools.ts'
import { TOOL_DEFS, toolsFor } from './tool-defs.ts'

const NOW = new Date(2026, 10, 17, 12).getTime()

function setup() {
  const rows = { routines: [] as Routine[], runs: [] as RoutineRun[] }
  const routines = createRoutines({
    now: () => NOW,
    records: {
      routines: () => rows.routines,
      putRoutine: (r) => void (rows.routines = [...rows.routines.filter((x) => x.id !== r.id), r]),
      removeRoutine: () => {},
      runs: () => rows.runs,
      putRun: () => {},
      removeRuns: () => {},
    },
  })
  const added: NewInboxItem[] = []
  const deps = { routines, inbox: { add: (i: NewInboxItem) => void added.push(i) } }
  const projects = [{ id: 'p1', name: 'Data Removal', workspaceId: 'w1' }, { id: 'p2', name: 'Elsewhere', workspaceId: 'w2' }] as Project[]
  const topic: RoutineCaller = { workspaceId: 'w1', projectId: 'p1', sessionId: 's1', drafter: false }
  const call = (name: 'save_routine' | 'list_routines' | 'add_inbox_item', args: Record<string, unknown>, caller = topic) => routineTool(deps, projects, caller, name, args)
  return { routines, added, call }
}

test('save_routine: a name, a cron and a prompt in the topic\'s workspace; a project by name; answers the next 3 runs', () => {
  const { routines, call } = setup()
  const answer = call('save_routine', { name: 'Weekly update', cron: '0 10 * * thu', prompt: 'Draft the update.', project: 'data removal' })
  const [r] = routines.list('w1')
  assert.deepEqual([r.name, r.trigger, r.prompt, r.projectId, r.choice, r.enabled], ['Weekly update', { kind: 'schedule', cron: '0 10 * * thu' }, 'Draft the update.', 'p1', null, true])
  assert.match(answer, /next runs: 2026-11-19 10:00, 2026-11-26 10:00, 2026-12-03 10:00/)
  assert.throws(() => call('save_routine', { name: 'X', cron: '0 10 * *', prompt: 'p' }), /Schedule: A schedule has 5 fields/)
  assert.throws(() => call('save_routine', { name: 'X', cron: '0 10 * * *', prompt: 'p', project: 'Elsewhere' }), /No project "Elsewhere" in this workspace: Data Removal/)
  // An edit keeps what it doesn't name; '' drops the project.
  call('save_routine', { id: r.id, project: '', enabled: false })
  assert.deepEqual([routines.get(r.id).projectId, routines.get(r.id).prompt, routines.get(r.id).enabled], [null, 'Draft the update.', false])
  assert.throws(() => call('save_routine', { id: r.id, name: 'Y' }, { workspaceId: 'w2', projectId: null, sessionId: 's2', drafter: false }), /in another workspace/)
  assert.throws(() => call('save_routine', { name: 'Z', cron: '0 10 * * *', prompt: 'p' }, { ...setupCaller(), drafter: true }), /doesn't set up routines/)
})

const setupCaller = (): RoutineCaller => ({ workspaceId: 'w1', projectId: null, sessionId: 'd1', drafter: false })

test('save_routine: model and effort, optional; "default" goes back to the drafter role\'s', () => {
  const { routines, call } = setup()
  call('save_routine', { name: 'W', cron: '0 10 * * thu', prompt: 'p', model: 'claude-sonnet-5-5', effort: 'low' })
  const [r] = routines.list('w1')
  assert.deepEqual(r.choice, { agent: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low' })
  call('save_routine', { id: r.id, effort: 'high' })
  assert.deepEqual(routines.get(r.id).choice, { agent: 'claude-code', model: 'claude-sonnet-5-5', effort: 'high' })
  call('save_routine', { id: r.id, prompt: 'q' })
  assert.equal(routines.get(r.id).choice?.effort, 'high')
  call('save_routine', { id: r.id, model: 'default' })
  assert.equal(routines.get(r.id).choice, null)
  assert.throws(() => call('save_routine', { id: r.id, effort: 'huge' }), /effort must be one of/)
  assert.throws(() => call('save_routine', { id: r.id, agent: 'gemini' }), /choice.agent must be one of/)
  assert.deepEqual(choiceArg({ agent: 'codex' }, { agent: 'claude-code', model: 'claude-opus-5-5', effort: 'max' }), { agent: 'codex', model: null, effort: 'max' })
  assert.equal(choiceArg({ name: 'x' }, null), undefined)
})

test('list_routines: the workspace\'s, with schedule, project, model, next run and prompt', () => {
  const { call } = setup()
  assert.match(call('list_routines', {}), /No routines in this workspace yet/)
  call('save_routine', { name: 'Weekly update', cron: '0 10 * * thu', prompt: 'Draft the update.', project: 'Data Removal', model: 'claude-sonnet-5-5' })
  const list = call('list_routines', {})
  assert.match(list, /Weekly update · cron "0 10 \* \* thu" · project Data Removal · claude-code claude-sonnet-5-5, effort default · next \d{4}-\d\d-\d\d 10:00\n {2}prompt: Draft the update\./)
  assert.match(call('list_routines', {}, { workspaceId: 'w2', projectId: null, sessionId: null, drafter: false }), /No routines/)
})

test('add_inbox_item: one item per ref (or title), in the caller\'s workspace and project', () => {
  const { added, call } = setup()
  assert.throws(() => call('add_inbox_item', { title: 'x' }), /why is required/)
  const drafter: RoutineCaller = { workspaceId: 'w1', projectId: null, sessionId: 'd1', drafter: true }
  call('add_inbox_item', { title: 'Reply to Ana', why: 'She asked for the numbers by Monday', ref: 'https://slack.com/x' }, drafter)
  call('add_inbox_item', { title: 'Reply to Ana again', why: 'Still waiting', ref: 'https://slack.com/x' }, drafter)
  call('add_inbox_item', { title: 'Review o/r#4', why: 'Requested of you' })
  assert.equal(added[0].key, added[1].key)
  assert.notEqual(added[0].key, added[2].key)
  assert.deepEqual(added[0], { key: added[0].key, kind: 'other', text: 'Reply to Ana · She asked for the numbers by Monday', workspaceId: 'w1', projectId: null, ref: 'https://slack.com/x', labels: [] })
  assert.deepEqual([added[2].projectId, added[2].labels, added[2].ref], ['p1', ['p1'], null])
})

test('the tools: for topics and routine runs (project scope), not for a work\'s agents', () => {
  for (const name of ['save_routine', 'list_routines', 'add_inbox_item']) {
    assert.equal(TOOL_DEFS.find((d) => d.name === name)?.scope, 'project', name)
    assert.ok(toolsFor('project', 'chat').some((t) => t.name === name), name)
    assert.ok(toolsFor('project', 'drafter').some((t) => t.name === name), name)
    assert.ok(!toolsFor('task', 'developer').some((t) => t.name === name), name)
  }
})

test('nextRuns: nextAt and the slots after it; none when off', () => {
  const r = { trigger: { kind: 'schedule' as const, cron: '0 9 * * 1-5' }, nextAt: new Date(2026, 10, 20, 9).getTime() }
  assert.deepEqual(nextRuns(r, 3), [r.nextAt, new Date(2026, 10, 23, 9).getTime(), new Date(2026, 10, 24, 9).getTime()])
  assert.deepEqual(nextRuns({ ...r, nextAt: null }, 3), [])
})
