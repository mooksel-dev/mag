import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentSession, Project, Task } from '@mag/core'
import { allCards, columnCards, starredCards, toggleStar, waitingCount } from './topicsColumn.ts'

const NOW = 100 * 24 * 60 * 60 * 1000
const project = (id: string, workspaceId = 'w'): Project => ({
  id, name: id, workspaceId, repos: [], notes: '', enforceArchitecture: false, architecture: null, archRun: null, agents: {}, integrations: {}, sidebar: [], createdAt: 0,
})
const task = (id: string, projectId: string, patch: Partial<Task> = {}): Task => ({
  id, projectId, key: id, parentId: null, title: id, type: 'dev', status: 'planning', description: '', rank: 0,
  needsInput: null, work: null, nextSubNo: 1, createdAt: 0, updatedAt: NOW, ...patch,
})
const topic = (id: string, projectId: string | null, patch: Partial<AgentSession> = {}): AgentSession => ({
  id, workspaceId: 'w', projectId, taskId: null, role: 'chat', agent: 'claude-code', nativeSessionId: null, status: 'idle', items: [], title: id, createdAt: NOW, ...patch,
})

const projects = [project('a'), project('other', 'w2'), project('b')]
const tasks = [task('wa', 'a', { needsInput: 'Which way?' }), task('wb', 'b', { status: 'done' }), task('wx', 'other')]
const sessions = [topic('ta', 'a'), topic('tb', 'b'), topic('loose', null), topic('elsewhere', null, { workspaceId: 'w2' }), topic('gone', null, { closedAt: NOW })]
const column = columnCards('w', projects, tasks, sessions, NOW)
const ids = (cards: { id: string }[]) => cards.map((c) => c.id).sort()

test('columnCards: a section per project of the workspace, in order; topics without a project of this workspace only', () => {
  assert.deepEqual(column.projects.map((p) => p.project.id), ['a', 'b'])
  assert.deepEqual(ids(column.projects[0].cards), ['ta', 'wa'])
  assert.deepEqual(ids(column.projects[1].cards), ['tb', 'wb'])
  assert.deepEqual(ids(column.loose), ['gone', 'loose'])
  assert.equal(allCards(column).length, 6)
})

test('starredCards: open rows in the order starred, across sections; gone or closed ones are left out', () => {
  assert.deepEqual(starredCards(column, ['topic:loose', 'work:wb', 'topic:gone', 'topic:nope', 'work:wx']).map((c) => c.id), ['loose', 'wb'])
  assert.deepEqual(starredCards(column, undefined), [])
})

test('waitingCount: what waits on the user in a section', () => {
  assert.equal(waitingCount(column.projects[0].cards), 1)
  assert.equal(waitingCount(column.projects[1].cards), 0)
  assert.equal(waitingCount(allCards(column)), 1)
})

test('toggleStar: adds at the end, takes out when starred', () => {
  assert.deepEqual(toggleStar(undefined, 'topic:t'), ['topic:t'])
  assert.deepEqual(toggleStar(['work:w'], 'topic:t'), ['work:w', 'topic:t'])
  assert.deepEqual(toggleStar(['work:w', 'topic:t'], 'work:w'), ['topic:t'])
})
