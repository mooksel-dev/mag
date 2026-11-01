import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Project, Task, WorkState } from '@mag/core'
import { attentionItems, newAttention } from './attention-items.ts'

const project = (id: string): Project => ({ id, name: `Project ${id}`, repos: [], notes: '', templates: {}, baseBranch: 'main', enforceArchitecture: false, architecture: null, archRun: null, agents: {}, integrations: {}, createdAt: 0 })
const task = (id: string, projectId: string, status: WorkState, patch: Partial<Task> = {}): Task => ({
  id, projectId, key: `T-${id}`, parentId: null, title: id, type: 'dev', status, description: '', rank: 0, needsInput: null, work: null, nextSubNo: 1, createdAt: 0, updatedAt: 0, ...patch,
})

test('attentionItems: one per waiting task, titled by project', () => {
  const items = attentionItems([project('p'), project('q')], [task('1', 'p', 'in_progress', { needsInput: 'Which DB?' }), task('2', 'q', 'in_progress', { work: { dir: 'd', feedbackSeenAt: 0, repos: [{ repo: 'r', branch: 'b', worktree: 'd/r', prUrl: 'u', prState: 'open' }] } }), task('3', 'q', 'in_progress')], [])
  assert.deepEqual(items.map((i) => [i.projectId, i.taskId, i.title, i.body]), [
    ['p', '1', 'Project p', 'T-1: Which DB?'],
    ['q', '2', 'Project q', 'T-2: PR is ready to merge'],
  ])
})

test('newAttention: only what was not there before; a new question on the same task is new', () => {
  const seen = new Set<string>()
  const ps = [project('p')]
  const ask = (q: string) => attentionItems(ps, [task('1', 'p', 'in_progress', { needsInput: q })], [])
  assert.equal(newAttention(seen, ask('A?')).length, 1)
  assert.equal(newAttention(seen, ask('A?')).length, 0)
  assert.equal(newAttention(seen, ask('B?')).length, 1)
  assert.equal(newAttention(seen, []).length, 0)
  assert.equal(newAttention(seen, ask('B?')).length, 1, 'answered, then asked again')
})
