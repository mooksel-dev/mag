import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Workspace } from '@mag/core'
import type { Activity, Pr, Ticket } from '../../clients/activity/index.ts'
import type { Directories } from '../../clients/directories/index.ts'
import { createPeople, identityId, type Identity, type MeetingFacts, type PeopleRows, type PeopleSystem, type Person } from './index.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 21, 12)
const ago = (days: number) => NOW - days * DAY

const person = (id: string, name: string): Person => ({ id, workspaceId: 'w1', name, email: null, title: null, avatar: null, external: false, syncedAt: 1 })
const handle = (system: PeopleSystem, h: string, personId: string | null): Identity => ({ id: identityId('w1', system, h), workspaceId: 'w1', system, handle: h, personId, source: personId ? 'directory' : null, syncedAt: 1 })
const pr = (repo: string, number: number, author: string, createdAt: number, reviews: [string, number][] = [], mergedAt: number | null = null): Pr => ({ repo, number, title: `PR ${number}`, url: '', author, createdAt, mergedAt, reviews: reviews.map(([a, at]) => ({ author: a, at })) })

function setup(prs: Pr[], tickets: Ticket[] = [], meetings: MeetingFacts[] = []) {
  const rows: PeopleRows = {
    persons: [person('ievgen', 'Ievgen Bezpaly'), person('ihor', 'Ihor Koval')],
    identities: [handle('github', 'bezpaluy89', 'ievgen'), handle('github', 'ievgen-b', 'ievgen'), handle('atlassian', 'acc-ievgen', 'ievgen'), handle('github', 'ikoval', 'ihor'), handle('atlassian', 'acc-ihor', 'ihor')],
    identityOverrides: [],
  }
  const ws: Workspace = { id: 'w1', name: 'Aura', profile: '', notes: '', repos: ['/a', '/b', '/c'], agents: {}, integrations: {}, createdAt: 0 }
  const calls: string[] = []
  let now = NOW
  let failTickets = false
  const activity: Activity = {
    prs: async (repos, from, to) => (calls.push(`prs:${repos.join(',')}:${(to - from) / DAY}`), prs.filter((p) => repos.includes(p.repo))),
    tickets: async (jql) => {
      calls.push(`tickets:${jql}`)
      if (failTickets) throw new Error('acli: not logged in')
      return tickets
    },
  }
  const scopes = [
    { id: 'pa', name: 'Alpha', repos: ['/a'], jiraKeys: ['PRVP'] },
    { id: 'pb', name: 'Beta', repos: ['/b'], jiraKeys: ['data'] },
  ]
  const people = createPeople(
    rows,
    { workspace: (id) => (id === 'w1' ? ws : undefined), repos: () => ws.repos, jiraKeys: () => [], projects: () => scopes, meetings: (_, from, to) => meetings.filter((m) => m.startedAt >= from && m.startedAt <= to) },
    { directories: {} as Directories, activity },
    () => {},
    () => now,
  )
  return { rows, people, calls, setNow: (t: number) => (now = t), failTickets: (v: boolean) => (failTickets = v) }
}

test('activity: a developer active in two projects shows both, with PRs, reviews, tickets and meetings of the last 60 days', async () => {
  const { people, calls } = setup(
    [
      pr('/a', 1, 'bezpaluy89', ago(5)),
      pr('/a', 2, 'bezpaluy89', ago(90), [['ikoval', ago(80)]]),
      pr('/b', 3, 'ikoval', ago(10), [['ievgen-b', ago(9)], ['bezpaluy89', ago(8)]]),
      pr('/b', 4, 'ievgen-b', ago(3), [['ievgen-b', ago(2)]]),
    ],
    [
      { key: 'DATA-1', assignee: 'acc-ievgen', reporter: 'acc-ihor', updatedAt: ago(1) },
      { key: 'PRVP-7', assignee: 'acc-ihor', reporter: 'acc-ihor', updatedAt: ago(1) },
    ],
    [{ id: 'm1', startedAt: ago(2), projectIds: ['pb'], names: ['Ievgen Bezpaly'] }],
  )
  people.override({ workspaceId: 'w1', system: 'meeting', handle: 'Ievgen Bezpaly', personId: 'ievgen' })
  const w = await people.activity('ievgen')
  assert.deepEqual(w.projects, [
    { labelId: 'pb', label: 'Beta', prs: 1, reviews: 1, tickets: 1, meetings: 1 },
    { labelId: 'pa', label: 'Alpha', prs: 1, reviews: 0, tickets: 0, meetings: 0 },
  ])
  assert.deepEqual([w.days, w.from, w.errors], [60, ago(60), []])
  assert.deepEqual(calls, ['prs:/a:60', 'prs:/b:60', 'tickets:project in (PRVP, DATA) AND updated >= -60d'])
  const ihor = await people.activity('ihor')
  assert.deepEqual(ihor.projects, [
    { labelId: 'pb', label: 'Beta', prs: 1, reviews: 0, tickets: 1, meetings: 0 },
    { labelId: 'pa', label: 'Alpha', prs: 0, reviews: 0, tickets: 1, meetings: 0 },
  ])
  await assert.rejects(people.activity('nobody'), /No person/)
})

test('activity: fetched once a day; a failed source is reported and fetched again next time', async () => {
  const { people, calls, setNow, failTickets } = setup([pr('/a', 1, 'bezpaluy89', ago(1))], [], [])
  await people.activity('ievgen')
  await people.activity('ihor')
  assert.equal(calls.length, 3)
  setNow(NOW + DAY)
  await people.activity('ievgen')
  assert.equal(calls.length, 6)
  failTickets(true)
  setNow(NOW + 2 * DAY)
  const w = await people.activity('ievgen')
  assert.deepEqual(w.errors, ['Tickets: acli: not logged in'])
  assert.deepEqual(w.projects, [{ labelId: 'pa', label: 'Alpha', prs: 1, reviews: 0, tickets: 0, meetings: 0 }])
  failTickets(false)
  assert.deepEqual((await people.activity('ievgen')).errors, [])
  assert.equal(calls.length, 12)
})

test('prStats: two handles of one person count once; reviews of own PRs left out; unmatched logins, bots, labels and dates', async () => {
  const { people } = setup([
    pr('/a', 1, 'bezpaluy89', ago(5), [], ago(4)),
    pr('/a', 2, 'ievgen-b', ago(4)),
    pr('/a', 3, 'ikoval', ago(3), [['bezpaluy89', ago(2)], ['ievgen-b', ago(1)], ['ikoval', ago(1)]]),
    pr('/b', 4, 'stranger', ago(3), [['dependabot-ish', ago(2)]]),
    pr('/c', 5, 'ikoval', ago(3)),
    pr('/a', 6, 'ikoval', ago(40), [['bezpaluy89', ago(40)]]),
  ])
  people.override({ workspaceId: 'w1', system: 'github', handle: 'dependabot-ish', personId: null })
  const s = await people.prStats('w1', ago(10), NOW)
  assert.deepEqual(
    s.rows.map((r) => [r.label, r.name, r.personId, r.logins.join(','), r.prs, r.merged, r.reviews]),
    [
      ['Alpha', 'Ievgen Bezpaly', 'ievgen', 'bezpaluy89,ievgen-b', 2, 1, 1],
      ['Alpha', 'Ihor Koval', 'ihor', 'ikoval', 1, 0, 0],
      ['Beta', 'stranger', null, 'stranger', 1, 0, 0],
      ['No project', 'Ihor Koval', 'ihor', 'ikoval', 1, 0, 0],
    ],
  )
  const beta = await people.prStats('w1', ago(10), NOW, ['beta'])
  assert.deepEqual(beta.rows.map((r) => [r.label, r.name]), [['Beta', 'stranger']])
  await assert.rejects(people.prStats('w1', ago(10), NOW, ['Gamma']), /No Project label "Gamma"; labels: Alpha, Beta/)
  await assert.rejects(people.prStats('w1', NOW, ago(1)), /from is before to/)
})

test('identify: a name said on a call is kept, so People suggests its person; resolving again keeps one row', () => {
  const { rows, people } = setup([])
  const r = people.identify('w1', 'meeting', 'Ievgen Bezpalyi')
  assert.equal(r.kind === 'unknown' && r.suggestion?.id, 'ievgen')
  people.identify('w1', 'meeting', ' ievgen  bezpalyi ')
  assert.equal(rows.identities.filter((i) => i.system === 'meeting').length, 1)
  assert.deepEqual(people.list('w1').suggestions.map((x) => [x.system, x.name, x.person.id]), [['meeting', 'Ievgen Bezpalyi', 'ievgen']])
  // Not a directory sync: the daily sync still runs.
  assert.equal(people.lastSyncedAt('w1'), 1)
})
