import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inbox, type AgentSession, type Project, type Task } from '@mag/core'
import { attentionItems, newAttention } from './attention-items.ts'
import { createInbox, type InboxState } from './core/services/inbox/index.ts'

const project = (id: string): Project => ({ id, name: `Project ${id}`, workspaceId: 'w', repos: [], notes: '', enforceArchitecture: false, architecture: null, archRun: null, agents: {}, integrations: {}, createdAt: 0 })
const task = (id: string, projectId: string, status: Task['status'], patch: Partial<Task> = {}): Task => ({
  id, projectId, key: `T-${id}`, parentId: null, title: id, type: 'dev', status, description: '', rank: 0, needsInput: null, work: null, nextSubNo: 1, createdAt: 0, updatedAt: 0, ...patch,
})

/** The workspace inbox over `tasks` and `sessions`, with its state in memory. */
function workspaceInbox(tasks: () => Task[], sessions: AgentSession[] = []) {
  let states: InboxState[] = []
  return createInbox({
    store: {
      states: () => states,
      putState: (s) => void (states = [...states.filter((x) => x.key !== s.key), s]),
      removeStates: (keys) => void (states = states.filter((s) => !keys.includes(s.key))),
      added: () => [],
      putAdded: () => {},
    },
    derived: () => inbox(tasks(), sessions),
    workspaceOf: () => 'w',
  })
}

const ps = [project('p'), project('q')]

test('attentionItems: one per waiting task, titled by project', () => {
  const tasks = [task('1', 'p', 'in_progress', { needsInput: 'Which DB?' }), task('2', 'q', 'in_progress', { work: { dir: 'd', feedbackSeenAt: 0, repos: [{ repo: 'r', branch: 'b', worktree: 'd/r', prUrl: 'u', prState: 'open' }] } }), task('3', 'q', 'in_progress')]
  const items = attentionItems(workspaceInbox(() => tasks).items(), ps, tasks)
  assert.deepEqual(items.map((i) => [i.projectId, i.taskId, i.title, i.body]), [
    ['p', '1', 'Project p', 'T-1: Which DB?'],
    ['q', '2', 'Project q', 'T-2: PR is ready to merge'],
  ])
})

test('attentionItems: the same kinds as before; approvals, reviews and their PR activity do not notify', () => {
  const approval = { kind: 'approval', id: 'a', tool: 'Bash', input: {}, status: 'pending', at: 1 } as const
  const chat: AgentSession = { id: 's', workspaceId: 'w', projectId: 'p', taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [approval], createdAt: 0 }
  const pr = { url: 'u', repo: 'r', number: 1, author: 'a', base: 'main', head: 'h' }
  const review = task('r', 'p', 'in_progress', { type: 'review', prReview: { pr, results: {}, shown: 'v2', posted: null, activity: { lastSeenAt: 0, authorReplies: 1, newCommits: false, state: 'open', head: 'h', at: 5 } } })
  const start = [task('s', 'p', 'in_progress'), task('s1', 'p', 'todo', { parentId: 's', startManually: true })]
  const tasks = [review, ...start]
  const all = workspaceInbox(() => tasks, [chat]).items()
  assert.deepEqual(all.map((i) => i.kind), ['approval', 'review_activity', 'ready_to_start'])
  assert.deepEqual(attentionItems(all, ps, tasks).map((i) => i.body), ['T-s: T-s1 waits for Start'])
})

test('attentionItems: a done or snoozed item does not notify', () => {
  const tasks = [task('1', 'p', 'in_progress', { needsInput: 'Which DB?' })]
  const box = workspaceInbox(() => tasks)
  box.done(box.items()[0].key)
  assert.deepEqual(attentionItems(box.items(), ps, tasks), [])
})

test('newAttention: only what was not there before; a new question on the same task is new', () => {
  const seen = new Set<string>()
  const ask = (q: string) => {
    const tasks = [task('1', 'p', 'in_progress', { needsInput: q })]
    return attentionItems(workspaceInbox(() => tasks).items(), ps, tasks)
  }
  assert.equal(newAttention(seen, ask('A?')).length, 1)
  assert.equal(newAttention(seen, ask('A?')).length, 0)
  assert.equal(newAttention(seen, ask('B?')).length, 1)
  assert.equal(newAttention(seen, []).length, 0)
  assert.equal(newAttention(seen, ask('B?')).length, 1, 'answered, then asked again')
})
