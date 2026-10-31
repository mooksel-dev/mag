import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Project, TrackerScope } from '@mag/core'
import { scopeKey, scopeWarning } from './trackers.ts'

const project = (p: Partial<Project> = {}) => ({ id: 'p', agents: {}, integrations: {}, ...p }) as Project
const scope: TrackerScope = { integrationId: 'atl', kind: 'jira', scope: 'ABC' }
const atl = [{ id: 'atl', name: 'Atlassian' }]

test('scopeWarning: Claude Code, a detected integration, on for the tracker role', () => {
  assert.match(scopeWarning(project({ agents: { tracker: { agent: 'codex', model: null } } }), scope, atl)!, /must be Claude Code/)
  assert.match(scopeWarning(project(), scope, [])!, /not detected/)
  assert.match(scopeWarning(project(), scope, atl)!, /Turn this integration on/)
  assert.match(scopeWarning(project({ integrations: { groomer: { atl: 'auto' } } }), scope, atl)!, /Turn this integration on/)
  assert.equal(scopeWarning(project({ integrations: { tracker: { atl: 'ask' } } }), scope, atl), null)
})

test('scopeKey: trimmed and upper case; not a key prefix is null', () => {
  assert.equal(scopeKey(' abc '), 'ABC')
  assert.equal(scopeKey('ENG2'), 'ENG2')
  assert.equal(scopeKey(''), null)
  assert.equal(scopeKey('AB-1'), null)
  assert.equal(scopeKey('1AB'), null)
})
