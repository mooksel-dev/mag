import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '@mag/core'
import type { RunSpec } from '@mag/agents'
import { SLACK_READ_TOOLS, createDirectories, githubRepo, noreplyLogin, parseJiraUsers, parseSlackUsers, type Run } from './index.ts'

const mail = (user: string, domain: string) => [user, domain].join(String.fromCharCode(64))
const NOREPLY = 'users.noreply.github.com'
const ssh = (repo: string) => `${mail('git', 'github.com')}:${repo}`
const IHOR = mail('ihor', 'aura.test')
const ANN = mail('ann', 'aura.test')
const IEVGEN = mail('ievgen', 'aura.test')
const OTHER = mail('other', 'aura.test')
const ISHEV_NOREPLY = mail('12+ishev', NOREPLY)

const fakeAgent = (events: AgentEvent[], specs: RunSpec[]) => ({
  start: (spec: RunSpec, on: (e: AgentEvent) => void) => {
    specs.push(spec)
    for (const e of events) on(e)
    return { kill: () => {}, done: Promise.resolve() }
  },
})

test('slackUsers: a read-only run allowed only the Slack read tools; its last message parsed', async () => {
  const specs: RunSpec[] = []
  const members = [{ id: 'U1', name: 'Ihor', email: IHOR.toUpperCase(), bot: false }, { id: 'U2', name: 'Gone', deleted: true }, { id: 'bad', name: 'x' }, { id: 'W9', name: 'Bot', bot: true }]
  const answer = ['```json', JSON.stringify(members), '```'].join('\n')
  const dirs = createDirectories({ cwd: '/tmp', slackServer: () => 'plugin_slack_slack', adapter: fakeAgent([{ type: 'message', text: 'thinking' }, { type: 'message', text: answer }, { type: 'turn.done', ok: true }], specs) })
  assert.deepEqual(await dirs.slackUsers(), [
    { system: 'slack', handle: 'U1', name: 'Ihor', email: IHOR, title: undefined, avatar: undefined, external: false, bot: false },
    { system: 'slack', handle: 'W9', name: 'Bot', email: undefined, title: undefined, avatar: undefined, external: false, bot: true },
  ])
  assert.deepEqual(specs[0].allowedTools, SLACK_READ_TOOLS.map((t) => `mcp__plugin_slack_slack__${t}`))
  assert.ok(specs[0].disallowedTools?.includes('Bash'))
  assert.equal(specs[0].readOnly, true)
  assert.equal(specs[0].noTools, undefined)
})

test('slackUsers: no Slack server, a failed run or a non-JSON answer rejects', async () => {
  await assert.rejects(createDirectories({ cwd: '/tmp', slackServer: () => null }).slackUsers(), /no Slack MCP/)
  await assert.rejects(createDirectories({ cwd: '/tmp', slackServer: () => 's', adapter: fakeAgent([{ type: 'error', message: 'auth' }], []) }).slackUsers(), /Slack: auth/)
  assert.throws(() => parseSlackUsers('Here they are'), /not JSON/)
  assert.throws(() => parseSlackUsers('{"id":"U1"}'), /not a JSON array/)
})

test('atlassianUsers: one acli search of the keys, assignees and reporters once, apps left out', async () => {
  const calls: string[][] = []
  const json = JSON.stringify([
    { fields: { assignee: { accountId: 'a1', displayName: 'Ann', emailAddress: ANN, accountType: 'atlassian', avatarUrls: { '48x48': 'ann.png' } }, reporter: { accountId: 'app', displayName: 'Automation', accountType: 'app' } } },
    { fields: { assignee: null, reporter: { accountId: 'a1', displayName: 'Ann' } } },
  ])
  const run: Run = async (cmd, args) => (calls.push([cmd, ...args]), json)
  const users = await createDirectories({ cwd: '/tmp', slackServer: () => null, run }).atlassianUsers(['prvp', 'bad key)'])
  assert.deepEqual(users, [{ system: 'atlassian', handle: 'a1', name: 'Ann', email: ANN, avatar: 'ann.png', external: false }])
  assert.deepEqual(calls[0].slice(0, 5), ['acli', 'jira', 'workitem', 'search', '--jql'])
  assert.equal(calls[0][5], 'project in (PRVP) AND updated >= -90d')
  assert.equal(parseJiraUsers('[]').length, 0)
})

test('githubMembers: pages of the org members; not an org rejects', async () => {
  const pages = [
    { data: { organization: { membersWithRole: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ login: 'IKoval', name: 'Ihor K', email: '', avatarUrl: 'i.png' }] } } } },
    { data: { organization: { membersWithRole: { pageInfo: { hasNextPage: false, endCursor: 'c2' }, nodes: [{ login: 'bezpaluy89', name: null, email: IEVGEN }] } } } },
  ]
  const calls: string[][] = []
  const run: Run = async (_, args) => (calls.push(args), JSON.stringify(pages[calls.length - 1]))
  const users = await createDirectories({ cwd: '/tmp', slackServer: () => null, run }).githubMembers('aura')
  assert.deepEqual(users.map((u) => [u.handle, u.name, u.email]), [['ikoval', 'Ihor K', undefined], ['bezpaluy89', 'bezpaluy89', IEVGEN]])
  assert.ok(calls[1].includes('cursor=c1'))
  const none: Run = async () => JSON.stringify({ data: { organization: null } })
  await assert.rejects(createDirectories({ cwd: '/tmp', slackServer: () => null, run: none }).githubMembers('someone'), /not an organization/)
})

test('commitEmails: noreply addresses by their login, others by the commit author gh names; only the logins asked', async () => {
  const asked: string[] = []
  const run: Run = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'remote') return `${ssh('aura/app.git')}\n`
    if (cmd === 'git') return [`s1\t${ISHEV_NOREPLY}`, `s2\t${IHOR}`, `s3\t${IHOR}`, `s4\t${OTHER}`].join('\n')
    asked.push(args[1])
    if (args[1] === 'repos/aura/app/commits/s2') return 'IKoval\n'
    if (args[1] === 'repos/aura/app/commits/s4') return 'someone\n'
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
  }
  const dirs = createDirectories({ cwd: '/tmp', slackServer: () => null, run })
  const map = await dirs.commitEmails(['/r'], ['IShev', 'ikoval'])
  assert.deepEqual([...map], [['ishev', [ISHEV_NOREPLY]], ['ikoval', [IHOR]]])
  // The newest commit of an address only.
  assert.deepEqual(asked, ['repos/aura/app/commits/s2', 'repos/aura/app/commits/s4'])
  assert.equal((await dirs.commitEmails(['/r'], [])).size, 0)
})

test('githubRepo, noreplyLogin, githubOwners', async () => {
  assert.deepEqual(githubRepo('https://github.com/aura/app.git'), { owner: 'aura', name: 'app' })
  assert.deepEqual(githubRepo(ssh('aura/app.git')), { owner: 'aura', name: 'app' })
  assert.equal(githubRepo(`${mail('git', 'gitlab.com')}:a/b.git`), null)
  assert.equal(noreplyLogin(mail('1+AB', NOREPLY)), 'ab')
  assert.equal(noreplyLogin(mail('ab', 'aura.test')), null)
  const run: Run = async (_, __, cwd) => (cwd === '/x' ? 'https://github.com/aura/x' : cwd === '/y' ? ssh('aura/y.git') : '')
  assert.deepEqual(await createDirectories({ cwd: '/tmp', slackServer: () => null, run }).githubOwners(['/x', '/y', '/z']), ['aura'])
})
