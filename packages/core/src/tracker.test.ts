import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkedTask, parseTicketUrl, parseTrackerRef, ticketLink, type Task, type TrackerScope } from './index.ts'

const jira: TrackerScope = { integrationId: 'claude_ai_Atlassian', kind: 'jira', scope: 'ABC' }
const linear: TrackerScope = { integrationId: 'claude_ai_Linear', kind: 'linear', scope: 'ENG' }
const scopes = [jira, linear]

test('parseTrackerRef: bare keys need a scope with their prefix', () => {
  assert.deepEqual(parseTrackerRef(' abc-12 ', scopes), { scope: jira, key: 'ABC-12', url: null })
  assert.deepEqual(parseTrackerRef('ENG-7', scopes), { scope: linear, key: 'ENG-7', url: null })
  assert.equal(parseTrackerRef('XYZ-1', scopes), null)
  assert.equal(parseTrackerRef('ABC-12', []), null)
  assert.equal(parseTrackerRef('ABC', scopes), null)
})

test('parseTrackerRef: Jira URLs, canonical url', () => {
  const expected = { scope: jira, key: 'ABC-12', url: 'https://acme.atlassian.net/browse/ABC-12' }
  assert.deepEqual(parseTrackerRef('https://acme.atlassian.net/browse/ABC-12', scopes), expected)
  assert.deepEqual(parseTrackerRef('https://acme.atlassian.net/browse/abc-12?focusedCommentId=1', scopes), expected)
  assert.deepEqual(parseTrackerRef('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-12', scopes), expected)
  assert.equal(parseTrackerRef('https://acme.atlassian.net/browse/XYZ-1', scopes), null, 'no scope')
  assert.equal(parseTrackerRef('https://acme.atlassian.net/browse/ENG-1', scopes), null, 'ENG is a Linear scope')
  assert.equal(parseTrackerRef('https://example.com/ABC-12', scopes), null)
})

test('parseTrackerRef: Linear URLs, slug dropped', () => {
  assert.deepEqual(parseTrackerRef('https://linear.app/acme/issue/ENG-7/fix-the-thing', scopes), {
    scope: linear,
    key: 'ENG-7',
    url: 'https://linear.app/acme/issue/ENG-7',
  })
  assert.equal(parseTrackerRef('https://linear.app/acme/issue/ABC-1', scopes), null, 'ABC is a Jira scope')
  assert.equal(parseTrackerRef('not a link', scopes), null)
})

test('linkedTask: top-level task with the ticket, any case', () => {
  const base = { projectId: 'p', type: 'dev', status: 'backlog', description: '', rank: 0, needsInput: null, work: null, nextSubNo: 1, archivedAt: null, createdAt: 0, updatedAt: 0 } as const
  const link = { integrationId: 'x', kind: 'jira', key: 'ABC-12', url: null, importedAt: null } as const
  const t: Task = { ...base, id: 't', key: 'T-1', parentId: null, title: 'a', tracker: link }
  const other: Task = { ...base, id: 'u', key: 'T-2', parentId: null, title: 'b' }
  assert.equal(linkedTask([other, t], 'abc-12'), t)
  assert.equal(linkedTask([other, t], 'ABC-13'), null)
})

test('parseTicketUrl: Jira and Linear URLs without scopes', () => {
  assert.deepEqual(parseTicketUrl(' https://acme.atlassian.net/browse/xyz-1?focusedCommentId=1 '), { kind: 'jira', key: 'XYZ-1', url: 'https://acme.atlassian.net/browse/XYZ-1' })
  assert.deepEqual(parseTicketUrl('https://jira.acme.com/secure/RapidBoard.jspa?rapidView=1&selectedIssue=OPS-4'), { kind: 'jira', key: 'OPS-4', url: 'https://jira.acme.com/browse/OPS-4' })
  assert.deepEqual(parseTicketUrl('https://linear.app/acme/issue/DES-9/a-slug'), { kind: 'linear', key: 'DES-9', url: 'https://linear.app/acme/issue/DES-9' })
  assert.equal(parseTicketUrl('ABC-12'), null, 'a bare key is not a link')
  assert.equal(parseTicketUrl('https://example.com/ABC-12'), null)
  assert.equal(parseTicketUrl('https://linear.app/acme/project/x'), null)
})

test('ticketLink: integration from a matching scope, else none', () => {
  const t = (id: string, tracker?: Task['tracker']): Task => ({ projectId: 'p', type: 'dev', status: 'backlog', description: '', rank: 0, needsInput: null, work: null, nextSubNo: 1, archivedAt: null, createdAt: 0, updatedAt: 0, id, key: `T-${id}`, parentId: null, title: id, tracker })
  assert.deepEqual(ticketLink([], null, 'https://acme.atlassian.net/browse/ABC-12', scopes), { integrationId: 'claude_ai_Atlassian', kind: 'jira', key: 'ABC-12', url: 'https://acme.atlassian.net/browse/ABC-12', importedAt: null })
  assert.equal(ticketLink([], null, 'https://acme.atlassian.net/browse/XYZ-1', scopes).integrationId, null, 'outside the scopes')
  assert.equal(ticketLink([], null, 'https://acme.atlassian.net/browse/ENG-1', scopes).integrationId, null, 'ENG is a Linear scope')
  assert.equal(ticketLink([], null, 'https://linear.app/acme/issue/ENG-7', scopes).integrationId, 'claude_ai_Linear')
  assert.throws(() => ticketLink([], null, 'ABC-12', scopes), /^Error: Not a Jira or Linear ticket link$/)
  const linked = t('7', { integrationId: null, kind: 'jira', key: 'ABC-12', url: null, importedAt: 5 })
  assert.throws(() => ticketLink([linked], t('8'), 'https://acme.atlassian.net/browse/abc-12', scopes), /ABC-12 is already linked to T-7/)
  assert.throws(() => ticketLink([linked], null, 'https://acme.atlassian.net/browse/ABC-12', scopes), /already linked to T-7/)
  assert.equal(ticketLink([linked], linked, 'https://acme.atlassian.net/browse/ABC-12', scopes).importedAt, null, 'relinking the same task')
})
