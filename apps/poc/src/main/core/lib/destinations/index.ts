import { DESTINATION_LABELS as KIND_LABELS, readsOnly, type Destination, type DestinationKind, type PublishSettings } from '@mag/core'
import { flag, segments, words } from './shell.ts'

/**
 * Where an outbound write goes (publish-gate-for-every-outbound.1): which tool calls speak for the user on Slack, Jira,
 * Confluence, GitHub or Google Docs, from an MCP tool's name or a known CLI command. Pure: no runtime.
 */

/** Input keys that name the target, per kind, in the order tried. */
const TARGET_KEYS: Record<DestinationKind, string[]> = {
  slack: ['channel_id', 'channelId', 'channel', 'channel_name', 'user_id'],
  jira: ['issueIdOrKey', 'issueKey', 'issue_key', 'key', 'issue', 'projectKey', 'project_key', 'project'],
  confluence: ['pageId', 'page_id', 'spaceKey', 'spaceId', 'space_key', 'space', 'parentId'],
  github: [],
  gdocs: ['documentId', 'document_id', 'docId', 'fileId', 'file_id'],
  other: [],
}

const destination = (kind: DestinationKind, target: string, label?: string): Destination => ({
  kind,
  target,
  label: label ?? (target ? `${KIND_LABELS[kind]} ${kind === 'slack' && !target.startsWith('#') && !/^[CDGU][A-Z0-9]{6,}$/.test(target) ? `#${target}` : target}` : KIND_LABELS[kind]),
})

/** The kind of an MCP write by its server's and tool's names. */
function mcpKind(tool: string, server: string): DestinationKind {
  const name = `${server} ${tool}`.toLowerCase()
  if (name.includes('slack')) return 'slack'
  if (name.includes('confluence')) return 'confluence'
  if (name.includes('jira')) return 'jira'
  if (/gdocs|gdrive|google.?(docs?|drive)/.test(name)) return 'gdocs'
  if (name.includes('github')) return 'github'
  if (name.includes('atlassian')) return /page|space|footnote/i.test(tool) ? 'confluence' : 'jira'
  return 'other'
}

function mcpTarget(kind: DestinationKind, input: Record<string, unknown>): string {
  if (kind === 'github') {
    const repo = typeof input.owner === 'string' && typeof input.repo === 'string' ? `${input.owner}/${input.repo}` : ''
    const n = input.pull_number ?? input.issue_number ?? input.pullNumber ?? input.issueNumber
    return repo && (typeof n === 'number' || typeof n === 'string') ? `${repo}#${n}` : repo
  }
  for (const key of TARGET_KEYS[kind]) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

const GH_PR_WRITES = ['review', 'comment', 'close', 'edit', 'ready', 'reopen']
const GH_ISSUE_WRITES = ['create', 'comment', 'close', 'edit', 'reopen', 'delete']
const GH_RELEASE_WRITES = ['create', 'edit', 'delete', 'upload']
const GH_API_WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input']

/** gh's options before its subcommand that take a value. */
const GH_VALUE_OPTIONS = ['-R', '--repo', '--hostname']

function ghWrite(args: string[]): Destination | null {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) i += GH_VALUE_OPTIONS.includes(args[i]) ? 2 : 1
  const [sub, action, ...rest] = args.slice(i)
  const repo = flag(args, '-R', '--repo') ?? ''
  const numbered = (n: string | undefined) => {
    const url = n && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(n)
    return url ? `${url[1]}#${url[2]}` : n && /^\d+$/.test(n) ? `${repo}#${n}` : repo
  }
  if (sub === 'pr' && GH_PR_WRITES.includes(action)) return destination('github', numbered(rest.find((a) => !a.startsWith('-'))))
  if (sub === 'issue' && GH_ISSUE_WRITES.includes(action)) return destination('github', numbered(action === 'create' ? undefined : rest.find((a) => !a.startsWith('-'))))
  if (sub === 'release' && GH_RELEASE_WRITES.includes(action)) return destination('github', repo)
  if (sub === 'api') {
    const apiArgs = [action, ...rest].filter((a) => a !== undefined)
    const method = flag(apiArgs, '-X', '--method')?.toUpperCase()
    // A GraphQL query reads; a mutation, or one read from a file, may write.
    if (apiArgs[0] === 'graphql' && !method) return apiArgs.some((a) => /\bmutation\b|=@/.test(a)) ? destination('github', '') : null
    const writes = method ? method !== 'GET' && method !== 'HEAD' : apiArgs.some((a) => GH_API_WRITE_FLAGS.includes(a) || GH_API_WRITE_FLAGS.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)))
    if (!writes) return null
    const path = apiArgs.find((a) => /^\/?repos\//.test(a))
    const m = path && /^\/?repos\/([^/]+\/[^/?]+)(?:\/(?:pulls|issues)\/(\d+))?/.exec(path)
    return destination('github', m ? (m[2] ? `${m[1]}#${m[2]}` : m[1]) : '')
  }
  return null
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/

function acliWrite(args: string[]): Destination | null {
  const product = args[0]
  if (product !== 'jira' && product !== 'confluence') return null
  const firstOption = args.findIndex((a) => a.startsWith('-'))
  const names = args.slice(1, firstOption < 0 ? undefined : firstOption).filter((a) => /^[a-z][a-z-]*$/.test(a))
  if (!names.length || names.includes('auth') || readsOnly(names.join('_'))) return null
  if (product === 'jira') return destination('jira', flag(args, '--key', '-k') ?? args.find((a) => JIRA_KEY.test(a)) ?? flag(args, '--project') ?? '')
  return destination('confluence', flag(args, '--id', '--page-id') ?? flag(args, '--space', '--space-key') ?? '')
}

/** A Bash command's write to a destination: gh's PR, issue, release and api writes, acli's Jira and Confluence ones. */
function commandWrite(command: string): Destination | null {
  for (const segment of segments(command)) {
    const ws = words(segment)
    while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0])) ws.shift()
    const [cli, ...args] = ws
    const found = cli === 'gh' ? ghWrite(args) : cli === 'acli' ? acliWrite(args) : null
    if (found) return found
  }
  return null
}

/**
 * The destination a tool call writes to, or null for a read (and for what speaks for nobody: an edit, a push of a
 * branch). `tool`: the bare tool name of an MCP integration (with `server`, its name) or Claude Code's ("Bash"). An
 * integration's tool that does not only read is a write: an unknown one is "other".
 */
export function classify(tool: string, server: string | undefined, input: unknown): Destination | null {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (!server) return tool === 'Bash' && typeof fields.command === 'string' ? commandWrite(fields.command) : null
  if (readsOnly(tool)) return null
  const kind = mcpKind(tool, server)
  if (kind === 'other') return destination('other', server, `${server} · ${tool}`)
  return destination(kind, mcpTarget(kind, fields))
}

/** Kinds by the words an agent may name them with: "slack", "Jira", "Google Docs", "gh"… */
const KIND_WORDS: [RegExp, DestinationKind][] = [
  [/^slack\b/i, 'slack'],
  [/^jira\b/i, 'jira'],
  [/^confluence\b/i, 'confluence'],
  [/^(github|gh)\b/i, 'github'],
  [/^(google[ -]?docs?|gdocs?)\b/i, 'gdocs'],
]

/**
 * A destination as the agent names it for publish ("Slack #general", "jira ABC-12", "GitHub o/r#4"): a known kind's
 * word first, the rest its target; anything else is "other" with the whole text as its target.
 */
export function declared(text: string): Destination {
  const t = text.trim().replace(/\s+/g, ' ')
  for (const [re, kind] of KIND_WORDS) {
    const m = re.exec(t)
    if (m) return destination(kind, t.slice(m[0].length).replace(/^[\s:·-]+/, ''))
  }
  return destination('other', t, t || KIND_LABELS.other)
}

/** A Bash rule from the command's start, and the same after leading options (`gh -R o/r issue comment`). */
const prefixRules = (cli: string, sub: string) => [`Bash(${cli} ${sub}:*)`, `Bash(${cli} * ${sub} *)`]

/**
 * Bash ask rules for the known CLI writes that GitHub's PR and api rules don't cover: every acli Jira and Confluence
 * call (classify lets its reads run) and gh's issue and release writes. They reach the permission prompt tool.
 */
export function cliWriteRules(): string[] {
  return [
    ...['jira', 'confluence'].flatMap((product) => prefixRules('acli', product)),
    ...GH_ISSUE_WRITES.flatMap((a) => prefixRules('gh', `issue ${a}`)),
    ...GH_RELEASE_WRITES.flatMap((a) => prefixRules('gh', `release ${a}`)),
  ]
}

const normalTarget = (t: string) => t.trim().replace(/^#/, '').toLowerCase()

/** Whether the project publishes to `d` without asking: a pattern of its kind with no target, or with its target. */
export function isAuto(d: Destination, settings: PublishSettings | undefined): boolean {
  return (settings?.auto ?? []).some((p) => p.kind === d.kind && (!p.target?.trim() || (!!d.target && normalTarget(p.target) === normalTarget(d.target))))
}

export { check, payload, preview, type DestinationRule, type Payload } from './contracts.ts'
