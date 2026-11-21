import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatItem } from '@mag/core'
import { decisionLines, decisionsSection, docSections, finalReplies, parseRef, rowsOfDecisions, rowsOfDeliverable, rowsOfDoc, rowsOfMeeting, rowsOfPerson, rowsOfSession, withWorkspace } from './index.ts'

test('parseRef: every kind, with or without a workspace; not a ref is null', () => {
  assert.deepEqual(parseRef('w1:topic:ab12#7'), { ws: 'w1', kind: 'topic', id: 'ab12', item: 7 })
  assert.deepEqual(parseRef('topic:ab12'), { ws: undefined, kind: 'topic', id: 'ab12' })
  assert.deepEqual(parseRef('w1:doc:t1#decisions-2'), { ws: 'w1', kind: 'doc', id: 't1', section: 'decisions-2' })
  assert.deepEqual(parseRef('w1:dec:t1#0'), { ws: 'w1', kind: 'dec', id: 't1', line: 0 })
  assert.deepEqual(parseRef('mtg:2026-11-20-1430-sync@00:00:09'), { ws: undefined, kind: 'mtg', id: '2026-11-20-1430-sync', at: '00:00:09' })
  assert.deepEqual(parseRef('w1:work:t1'), { ws: 'w1', kind: 'work', id: 't1' })
  assert.equal(parseRef('nonsense'), null)
  assert.equal(withWorkspace('', 'mtg:a'), 'mtg:a')
  assert.equal(withWorkspace('w', 'topic:a'), 'w:topic:a')
})

test('rowsOfSession: the summary, user messages and the last reply of each turn; not tools, jobs or the replies before', () => {
  const items: ChatItem[] = [
    { kind: 'user', text: 'Why?', at: 1 },
    { kind: 'assistant', text: 'Let me look', at: 2 },
    { kind: 'tool', id: 't', name: 'Bash', summary: 'ls', at: 3 },
    { kind: 'assistant', text: 'Because', at: 4 },
    { kind: 'result', ok: true, at: 5 },
    { kind: 'job', title: 'Review', text: 'Review it', at: 6 },
    { kind: 'assistant', text: 'Reviewed', at: 7 },
  ]
  assert.deepEqual([...finalReplies(items)], [3, 6])
  const summary = { title: 'x', gist: ['Gist'], decisions: ['Ship'], open: [], keywords: ['dbr'] }
  assert.deepEqual(rowsOfSession({ id: 's', summary, summaryAt: 9, createdAt: 0 }, items, 'Topic').map((r) => [r.ref, r.text, r.at]), [
    ['topic:s', 'Gist\nShip\ndbr', 9],
    ['topic:s#0', 'Why?', 1],
    ['topic:s#3', 'Because', 4],
    ['topic:s#6', 'Reviewed', 7],
  ])
})

const DOC = '# Problem\nIt stalls.\n\n```\n# not a heading\n```\n\n## Decisions\n- Drain hourly\n1. Keep retries\n\n## API-1.2\n- Step one only\n\n# Plan\n## Decisions\n- later\n'

test('docSections, decisionLines: sections by heading (fences aside), repeated headings get -2; §Decisions with its step subsections', () => {
  assert.deepEqual(docSections(DOC).map((s) => [s.slug, s.level]), [['problem', 1], ['decisions', 2], ['api-1-2', 2], ['plan', 1], ['decisions-2', 2]])
  assert.match(docSections(DOC)[0].text, /# not a heading/)
  assert.deepEqual(decisionLines(DOC), ['Drain hourly', 'Keep retries'])
  assert.deepEqual(decisionLines('# Decisions\n(none recorded yet)\n## X.1\n- a\n# Plan\n- b'), ['a'])
  assert.equal(decisionsSection('# Decisions\n- a\n## X.1\n- b\n# Plan'), '# Decisions\n- a\n\n## X.1\n- b')
  assert.equal(decisionsSection('# Plan'), '')
})

test('rowsOfDoc, rowsOfDecisions, rowsOfMeeting: refs, titles and times', () => {
  const work = { id: 't1', key: 'API-1', title: 'Queue', description: 'Rework it', updatedAt: 5 }
  assert.deepEqual(rowsOfDoc(work, '# Problem\nIt stalls.').map((r) => [r.ref, r.kind, r.title]), [['work:t1', 'doc', 'API-1: Queue'], ['doc:t1#problem', 'doc', 'API-1: Queue › Problem']])
  assert.deepEqual(rowsOfDecisions(work, DOC).map((r) => [r.ref, r.kind, r.text]), [['dec:t1#0', 'decision', 'Drain hourly'], ['dec:t1#1', 'decision', 'Keep retries']])
  const start = Date.parse('2026-11-20T14:30:00Z')
  const m = { id: 'm1', title: 'DBO sync', startedAt: '2026-11-20T14:30:00Z', summary: '## Decisions\n- Реліз переносимо', transcript: '# DBO sync\n\n> notice\n\n[00:01:02] me: Привіт\n' }
  assert.deepEqual(rowsOfMeeting(m).map((r) => [r.ref, r.text, r.at - start]), [
    ['mtg:m1', 'DBO sync', 0],
    ['mtg:m1', 'Decisions', 0],
    ['mtg:m1', 'Реліз переносимо', 0],
    ['mtg:m1@00:01:02', 'me: Привіт', 62_000],
  ])
})

test('parseRef of a deliverable names its version; withWorkspace keeps a ref that names its place', () => {
  assert.deepEqual(parseRef('aura:dlv:weekly@3'), { ws: 'aura', kind: 'dlv', id: 'weekly', version: 3 })
  assert.deepEqual(parseRef('dlv:weekly'), { ws: undefined, kind: 'dlv', id: 'weekly' })
  assert.deepEqual(parseRef('w1:person:olena-k'), { ws: 'w1', kind: 'person', id: 'olena-k' })
  assert.equal(withWorkspace('w1', 'aura:dlv:weekly@3'), 'aura:dlv:weekly@3')
  assert.equal(withWorkspace('w1', 'person:olena-k'), 'w1:person:olena-k')
})

test('rowsOfDeliverable: per version a title row with its kind and labels, then its sections; rowsOfPerson: one row with every handle', () => {
  const rows = rowsOfDeliverable({ ref: 'aura:dlv:weekly', title: 'Weekly', kind: 'report', labels: ['Privacy'], versions: [{ n: 2, at: 9, text: 'Intro\n\n# Risks\nDBR stalls' }] })
  assert.deepEqual(rows.map((r) => [r.ref, r.kind, r.title, r.text, r.at]), [
    ['aura:dlv:weekly@2', 'deliverable', 'Weekly · v2', 'Weekly · report · Privacy', 9],
    ['aura:dlv:weekly@2', 'deliverable', 'Weekly · v2', 'Intro', 9],
    ['aura:dlv:weekly@2', 'deliverable', 'Weekly · v2 › Risks', '# Risks\nDBR stalls', 9],
  ])
  const [p] = rowsOfPerson({ id: 'olena-k', name: 'Olena K', email: 'olena.mail', title: null, handles: [{ system: 'slack', handle: 'U1', name: 'olena.k' }, { system: 'github', handle: 'olenak', name: 'Olena K' }], syncedAt: 5 })
  assert.deepEqual(p, { ref: 'person:olena-k', kind: 'person', title: 'Olena K', text: 'Olena K\nolena.mail\nslack U1 (olena.k)\ngithub olenak', at: 5 })
})
