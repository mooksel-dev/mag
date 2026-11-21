import { marked } from 'marked'
import type { Destination, DestinationKind } from '@mag/core'
import { flag, segments, words } from './shell.ts'

/**
 * What a write publishes, how its destination will show it and the destination's rules it meets
 * (publish-gate-for-every-outbound.2). Pure: the caller sanitizes the HTML before it shows it.
 */

/** The text a write publishes; `file` when its body comes from a file that can't be read here. */
export interface Payload {
  title?: string
  body?: string
  file?: string
}

/** One rule of a destination; `met` false when the payload breaks it, absent when it can't be checked. */
export interface DestinationRule {
  id: 'final' | 'header-spacing' | 'mentions' | 'limit'
  text: string
  met?: boolean
}

const BODY_KEYS = ['text', 'message', 'markdown_text', 'body', 'commentBody', 'comment', 'content', 'description', 'markdown']
const TITLE_KEYS = ['title', 'summary', 'subject']

const firstString = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string
  return undefined
}

/** `$(cat <<'EOF' … EOF)`: a heredoc in a command substitution; its text may hold quotes the words can't parse. */
const CAT_HEREDOC = /\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*\)/g
const HEREDOC_WORD = /^\u0000heredoc(\d+)\u0000$/
/** `$(cat path)`: a file. */
const CAT_FILE = /^\$\(\s*cat\s+([^\s)<]+)\s*\)$/

/** A flag's text, with a heredoc (taken out of the command as `docs`) or a file resolved. */
function text(value: string | undefined, docs: string[]): Pick<Payload, 'body' | 'file'> {
  if (value === undefined) return {}
  const doc = HEREDOC_WORD.exec(value)
  if (doc) return { body: docs[Number(doc[1])] }
  const file = CAT_FILE.exec(value)
  return file ? { file: file[1] } : { body: value }
}

/** The body a command reads from stdin (`--body-file -`): its heredoc's text. */
function stdinHeredoc(command: string): string | undefined {
  return /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\2(?:\n|$)/.exec(command)?.[3]
}

function bodyFile(command: string, path: string | undefined): Pick<Payload, 'body' | 'file'> {
  if (path === undefined) return {}
  if (path !== '-') return { file: path }
  const body = stdinHeredoc(command)
  return body === undefined ? { file: 'stdin' } : { body }
}

/** `gh api`'s `-f key=value` fields. */
function apiFields(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const long = /^--(?:raw-)?field=(.*)$/s.exec(a)
    const value = long ? long[1] : ['-f', '-F', '--field', '--raw-field'].includes(a) ? args[++i] : undefined
    const eq = value?.indexOf('=') ?? -1
    if (value && eq > 0) out[value.slice(0, eq)] = value.slice(eq + 1)
  }
  return out
}

/** gh's options before its subcommand that take a value. */
const GH_VALUE_OPTIONS = ['-R', '--repo', '--hostname']

function commandPayload(command: string): Payload | null {
  const docs: string[] = []
  const line = command.replace(CAT_HEREDOC, (...m) => `\u0000heredoc${docs.push(m[3]) - 1}\u0000`)
  for (const segment of segments(line)) {
    const ws = words(segment)
    while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0])) ws.shift()
    const [cli, ...args] = ws
    if (cli === 'gh') {
      let i = 0
      while (i < args.length && args[i].startsWith('-')) i += GH_VALUE_OPTIONS.includes(args[i]) ? 2 : 1
      if (args[i] === 'api') {
        const fields = apiFields(args)
        const body = fields.body?.startsWith('@') ? { file: fields.body.slice(1) } : text(fields.body, docs)
        return { ...(fields.title !== undefined && { title: fields.title }), ...body }
      }
      const title = flag(args, '-t', '--title')
      return { ...(title !== undefined && { title }), ...text(flag(args, '-b', '--body'), docs), ...bodyFile(command, flag(args, '-F', '--body-file')) }
    }
    if (cli === 'acli') {
      const title = flag(args, '--summary', '--title')
      return { ...(title !== undefined && { title }), ...text(flag(args, '--body', '--comment', '--description'), docs), ...bodyFile(command, flag(args, '--body-file', '--from-file')) }
    }
  }
  return null
}

/** What a write publishes, from a Bash command (gh, acli) or an MCP tool's input; null when it carries no text (a close, a transition). */
export function payload(input: unknown): Payload | null {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  // A Bash call's command, else an MCP tool's text fields.
  const found = (typeof fields.command === 'string' && commandPayload(fields.command)) || { title: firstString(fields, TITLE_KEYS), body: firstString(fields, BODY_KEYS) }
  const p: Payload = {}
  if (found.title) p.title = found.title
  if (found.body) p.body = found.body
  if (found.file) p.file = found.file
  return p.title || p.body || p.file ? p : null
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Pieces of `s` outside code (```…``` and `…`) go through `f`; code is escaped and kept. */
function outsideCode(s: string, f: (t: string) => string, block: (t: string) => string, inline: (t: string) => string): string {
  return s.split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => (i % 2 ? (part.startsWith('```') ? block(part.slice(3, -3).replace(/^\n/, '')) : inline(part.slice(1, -1))) : f(part))).join('')
}

const pre = (t: string) => `<pre><code>${esc(t)}</code></pre>`
const code = (t: string) => `<code>${esc(t)}</code>`

/** Inline markup: `tokens` (links, mentions) become finished HTML first, so emphasis never reaches inside them. */
function inlineHtml(t: string, tokens: [RegExp, (...m: string[]) => string][]): string {
  const kept: string[] = []
  let html = esc(t)
  for (const [re, f] of tokens) html = html.replace(re, (...m) => `\u0000${kept.push(f(...(m as string[]))) - 1}\u0000`)
  return html
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<b>$2</b>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w~])~([^~\n]+)~(?!\w)/g, '$1<s>$2</s>')
    .replace(/\u0000(\d+)\u0000/g, (_, n) => kept[Number(n)])
}

const mention = (text: string) => `<span class="mention">${text}</span>`

const SLACK_TOKENS: [RegExp, (...m: string[]) => string][] = [
  [/&lt;(https?:[^|\s]+?)\|(.+?)&gt;/g, (_, url, label) => `<a href="${url}">${label}</a>`],
  [/&lt;(https?:\S+?)&gt;/g, (_, url) => `<a href="${url}">${url}</a>`],
  [/&lt;@([A-Z0-9]+)(?:\|(.+?))?&gt;/g, (_, id, name) => mention(`@${name ?? id}`)],
  [/&lt;#([A-Z0-9]+)(?:\|(.*?))?&gt;/g, (_, id, name) => mention(`#${name || id}`)],
  [/&lt;!(here|channel|everyone)(?:\|.*?)?&gt;/g, (_, who) => mention(`@${who}`)],
]

/** Slack's mrkdwn: *bold*, _italic_, ~strike~, <url|text>, <@user>, <#channel|name>, > quotes. A Markdown heading shows as typed. */
function slackHtml(s: string): string {
  const lines = (t: string) =>
    t
      .split('\n')
      .map((l) => (l.startsWith('>') ? `<blockquote>${inlineHtml(l.replace(/^>\s?/, ''), SLACK_TOKENS)}</blockquote>` : inlineHtml(l, SLACK_TOKENS)))
      .join('<br>')
      .replace(/<\/blockquote><br>/g, '</blockquote>')
  return `<div class="slack">${outsideCode(s, lines, pre, code)}</div>`
}

/** A {code} or {noformat} block; not the {{monospace}} of a word. */
const WIKI_BLOCK = /(?<!\{)\{(code|noformat)(?::[^}]*)?\}(?!\})\n?([\s\S]*?)\n?\{\1\}/g

const isWiki = (s: string) => /^h[1-6]\.\s|(?<!\{)\{(code|noformat)(:[^}]*)?\}(?!\})|\[[^\]|]+\|https?:|\[~[^\]]+\]/m.test(s)

const WIKI_TOKENS: [RegExp, (...m: string[]) => string][] = [
  [/\{\{(.+?)\}\}/g, (_, t) => `<code>${t}</code>`],
  [/\[([^\]|]+)\|(https?:[^\]]+)\]/g, (_, label, url) => `<a href="${url}">${label}</a>`],
  [/\[~([^\]]+)\]/g, (_, who) => mention(`@${who.replace(/^accountid:/, '')}`)],
]

/** Jira's wiki markup: h1.–h6., *bold*, _italic_, {{mono}}, {code}, [text|url], [~user], * and # lists. */
function wikiHtml(s: string): string {
  const blocks: string[] = []
  const rest = s.replace(WIKI_BLOCK, (_, __, body: string) => `\n\u0001${blocks.push(pre(body)) - 1}\n`)
  return rest
    .split('\n')
    .map((l) => {
      const block = /^\u0001(\d+)$/.exec(l)
      if (block) return blocks[Number(block[1])]
      const h = /^h([1-6])\.\s+(.*)$/.exec(l)
      if (h) return `<h${h[1]}>${inlineHtml(h[2], WIKI_TOKENS)}</h${h[1]}>`
      const li = /^[*#-]+\s+(.*)$/.exec(l)
      if (li) return `<div class="li">• ${inlineHtml(li[1], WIKI_TOKENS)}</div>`
      return l.trim() ? `<p>${inlineHtml(l, WIKI_TOKENS)}</p>` : ''
    })
    .join('')
}

const markdownHtml = (s: string, breaks: boolean) => marked.parse(s, { async: false, gfm: true, breaks }) as string

function bodyHtml(kind: DestinationKind, body: string): string {
  if (kind === 'slack') return slackHtml(body)
  if (kind === 'jira' && isWiki(body)) return wikiHtml(body)
  // GitHub's comments break lines where the text does.
  return markdownHtml(body, kind === 'github')
}

/**
 * The write as its destination will show it, as HTML (unsanitized): Slack mrkdwn, Jira wiki markup or Markdown,
 * GitHub-flavoured Markdown, Markdown for the rest. Null when the write carries no text.
 */
export function preview(destination: Destination, input: unknown): string | null {
  const p = payload(input)
  if (!p) return null
  return [
    p.title && `<div class="pubtitle">${esc(p.title)}</div>`,
    p.body && bodyHtml(destination.kind, p.body),
    p.file && `<p class="muted">The text comes from <code>${esc(p.file)}</code>: mag can't show it.</p>`,
  ].filter(Boolean).join('')
}

/** What the text says outside code, where a mention or a header means something. */
const prose = (s: string) => s.replace(/```[\s\S]*?```/g, '\n').replace(WIKI_BLOCK, '\n').replace(/`[^`\n]+`|\{\{.+?\}\}/g, ' ')

/** A line that stands as a header: a Markdown or Jira heading, or a whole line in bold. */
const HEADER = /^(#{1,6}\s+\S|h[1-6]\.\s+\S|\*{1,2}[^*]+\*{1,2}:?$|_\*[^*]+\*_$)/

/** The headers that follow a text line with no blank line between: Slack and Markdown run them into the text above. */
export function cramped(body: string): string[] {
  const lines = prose(body).split('\n').map((l) => l.trim())
  return lines.filter((l, i) => i > 0 && HEADER.test(l) && lines[i - 1] !== '')
}

/** Plain @names: a mention only GitHub resolves; Slack wants <@U…>, Jira [~accountid:…]. */
export function plainMentions(body: string): string[] {
  const names = [...prose(body).matchAll(/(?:^|[\s(])@([A-Za-z0-9][\w.-]*[\w])/g)].map((m) => m[1])
  return [...new Set(names)]
}

/** Characters a destination accepts in one write. */
const LIMITS: Partial<Record<DestinationKind, number>> = { slack: 40_000, jira: 32_767, github: 65_536 }

/** Whether a write can't be changed after it goes out. */
const FINAL: Partial<Record<DestinationKind, boolean>> = { slack: true }

/**
 * The destination's rules for this write, each met or broken: Slack's can't be edited after; with the text known, a
 * blank line before each header, mentions that resolve (Slack, Jira, Confluence) or who a GitHub mention notifies, and
 * the destination's length limit.
 */
export function check(destination: Destination, input: unknown): DestinationRule[] {
  const kind = destination.kind
  const rules: DestinationRule[] = []
  if (FINAL[kind]) rules.push({ id: 'final', text: "can't be edited after" })
  const body = payload(input)?.body
  if (body === undefined) return rules
  const crampedHeaders = cramped(body)
  rules.push({ id: 'header-spacing', text: crampedHeaders.length ? `no blank line before ${crampedHeaders.map((h) => `"${h}"`).join(', ')}` : 'a blank line before each header', met: !crampedHeaders.length })
  const mentions = plainMentions(body)
  if (kind === 'github') {
    if (mentions.length) rules.push({ id: 'mentions', text: `notifies ${mentions.map((m) => `@${m}`).join(', ')}` })
  } else if (kind === 'slack' || kind === 'jira' || kind === 'confluence') {
    rules.push({ id: 'mentions', text: mentions.length ? `unresolved ${mentions.map((m) => `@${m}`).join(', ')}` : 'mentions resolve', met: !mentions.length })
  }
  const limit = LIMITS[kind]
  if (limit) rules.push({ id: 'limit', text: body.length > limit ? `${body.length.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} characters` : `under ${limit.toLocaleString('en-US')} characters`, met: body.length <= limit })
  return rules
}
