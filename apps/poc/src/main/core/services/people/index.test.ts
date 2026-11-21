import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Workspace, WorkspaceDirectories } from '@mag/core'
import type { Directories, DirUser } from '../../clients/directories/index.ts'
import { createPeople, identityId, nameScore, personSlug, type PeopleRows } from './index.ts'

const slackUsers: DirUser[] = [
  { system: 'slack', handle: 'U1', name: 'Ievgen Bezpaly', email: 'ievgen@aura.test', title: 'Engineer', avatar: 'a.png' },
  { system: 'slack', handle: 'U2', name: 'Ihor Koval', email: 'ihor.k@aura.test' },
  { system: 'slack', handle: 'U3', name: 'Ihor Shevchenko', email: 'ihor.s@aura.test' },
  { system: 'slack', handle: 'B1', name: 'Jira Bot', bot: true },
]
const jira: DirUser[] = [
  { system: 'atlassian', handle: '712020:a', name: 'Ievgen Bezpaly', email: 'ievgen@aura.test' },
  { system: 'atlassian', handle: '712020:z', name: 'Somebody Else', email: 'else@aura.test' },
]
const github: DirUser[] = [
  { system: 'github', handle: 'bezpaluy89', name: 'bezpaluy89' },
  { system: 'github', handle: 'ikoval', name: 'Ihor K', email: 'ihor.k@aura.test' },
  { system: 'github', handle: 'ishev', name: 'ishev' },
  { system: 'github', handle: 'dependabot-ish', name: 'dependabot-ish' },
]

function setup(dirs: WorkspaceDirectories = { slack: true, atlassian: true, githubOrgs: ['aura'] }, over: Partial<Directories> = {}) {
  const rows: PeopleRows = { persons: [], identities: [], identityOverrides: [] }
  const ws: Workspace = { id: 'w1', name: 'Aura', profile: '', notes: '', repos: ['/r'], agents: {}, integrations: {}, directories: dirs, createdAt: 0 }
  const calls: string[] = []
  const directories: Directories = {
    slackUsers: async () => (calls.push('slack'), slackUsers),
    atlassianUsers: async (keys) => (calls.push(`jira:${keys.join(',')}`), jira),
    githubMembers: async (org) => (calls.push(`gh:${org}`), github),
    commitEmails: async (repos, logins) => (calls.push(`commits:${repos.join(',')}:${[...logins].sort().join(',')}`), new Map([['ishev', ['ishev@home.test', 'ihor.s@aura.test']]])),
    githubOwners: async () => ['owner'],
    ...over,
  }
  let changes = 0
  const people = createPeople(rows, { workspace: (id) => (id === ws.id ? ws : undefined), repos: () => ws.repos, jiraKeys: () => ['PRVP'] }, directories, () => changes++, () => 1000)
  return { rows, people, calls, ws, changes: () => changes }
}

test('sync: a person per Slack member, bots left out; Atlassian by email, GitHub by email and commit email; counts', async () => {
  const { rows, people, calls } = setup()
  const r = await people.sync('w1')
  assert.deepEqual(rows.persons.map((p) => [p.id, p.name, p.email, p.title]), [
    ['ievgen-bezpaly', 'Ievgen Bezpaly', 'ievgen@aura.test', 'Engineer'],
    ['ihor-koval', 'Ihor Koval', 'ihor.k@aura.test', null],
    ['ihor-shevchenko', 'Ihor Shevchenko', 'ihor.s@aura.test', null],
  ])
  const of = (system: string, handle: string) => rows.identities.find((i) => i.id === identityId('w1', system as 'slack', handle))
  assert.equal(of('slack', 'B1'), undefined)
  assert.deepEqual([of('atlassian', '712020:a')?.personId, of('atlassian', '712020:a')?.source], ['ievgen-bezpaly', 'email'])
  assert.deepEqual([of('github', 'ikoval')?.personId, of('github', 'ikoval')?.source], ['ihor-koval', 'email'])
  assert.deepEqual([of('github', 'ishev')?.personId, of('github', 'ishev')?.source], ['ihor-shevchenko', 'commit'])
  assert.equal(of('github', 'bezpaluy89')?.personId, null)
  assert.deepEqual(calls, ['slack', 'jira:PRVP', 'gh:aura', 'commits:/r:bezpaluy89,dependabot-ish,ishev'])
  // matched: 712020:a, ikoval, ishev; new: 3 Slack members; unmatched: 712020:z, bezpaluy89, dependabot-ish.
  assert.deepEqual([r.matched, r.new, r.unmatched, r.errors], [3, 3, 3, []])
})

test('sync again: no new persons, Slack details refreshed, everything matched stays', async () => {
  const { rows, people } = setup()
  await people.sync('w1')
  slackUsers[1] = { ...slackUsers[1], title: 'Lead' }
  const r = await people.sync('w1')
  assert.equal(rows.persons.length, 3)
  assert.equal(rows.persons.find((p) => p.id === 'ihor-koval')?.title, 'Lead')
  assert.deepEqual([r.matched, r.new, r.unmatched], [6, 0, 3])
  slackUsers[1] = { ...slackUsers[1], title: undefined }
})

test('resolve: override wins over identity, email and commit email', async () => {
  const { people } = setup()
  await people.sync('w1')
  people.override({ workspaceId: 'w1', system: 'github', handle: 'ikoval', personId: 'ihor-shevchenko' })
  const r = people.resolve('w1', 'github', 'IKoval')
  assert.equal(r.kind === 'person' && r.person.id, 'ihor-shevchenko')
  assert.equal(r.kind === 'person' && r.source, 'override')
})

test('resolve: an override to null is not a person', async () => {
  const { people } = setup()
  await people.sync('w1')
  people.override({ workspaceId: 'w1', system: 'github', handle: 'dependabot-ish', personId: null })
  assert.deepEqual(people.resolve('w1', 'github', 'dependabot-ish'), { kind: 'notPerson' })
})

test('resolve: the identity row is next', async () => {
  const { people } = setup()
  await people.sync('w1')
  const r = people.resolve('w1', 'slack', 'U2')
  assert.equal(r.kind === 'person' && r.person.id, 'ihor-koval')
  assert.equal(r.kind === 'person' && r.source, 'directory')
  assert.ok(r.kind === 'person' && r.person.handles.some((h) => h.system === 'github' && h.handle === 'ikoval'))
})

test('resolve: email, then commit email (GitHub only), stored on the identity', async () => {
  const { rows, people } = setup({ slack: true })
  await people.sync('w1')
  rows.identities.push({ id: identityId('w1', 'atlassian', 'x'), workspaceId: 'w1', system: 'atlassian', handle: 'x', personId: null, source: null, email: 'ihor.k@aura.test', syncedAt: 1 })
  rows.identities.push({ id: identityId('w1', 'github', 'y'), workspaceId: 'w1', system: 'github', handle: 'y', personId: null, source: null, commitEmails: ['ievgen@aura.test'], syncedAt: 1 })
  rows.identities.push({ id: identityId('w1', 'atlassian', 'z'), workspaceId: 'w1', system: 'atlassian', handle: 'z', personId: null, source: null, commitEmails: ['ievgen@aura.test'], syncedAt: 1 })
  const byMail = people.resolve('w1', 'atlassian', 'x')
  assert.deepEqual(byMail.kind === 'person' && [byMail.person.id, byMail.source], ['ihor-koval', 'email'])
  assert.equal(rows.identities.find((i) => i.handle === 'x')?.personId, 'ihor-koval')
  const byCommit = people.resolve('w1', 'github', 'y')
  assert.deepEqual(byCommit.kind === 'person' && [byCommit.person.id, byCommit.source], ['ievgen-bezpaly', 'commit'])
  assert.equal(people.resolve('w1', 'atlassian', 'z').kind, 'unknown')
})

test('resolve: a close name only suggests; two close persons suggest none', async () => {
  const { rows, people } = setup()
  await people.sync('w1')
  const r = people.resolve('w1', 'github', 'bezpaluy89')
  assert.equal(r.kind, 'unknown')
  assert.equal(r.kind === 'unknown' && r.suggestion?.id, 'ievgen-bezpaly')
  assert.equal(rows.identities.find((i) => i.handle === 'bezpaluy89')?.personId, null)
  assert.deepEqual(people.resolve('w1', 'meeting', 'Ihor'), { kind: 'unknown' })
  assert.deepEqual(people.resolve('w1', 'meeting', 'Zzz Qqq'), { kind: 'unknown' })
})

test('People: a suggestion confirmed writes an override that survives a re-sync; a rejected one is not suggested again', async () => {
  const { rows, people } = setup()
  await people.sync('w1')
  const list = people.list('w1')
  assert.deepEqual(list.suggestions.map((s) => [s.system, s.handle, s.person.id]), [['github', 'bezpaluy89', 'ievgen-bezpaly']])
  assert.deepEqual(list.unmatched.map((i) => i.handle).sort(), ['712020:z', 'dependabot-ish'])
  people.override({ workspaceId: 'w1', system: 'github', handle: 'bezpaluy89', personId: 'ievgen-bezpaly' })
  await people.sync('w1')
  const after = people.resolve('w1', 'github', 'bezpaluy89')
  assert.deepEqual(after.kind === 'person' && [after.person.id, after.source], ['ievgen-bezpaly', 'override'])
  assert.equal(rows.identityOverrides.length, 1)
  assert.equal(people.list('w1').suggestions.length, 0)

  people.override({ workspaceId: 'w1', system: 'github', handle: 'bezpaluy89', personId: null })
  people.reject('w1', 'meeting', 'Ievgen B', 'ievgen-bezpaly')
  assert.deepEqual(people.resolve('w1', 'meeting', 'Ievgen B'), { kind: 'unknown' })
})

test('Not a person: the person goes, its handles stay not a person across syncs', async () => {
  const { rows, people } = setup({ slack: true })
  await people.sync('w1')
  people.notPerson('w1', 'ihor-koval')
  assert.equal(rows.persons.some((p) => p.id === 'ihor-koval'), false)
  const r = await people.sync('w1')
  assert.equal(rows.persons.some((p) => p.name === 'Ihor Koval'), false)
  assert.deepEqual(people.resolve('w1', 'slack', 'U2'), { kind: 'notPerson' })
  assert.equal(r.new, 0)
  // bezpaluy89 and dependabot-ish; U2 and ikoval are not persons now.
  assert.equal(r.unmatched, 2)
})

test('who: by any handle, email or id; people: candidates', async () => {
  const { people } = setup()
  await people.sync('w1')
  const r = people.who('w1', '@IKoval')
  assert.equal(r.kind === 'person' && r.person.id, 'ihor-koval')
  const mail = people.who('w1', 'ihor.s@aura.test')
  assert.equal(mail.kind === 'person' && mail.person.id, 'ihor-shevchenko')
  const near = people.who('w1', 'bezpaluy89')
  assert.equal(near.kind === 'unknown' && near.suggestion?.id, 'ievgen-bezpaly')
  assert.deepEqual(people.who('w1', 'nobody'), { kind: 'unknown' })
  assert.deepEqual(people.find('w1', 'Ihor').map((p) => p.id), ['ihor-koval', 'ihor-shevchenko'])
  assert.deepEqual(people.find('w1', 'ikoval').map((p) => p.id), ['ihor-koval'])
  assert.deepEqual(people.find('w1', ''), [])
})

test('workspaces keep their own persons', async () => {
  const { people } = setup()
  await people.sync('w1')
  assert.deepEqual(people.who('w2', 'ikoval'), { kind: 'unknown' })
  assert.throws(() => people.override({ workspaceId: 'w1', system: 'github', handle: 'x', personId: 'nobody' }), /No person/)
})

test('without Slack, the other directories make the persons, after commit emails had their go', async () => {
  const { rows, people } = setup({ atlassian: true, githubOrgs: ['aura'] })
  const r = await people.sync('w1')
  assert.deepEqual(rows.persons.map((p) => p.name).sort(), ['Ievgen Bezpaly', 'Ihor K', 'Somebody Else', 'bezpaluy89', 'dependabot-ish', 'ishev'])
  assert.equal(r.new, 6)
})

test('a failing directory is reported; the others sync; one sync at a time', async () => {
  const { rows, people, calls } = setup(undefined, { slackUsers: async () => { throw new Error('not logged in\nmore') } })
  const [a, b] = [people.sync('w1'), people.sync('w1')]
  assert.equal(a, b)
  const r = await a
  assert.deepEqual(r.errors, ['Slack: not logged in'])
  assert.equal(rows.persons.length, 0)
  assert.equal(r.unmatched, 6)
  assert.equal(calls.filter((c) => c.startsWith('gh:')).length, 1)
  assert.equal(people.list('w1').lastSync, r)
  assert.equal(people.lastSyncedAt('w1'), 1000)
})

test('nameScore and personSlug', () => {
  assert.ok(nameScore('bezpaluy89', 'Ievgen Bezpaly') >= 0.8)
  assert.ok(nameScore('ievgen bezpaly', 'Ievgen Bezpaly') === 1)
  assert.ok(nameScore('ibezpaly', 'Ievgen Bezpaly') >= 0.8)
  assert.ok(nameScore('olena', 'Ievgen Bezpaly') < 0.8)
  assert.ok(nameScore('al', 'Al Smith') < 0.8)
  assert.equal(personSlug('Ievgen Bezpalý', () => false), 'ievgen-bezpaly')
  assert.equal(personSlug('Ихор', () => false), 'person')
  assert.equal(personSlug('A B', (id) => id === 'a-b'), 'a-b-2')
})
