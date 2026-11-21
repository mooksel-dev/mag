import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Meeting } from './core/services/meetings/index.ts'
import type { Resolution } from './core/services/people/index.ts'
import { meetingPeople, noteMeetingPeople } from './meeting-people.ts'
import { meetingFacts, projectScopes } from './people-sources.ts'
import type { Store } from './store'

const store = {
  data: {
    workspaces: [{ id: 'w1', repos: ['/code/app', '/code/infra', '/code/web/'] }, { id: 'w2', repos: [] }],
    projects: [
      { id: 'pa', name: 'Alpha', workspaceId: 'w1', repos: ['/code/app'] },
      { id: 'pb', name: 'Beta', workspaceId: 'w1', repos: [] },
      { id: 'pc', name: 'Gamma', workspaceId: 'w2', repos: [] },
    ],
    labels: [
      { id: 'pa', groupId: 'w1:project', name: 'Alpha', color: '', rules: [{ kind: 'jiraKey', value: 'prvp-12' }, { kind: 'repo', value: 'app' }] },
      { id: 'pb', groupId: 'w1:project', name: 'Beta', color: '', rules: [{ kind: 'repo', value: 'web' }, { kind: 'repo', value: '/code/infra' }, { kind: 'jiraKey', value: 'DATA' }, { kind: 'channel', value: '#beta' }] },
    ],
    identities: [] as unknown[],
  },
} as unknown as Pick<Store, 'data'>

test('projectScopes: a project\'s repos and the workspace repos its rules match by path or folder; Jira key prefixes', () => {
  assert.deepEqual(projectScopes(store, 'w1'), [
    { id: 'pa', name: 'Alpha', repos: ['/code/app'], jiraKeys: ['PRVP'] },
    { id: 'pb', name: 'Beta', repos: ['/code/infra', '/code/web/'], jiraKeys: ['DATA'] },
  ])
  assert.deepEqual(projectScopes(store, 'w2'), [{ id: 'pc', name: 'Gamma', repos: [], jiraKeys: [] }])
})

const meeting = (id: string, startedAt: string, projectIds: string[]): Meeting => ({ id, title: id, startedAt, links: projectIds.map((projectId) => ({ projectId, topicId: 't' })) })
const meetings = {
  list: () => [meeting('m1', '2026-11-10T10:00:00Z', ['pa', 'pc']), meeting('m2', '2026-11-11T10:00:00Z', []), meeting('m3', '2026-01-01T10:00:00Z', ['pb']), meeting('m4', '2026-11-12T10:00:00Z', ['pc'])],
  participants: (id: string) => (id === 'm1' ? ['Olena', 'Ihor'] : ['Ann']),
  read: (id: string) => ({ meta: meetings.list().find((m) => m.id === id)!, summary: '', transcript: '', dir: '' }),
}

test('meetingFacts: meetings in the dates linked to a project of the workspace, with who took part', () => {
  assert.deepEqual(meetingFacts(store, meetings, 'w1', Date.parse('2026-11-01'), Date.parse('2026-11-30')), [{ id: 'm1', startedAt: Date.parse('2026-11-10T10:00:00Z'), projectIds: ['pa'], names: ['Olena', 'Ihor'] }])
  assert.deepEqual(meetingFacts(store, undefined, 'w1', 0, Infinity), [])
})

test('meetingPeople: chips as the looking workspace resolves; names kept in the meeting\'s workspaces too. noteMeetingPeople: linked meetings only', () => {
  const kept: string[] = []
  const people = {
    identify: (ws: string, system: string, name: string): Resolution => {
      kept.push(`${ws}:${system}:${name}`)
      const p = { id: 'olena', workspaceId: ws, name: 'Olena Petrenko', email: null, title: null, avatar: 'o.png', external: false, syncedAt: 0, handles: [] }
      return name === 'Olena' ? { kind: 'person', person: p, source: 'override' } : name === 'Ihor' ? { kind: 'unknown', suggestion: { ...p, id: 'ihor', name: 'Ihor Koval' } } : { kind: 'unknown' }
    },
  }
  assert.deepEqual(meetingPeople({ store, people, meetings }, 'm1', 'w1'), [
    { name: 'Olena', person: { id: 'olena', name: 'Olena Petrenko', avatar: 'o.png' } },
    { name: 'Ihor', suggestion: { id: 'ihor', name: 'Ihor Koval' } },
  ])
  assert.deepEqual(kept, ['w2:meeting:Olena', 'w2:meeting:Ihor', 'w1:meeting:Olena', 'w1:meeting:Ihor'])
  kept.length = 0
  noteMeetingPeople({ store, people, meetings })
  assert.deepEqual(kept, ['w1:meeting:Olena', 'w1:meeting:Ihor', 'w2:meeting:Olena', 'w2:meeting:Ihor', 'w1:meeting:Ann', 'w2:meeting:Ann'])
})
