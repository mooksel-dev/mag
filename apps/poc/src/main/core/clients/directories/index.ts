// The workspace's directories (who-is-who-people-from.1), read-only: Slack members through a one-shot `claude -p` with
// the user's Slack MCP, Atlassian users through acli, GitHub org members and commit emails through gh and git.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { claudeCode, type AgentAdapter } from '@mag/agents'
import { githubRepo } from '../../lib/github-remote/index.ts'

export { githubRepo }

/** A user as a directory lists them. */
export interface DirUser {
  system: 'slack' | 'atlassian' | 'github'
  /** Slack member id (U123), Atlassian accountId, GitHub login (lower case). */
  handle: string
  name: string
  email?: string
  title?: string
  avatar?: string
  /** A Slack Connect or guest user: a vendor's. */
  external?: boolean
  /** A bot or app user. */
  bot?: boolean
}

export interface Directories {
  /** Members of the Slack the user's Slack MCP reaches, deactivated ones left out. */
  slackUsers(): Promise<DirUser[]>
  /** Assignees and reporters of work items of `jiraKeys` (every project when empty) updated in the last 90 days. */
  atlassianUsers(jiraKeys: string[]): Promise<DirUser[]>
  /** Members of GitHub org `org`, with the name and email their profile shows. */
  githubMembers(org: string): Promise<DirUser[]>
  /** The commit emails of each of `logins` (lower case) in `repos`' history; logins without any are left out. */
  commitEmails(repos: string[], logins: string[]): Promise<Map<string, string[]>>
  /** The GitHub owners of `repos`' origin remotes, each once. */
  githubOwners(repos: string[]): Promise<string[]>
}

/** Runs a command, its stdout; rejects when it fails. */
export type Run = (cmd: string, args: string[], cwd?: string) => Promise<string>

export interface DirectoriesOptions {
  /** Where the Slack run happens; nothing is read from it. */
  cwd: string
  /** The Slack MCP server's id as the CLI names its tools (mcp__<id>__…); null when the user has none. */
  slackServer: () => string | null
  run?: Run
  adapter?: Pick<AgentAdapter, 'start'>
  model?: string
}

/** Read-only tools of the Slack MCP the run may call; everything else is denied. */
export const SLACK_READ_TOOLS = ['slack_search_users', 'slack_read_user_profile', 'slack_search_channels', 'slack_list_channel_members']

/** Days of Jira activity whose people count as the site's users. */
const JIRA_DAYS = 90
const JIRA_LIMIT = 2000
/** Commits whose author GitHub is asked for, per repo: one gh call each. */
const COMMIT_LOOKUPS = 60

export const SLACK_PROMPT = `List every member of this Slack workspace with the Slack tools: page through slack_search_users (broad queries, e.g. each letter a-z, until no new members come) and read a member's profile with slack_read_user_profile when its email or title is missing. Change nothing.
Answer with only a JSON array, no prose and no code fence. One object per member: {"id": "U…", "name": "real name", "email": "…", "title": "…", "avatar": "image URL", "bot": true|false, "external": true|false (a guest or Slack Connect user), "deleted": true|false}. Leave out a field you don't know.`

const exec = promisify(execFile)
const defaultRun: Run = async (cmd, args, cwd) => (await exec(cmd, args, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const email = (v: unknown) => str(v)?.toLowerCase()

/** The members in a Slack run's answer; throws when it is not the JSON array asked for. */
export function parseSlackUsers(text: string): DirUser[] {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error(`Slack: the answer is not JSON: ${body.slice(0, 120)}`)
  }
  if (!Array.isArray(data)) throw new Error('Slack: the answer is not a JSON array')
  const out = new Map<string, DirUser>()
  for (const x of data as Record<string, unknown>[]) {
    const id = str(x?.id)
    const name = str(x?.name)
    if (!id || !/^[UW][A-Z0-9]+$/.test(id) || !name || x.deleted === true) continue
    out.set(id, { system: 'slack', handle: id, name, email: email(x.email), title: str(x.title), avatar: str(x.avatar), external: x.external === true, bot: x.bot === true })
  }
  return [...out.values()]
}

/** The people of acli's work items JSON: each assignee and reporter once, apps left out. */
export function parseJiraUsers(json: string): DirUser[] {
  const out = new Map<string, DirUser>()
  for (const item of JSON.parse(json) as { fields?: Record<string, Record<string, unknown> | null> }[]) {
    for (const u of [item.fields?.assignee, item.fields?.reporter]) {
      const id = str(u?.accountId)
      const name = str(u?.displayName)
      if (!u || !id || !name || out.has(id) || u.accountType === 'app') continue
      const avatars = u.avatarUrls as Record<string, string> | undefined
      out.set(id, { system: 'atlassian', handle: id, name, email: email(u.emailAddress), avatar: avatars?.['48x48'], external: u.accountType === 'customer' })
    }
  }
  return [...out.values()]
}

/** The login of a GitHub noreply address (12345+login@users.noreply.github.com). */
export function noreplyLogin(address: string): string | null {
  const m = /^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i.exec(address.trim())
  return m ? m[1].toLowerCase() : null
}

const MEMBERS_QUERY = `query($org: String!, $cursor: String) { organization(login: $org) { membersWithRole(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { login name email avatarUrl } } } }`

export function createDirectories(opts: DirectoriesOptions): Directories {
  const run = opts.run ?? defaultRun
  const adapter = opts.adapter ?? claudeCode

  const origin = async (repo: string) => githubRepo(await run('git', ['remote', 'get-url', 'origin'], repo).catch(() => ''))

  return {
    async slackUsers() {
      const server = opts.slackServer()
      if (!server) throw new Error('Slack: no Slack MCP server is known; connect Slack in Claude Code, run any agent once, then sync again')
      let text = ''
      let error: string | null = null
      const r = adapter.start(
        {
          cwd: opts.cwd,
          prompt: SLACK_PROMPT,
          model: opts.model ?? 'sonnet',
          allowedTools: SLACK_READ_TOOLS.map((t) => `mcp__${server}__${t}`),
          disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
          readOnly: true,
        },
        (e) => {
          if (e.type === 'message' && !e.parentToolUseId) text = e.text
          else if (e.type === 'error') error = e.message
          else if (e.type === 'turn.done' && !e.ok) error ??= 'the run failed'
        },
      )
      await r.done
      if (error) throw new Error(`Slack: ${error}`)
      return parseSlackUsers(text)
    },

    async atlassianUsers(jiraKeys) {
      const keys = jiraKeys.map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k))
      const jql = `${keys.length ? `project in (${keys.join(', ')}) AND ` : ''}updated >= -${JIRA_DAYS}d`
      return parseJiraUsers(await run('acli', ['jira', 'workitem', 'search', '--jql', jql, '--fields', 'assignee,reporter', '--limit', String(JIRA_LIMIT), '--json']))
    },

    async githubMembers(org) {
      const out: DirUser[] = []
      let cursor: string | null = null
      do {
        const args = ['api', 'graphql', '-f', `query=${MEMBERS_QUERY}`, '-F', `org=${org}`, ...(cursor ? ['-f', `cursor=${cursor}`] : [])]
        const page = JSON.parse(await run('gh', args)) as { data?: { organization?: { membersWithRole: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Record<string, unknown>[] } } | null } }
        const members = page.data?.organization?.membersWithRole
        if (!members) throw new Error(`GitHub: ${org} is not an organization you can see`)
        for (const n of members.nodes) {
          const login = str(n.login)?.toLowerCase()
          if (login) out.push({ system: 'github', handle: login, name: str(n.name) ?? login, email: email(n.email), avatar: str(n.avatarUrl) })
        }
        cursor = members.pageInfo.hasNextPage ? members.pageInfo.endCursor : null
      } while (cursor)
      return out
    },

    async commitEmails(repos, logins) {
      const wanted = new Set(logins.map((l) => l.toLowerCase()))
      const out = new Map<string, string[]>()
      const add = (login: string, address: string) => {
        if (!wanted.has(login)) return
        const list = out.get(login) ?? []
        if (!list.includes(address)) out.set(login, [...list, address])
      }
      if (!wanted.size) return out
      for (const repo of repos) {
        const log = await run('git', ['log', '--all', '--no-merges', '--format=%H%x09%ae', '-n', '20000'], repo).catch(() => '')
        // The newest commit of each address.
        const shaOf = new Map<string, string>()
        for (const line of log.split('\n')) {
          const [sha, raw] = line.split('\t')
          const address = raw?.trim().toLowerCase()
          if (sha && address && !shaOf.has(address)) shaOf.set(address, sha)
        }
        const gh = await origin(repo)
        let lookups = 0
        for (const [address, sha] of shaOf) {
          const login = noreplyLogin(address)
          if (login) {
            add(login, address)
            continue
          }
          if (!gh || lookups >= COMMIT_LOOKUPS) continue
          lookups++
          const author = (await run('gh', ['api', `repos/${gh.owner}/${gh.name}/commits/${sha}`, '--jq', '.author.login // ""']).catch(() => '')).trim().toLowerCase()
          if (author) add(author, address)
        }
      }
      return out
    },

    async githubOwners(repos) {
      const owners = new Set<string>()
      for (const repo of repos) {
        const gh = await origin(repo)
        if (gh) owners.add(gh.owner)
      }
      return [...owners]
    },
  }
}
