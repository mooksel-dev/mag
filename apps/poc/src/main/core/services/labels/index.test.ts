import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PLAYBOOK, type ItemRef, type Project, type Workspace } from '@mag/core'
import { createLabels, decisionSettings, type ItemPlace, type LabelRows } from './index.ts'

const workspace = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, name: id, profile: '', notes: '', repos: [], playbook: null, agents: {}, integrations: {}, createdAt: 0, ...over })
const project = (id: string, workspaceId: string, over: Partial<Project> = {}): Project => ({
  id, name: id, workspaceId, repos: [], notes: '', enforceArchitecture: false, architecture: null, archRun: null, agents: {}, integrations: {}, createdAt: 0, ...over,
})

function setup(over: { workspaces?: Workspace[]; projects?: Project[]; items?: Record<string, ItemPlace> } = {}) {
  const workspaces = over.workspaces ?? [workspace('aura'), workspace('personal')]
  const projects = over.projects ?? [project('dr', 'aura', { name: 'Data Removal' }), project('money', 'aura', { name: 'Money Problems' }), project('mag', 'personal')]
  const items: Record<string, ItemPlace> = over.items ?? { 'topic:t': { workspaceId: 'aura', projectId: null }, 'work:w': { workspaceId: 'aura', projectId: 'dr' } }
  const rows: LabelRows = { labelGroups: [], labels: [], itemLabels: [] }
  let changes = 0
  const labels = createLabels(rows, {
    workspaces: () => workspaces,
    projects: () => projects,
    item: (ref) => items[ref] ?? null,
    setProject: (ref, pid) => void (items[ref].projectId = pid),
    updateProject: (id, patch) => void Object.assign(projects.find((p) => p.id === id)!, patch),
  }, () => changes++)
  for (const w of workspaces) labels.ensureSystem(w.id)
  return { labels, rows, items, projects, workspaces, changes: () => changes }
}

test('each workspace has one Project group (exclusive) whose labels are its projects; ensureSystem is idempotent', () => {
  const { labels, rows } = setup()
  labels.ensureSystem('aura')
  assert.equal(rows.labelGroups.length, 2)
  const [g] = labels.groups('aura')
  assert.deepEqual([g.name, g.exclusive, g.system], ['Project', true, 'project'])
  assert.deepEqual(labels.labels(g.id).map((l) => l.name), ['Data Removal', 'Money Problems'])
  assert.throws(() => labels.upsertGroup({ id: g.id, workspaceId: 'aura', name: 'Proj', exclusive: false }), /system group/)
  assert.throws(() => labels.deleteGroup(g.id), /system group/)
})

test('user groups and labels: unique names, colors, rules; a Project label edits its project', () => {
  const { labels, projects } = setup()
  const area = labels.upsertGroup({ workspaceId: 'aura', name: 'Area', exclusive: false })
  assert.throws(() => labels.upsertGroup({ workspaceId: 'aura', name: ' area ', exclusive: true }), /exists/)
  labels.upsertGroup({ workspaceId: 'personal', name: 'Area', exclusive: true })
  const ui = labels.upsertLabel({ groupId: area.id, name: 'UI', color: '#112233', rules: [{ kind: 'repo', value: ' web ' }] })
  assert.deepEqual([ui.color, ui.rules], ['#112233', [{ kind: 'repo', value: 'web' }]])
  assert.throws(() => labels.upsertLabel({ groupId: area.id, name: 'ui' }), /has a label named ui/)
  assert.throws(() => labels.upsertLabel({ groupId: area.id, name: 'X', color: 'red' }), /Not a color/)
  assert.throws(() => labels.upsertLabel({ groupId: area.id, name: 'X', rules: [{ kind: 'repo', value: ' ' }] }), /needs a value/)
  const sys = labels.groups('aura')[0]
  assert.throws(() => labels.upsertLabel({ groupId: sys.id, name: 'New' }), /create the project/)
  const dr = labels.upsertLabel({ id: 'dr', groupId: sys.id, name: 'Data Removal', rules: [{ kind: 'repo', value: 'duff-brewery' }] })
  assert.deepEqual(dr.rules, [{ kind: 'repo', value: 'duff-brewery' }])
  labels.upsertLabel({ id: 'dr', groupId: sys.id, name: 'DR', color: '#abcdef' })
  assert.deepEqual([projects[0].name, projects[0].color], ['DR', '#abcdef'])
  assert.deepEqual(labels.labels(sys.id)[0].rules, [{ kind: 'repo', value: 'duff-brewery' }], 'rules stay when only the name changes')
})

test('setLabel in an exclusive group replaces the previous label; a multi group keeps several', () => {
  const { labels } = setup()
  const prio = labels.upsertGroup({ workspaceId: 'aura', name: 'Priority', exclusive: true })
  const [high, low] = ['High', 'Low'].map((name) => labels.upsertLabel({ groupId: prio.id, name }))
  const area = labels.upsertGroup({ workspaceId: 'aura', name: 'Area', exclusive: false })
  const [ui, api] = ['UI', 'API'].map((name) => labels.upsertLabel({ groupId: area.id, name }))
  const t: ItemRef = 'topic:t'
  labels.setLabel(t, high.id, 'user')
  labels.setLabel(t, low.id, 'user')
  labels.setLabel(t, ui.id, 'user')
  labels.setLabel(t, api.id, 'user')
  labels.setLabel(t, api.id, 'user')
  assert.deepEqual(labels.labelsOf(t).map((l) => l.name), ['Low', 'UI', 'API'])
  assert.throws(() => labels.upsertGroup({ id: area.id, workspaceId: 'aura', name: 'Area', exclusive: true }), /several labels of Area/)
  labels.removeLabel(t, ui.id)
  assert.deepEqual(labels.labelsOf(t).map((l) => l.name), ['Low', 'API'])
  assert.equal(labels.upsertGroup({ id: area.id, workspaceId: 'aura', name: 'Area', exclusive: true }).exclusive, true)
  labels.deleteLabel(low.id)
  assert.deepEqual(labels.labelsOf(t).map((l) => l.name), ['API'])
  labels.forget(t)
  assert.deepEqual(labels.labelsOf(t), [])
})

test('the Project label is the item’s project: set moves it, remove leaves it without one; other workspaces refuse', () => {
  const { labels, items } = setup()
  labels.setLabel('topic:t', 'money', 'user')
  assert.equal(items['topic:t'].projectId, 'money')
  assert.deepEqual(labels.labelsOf('topic:t').map((l) => l.name), ['Money Problems'])
  labels.setLabel('topic:t', 'dr', 'user')
  assert.equal(items['topic:t'].projectId, 'dr', 'exclusive: the project is replaced')
  labels.removeLabel('topic:t', 'dr')
  assert.equal(items['topic:t'].projectId, null)
  assert.throws(() => labels.setLabel('topic:t', 'mag', 'user'), /another workspace/)
  assert.throws(() => labels.labelsOf('topic:nope'), /No item/)
})

test('resolve: work §Decisions, then the project, then the workspace, then mag’s default', () => {
  const doc = '# Decisions\n- `playbook.reviewRounds`: 3\n- `notes`: from the work\n- Owner: plain text\n# Plan\n'
  const { labels } = setup({
    workspaces: [workspace('aura', { notes: 'ws notes', repos: ['/r/a', '/r/b'], playbook: { review: 'ws review' }, agents: { chat: { agent: 'codex', model: null, effort: null } } })],
    projects: [project('dr', 'aura', { notes: 'project notes', playbook: { review: 'project review' } }), project('bare', 'aura')],
    items: {
      'work:decided': { workspaceId: 'aura', projectId: 'dr', doc: { text: doc } },
      'work:w': { workspaceId: 'aura', projectId: 'dr', doc: { text: '' } },
      'topic:bare': { workspaceId: 'aura', projectId: 'bare' },
      'topic:none': { workspaceId: 'aura', projectId: null },
    },
  })
  assert.equal(labels.resolve('work:decided', 'notes'), 'from the work')
  assert.equal(labels.resolve('work:decided', 'playbook.reviewRounds'), 3)
  assert.equal(labels.resolve('work:w', 'notes'), 'project notes')
  assert.equal(labels.resolve('work:w', 'playbook.review'), 'project review')
  assert.equal(labels.resolve('topic:bare', 'notes'), 'ws notes')
  assert.equal(labels.resolve('topic:bare', 'playbook.review'), 'ws review')
  assert.deepEqual(labels.resolve('topic:none', 'repos'), ['/r/a', '/r/b'])
  assert.equal(labels.resolve('topic:none', 'agents.chat.agent'), 'codex')
  assert.equal(labels.resolve('work:w', 'playbook.reviewRounds'), DEFAULT_PLAYBOOK.reviewRounds)
  assert.equal(labels.resolve('work:w', 'playbook.plan'), DEFAULT_PLAYBOOK.plan)
  assert.equal(labels.resolve('work:w', 'agents.developer'), undefined)
  const s = labels.settings('work:decided')
  assert.deepEqual([s.notes, s.playbook.review, s.playbook.reviewRounds, s.playbook.plan, s.agents.chat?.agent], ['from the work', 'project review', 3, DEFAULT_PLAYBOOK.plan, 'codex'])
})

test('settings: a model choice is one value, never mixed across layers; integrations merge by role and id', () => {
  const { labels } = setup({
    workspaces: [workspace('aura', { agents: { chat: { agent: 'claude-code', model: 'opus', effort: 'high' } }, integrations: { chat: { slack: 'auto', jira: 'off' } } })],
    projects: [project('dr', 'aura', { agents: { chat: { agent: 'codex', model: null, effort: null } }, integrations: { chat: { jira: 'reads' } } })],
    items: { 'topic:t': { workspaceId: 'aura', projectId: 'dr' } },
  })
  const s = labels.settings('topic:t')
  assert.deepEqual(s.agents.chat, { agent: 'codex', model: null, effort: null })
  assert.deepEqual(s.integrations.chat, { slack: 'auto', jira: 'reads' })
})

test('decisionSettings: only "- `key`: value" lines of §Decisions, values as JSON else text; a step’s own subsection', () => {
  const doc = '# Decisions\n- `a.b`: {"x":1}\n- `c`: text here\n## W-1.2\n- `d`: 2\n## W-1.3\n- `e`: 3\n# Plan\n- `f`: 4'
  assert.deepEqual(decisionSettings(doc, 'W-1.2'), { a: { b: { x: 1 } }, c: 'text here', d: 2 })
})

test('autoLabel sets the Project from a repo, a Jira key or a channel the rules name', () => {
  const { labels, items } = setup({ items: { 'topic:a': { workspaceId: 'aura', projectId: null }, 'topic:b': { workspaceId: 'aura', projectId: null }, 'topic:c': { workspaceId: 'aura', projectId: null } } })
  const sys = labels.groups('aura')[0]
  labels.upsertLabel({ id: 'dr', groupId: sys.id, name: 'Data Removal', rules: [{ kind: 'repo', value: 'duff-brewery' }, { kind: 'jiraKey', value: 'PRVP' }, { kind: 'channel', value: '#data-removal' }] })
  assert.deepEqual(labels.autoLabel('topic:a', { repos: ['/Users/me/work/duff-brewery'] }).map((l) => l.id), ['dr'])
  labels.autoLabel('topic:b', { ticketKeys: ['prvp-123'] })
  labels.autoLabel('topic:c', { channels: ['Data-Removal'] })
  assert.deepEqual(['a', 'b', 'c'].map((x) => items[`topic:${x}`].projectId), ['dr', 'dr', 'dr'])
  assert.deepEqual(labels.autoLabel('topic:a', { ticketKeys: ['OTHER-1'] }), [])
})

test('autoLabel never overrides a label: a set project or a user label in a group stays', () => {
  const { labels, items } = setup({ items: { 'topic:t': { workspaceId: 'aura', projectId: 'money' } } })
  const sys = labels.groups('aura')[0]
  labels.upsertLabel({ id: 'dr', groupId: sys.id, name: 'Data Removal', rules: [{ kind: 'jiraKey', value: 'PRVP' }] })
  const area = labels.upsertGroup({ workspaceId: 'aura', name: 'Area', exclusive: false })
  const ui = labels.upsertLabel({ groupId: area.id, name: 'UI' })
  labels.upsertLabel({ groupId: area.id, name: 'Privacy', rules: [{ kind: 'jiraKey', value: 'PRVP' }] })
  labels.setLabel('topic:t', ui.id, 'user')
  assert.deepEqual(labels.autoLabel('topic:t', { ticketKeys: ['PRVP-1'] }), [])
  assert.equal(items['topic:t'].projectId, 'money')
  assert.deepEqual(labels.labelsOf('topic:t').map((l) => l.name), ['Money Problems', 'UI'])
  labels.setLabel('topic:t', ui.id, 'rule')
  assert.equal(labels.labelsOf('topic:t').length, 2, 'a rule never takes a user label over')
})

test('autoLabel leaves an ambiguous exclusive group empty unless the opened-from project decides; a multi group gets all', () => {
  const { labels, items } = setup({ items: { 'topic:x': { workspaceId: 'aura', projectId: null }, 'topic:y': { workspaceId: 'aura', projectId: null } } })
  const sys = labels.groups('aura')[0]
  for (const id of ['dr', 'money']) labels.upsertLabel({ id, groupId: sys.id, name: id === 'dr' ? 'Data Removal' : 'Money Problems', rules: [{ kind: 'repo', value: 'shared' }] })
  const area = labels.upsertGroup({ workspaceId: 'aura', name: 'Area', exclusive: false })
  for (const name of ['A', 'B']) labels.upsertLabel({ groupId: area.id, name, rules: [{ kind: 'repo', value: 'shared' }] })
  assert.deepEqual(labels.autoLabel('topic:x', { repos: ['/r/shared'] }).map((l) => l.name), ['A', 'B'])
  assert.equal(items['topic:x'].projectId, null)
  assert.deepEqual(labels.autoLabel('topic:y', { repos: ['/r/shared'], openedFrom: 'money' }).map((l) => l.name), ['Money Problems', 'A', 'B'])
  assert.equal(items['topic:y'].projectId, 'money')
})
