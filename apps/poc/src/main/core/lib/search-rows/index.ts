// The rows each kind puts into the search index (unified-search-across-the-workspace.1), and the refs that open them.
// Pure: the app layer reads the sources, these cut them into rows.
import type { AgentSession, ChatItem, ChatSummary, Task } from '@mag/core'

export type SearchKind = 'topic' | 'doc' | 'decision' | 'meeting' | 'deliverable' | 'person'

/** One searchable unit: a message, a doc section, a decision line, a meeting line. `ref` is without the workspace. */
export interface SearchRow {
  ref: string
  kind: SearchKind
  title: string
  text: string
  /** ms. */
  at: number
}

/** What a ref points at; `ws` is the workspace prefix, missing for workspace-wide meetings. */
export type ParsedRef =
  | { ws?: string; kind: 'topic'; id: string; item?: number }
  | { ws?: string; kind: 'work'; id: string }
  | { ws?: string; kind: 'doc'; id: string; section?: string }
  | { ws?: string; kind: 'dec'; id: string; line?: number }
  | { ws?: string; kind: 'mtg'; id: string; at?: string }
  | { ws?: string; kind: 'dlv'; id: string; version?: number }
  | { ws?: string; kind: 'person'; id: string }

const REF = /^(?:([^:\s]+):)?(topic|work|doc|dec|mtg|dlv|person):(.+)$/

/** A ref of a hit, e.g. ws1:topic:ab12cd34#7 or mtg:2026-11-20-1430-sync@00:00:09; null when it is not one. */
export function parseRef(ref: string): ParsedRef | null {
  const m = REF.exec(ref.trim())
  if (!m) return null
  const ws = m[1] || undefined
  const kind = m[2] as ParsedRef['kind']
  const rest = m[3]
  const cut = (sep: string) => {
    const i = rest.indexOf(sep)
    return i < 0 ? [rest, undefined] : [rest.slice(0, i), rest.slice(i + 1) || undefined]
  }
  switch (kind) {
    case 'topic': {
      const [id, n] = cut('#')
      return { ws, kind, id: id!, ...(n !== undefined && /^\d+$/.test(n) && { item: Number(n) }) }
    }
    case 'doc': {
      const [id, section] = cut('#')
      return { ws, kind, id: id!, ...(section && { section }) }
    }
    case 'dec': {
      const [id, n] = cut('#')
      return { ws, kind, id: id!, ...(n !== undefined && /^\d+$/.test(n) && { line: Number(n) }) }
    }
    case 'mtg': {
      const [id, at] = cut('@')
      return { ws, kind, id: id!, ...(at && { at }) }
    }
    case 'dlv': {
      const [id, n] = cut('@')
      return { ws, kind, id: id!, ...(n !== undefined && /^\d+$/.test(n) && { version: Number(n) }) }
    }
    default:
      return { ws, kind, id: rest }
  }
}

/** A row's ref with its workspace: `<ws>:<ref>`; a workspace-wide row (ws '') and one that names its place (a deliverable's folder) keep their own. */
export const withWorkspace = (ws: string, ref: string) => (ws && !parseRef(ref)?.ws ? `${ws}:${ref}` : ref)

/** Indexes of the final assistant reply of each turn: the last reply before the next user message or job. */
export function finalReplies(items: ChatItem[]): Set<number> {
  const out = new Set<number>()
  let last = -1
  items.forEach((i, n) => {
    if (i.kind === 'user' || i.kind === 'job') {
      if (last >= 0) out.add(last)
      last = -1
    } else if (i.kind === 'assistant') last = n
  })
  if (last >= 0) out.add(last)
  return out
}

const summaryText = (s: ChatSummary) => [...s.gist, ...s.decisions, ...s.open, s.keywords.join(', ')].filter(Boolean).join('\n')

/** A topic's rows: its summary, its user messages and the final reply of each turn; not tool calls, jobs or notices. */
export function rowsOfSession(s: Pick<AgentSession, 'id' | 'summary' | 'createdAt' | 'summaryAt'>, items: ChatItem[], title: string): SearchRow[] {
  const rows: SearchRow[] = []
  if (s.summary) rows.push({ ref: `topic:${s.id}`, kind: 'topic', title, text: summaryText(s.summary), at: s.summaryAt ?? s.createdAt })
  const finals = finalReplies(items)
  items.forEach((i, n) => {
    if ((i.kind === 'user' || (i.kind === 'assistant' && finals.has(n))) && i.text.trim()) rows.push({ ref: `topic:${s.id}#${n}`, kind: 'topic', title, text: i.text, at: i.at })
  })
  return rows
}

export interface DocSection {
  /** Unique within the doc: the heading as a slug, -2, -3… for a repeated one; '' for the text before any heading. */
  slug: string
  heading: string
  /** Its heading level; 0 for the text before any heading. */
  level: number
  /** The section with its heading line, up to the next heading of any level. */
  text: string
}

const slugOf = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section'

/** A markdown doc cut at every heading; headings inside code fences are text. */
export function docSections(doc: string): DocSection[] {
  const out: DocSection[] = []
  const used = new Map<string, number>()
  let cur: DocSection = { slug: '', heading: '', level: 0, text: '' }
  let fence = false
  for (const line of doc.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      if (cur.text.trim()) out.push(cur)
      const base = slugOf(h[2])
      const n = (used.get(base) ?? 0) + 1
      used.set(base, n)
      cur = { slug: n > 1 ? `${base}-${n}` : base, heading: h[2], level: h[1].length, text: `${line}\n` }
    } else cur.text += `${line}\n`
  }
  if (cur.text.trim()) out.push(cur)
  return out.map((s) => ({ ...s, text: s.text.trimEnd() }))
}

/** The lines of the doc's §Decisions with its subsections (one per step), each a decision without its bullet. */
export function decisionLines(doc: string): string[] {
  const sections = docSections(doc)
  const start = sections.findIndex((s) => /^decisions\b/i.test(s.heading))
  if (start < 0) return []
  const level = sections[start].level
  const end = sections.findIndex((s, i) => i > start && s.level <= level)
  return sections
    .slice(start, end < 0 ? undefined : end)
    .flatMap((s) => s.text.split('\n').slice(1))
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((l) => l && !/^\(?none\b/i.test(l))
}

/** The §Decisions of the doc with its subsections, as written; '' without one. */
export function decisionsSection(doc: string): string {
  const sections = docSections(doc)
  const start = sections.findIndex((s) => /^decisions\b/i.test(s.heading))
  if (start < 0) return ''
  const end = sections.findIndex((s, i) => i > start && s.level <= sections[start].level)
  return sections
    .slice(start, end < 0 ? undefined : end)
    .map((s) => s.text)
    .join('\n\n')
}

type WorkFields = Pick<Task, 'id' | 'key' | 'title' | 'description' | 'updatedAt'>

/** A work's rows: its title and description, then its doc per section. */
export function rowsOfDoc(work: WorkFields, doc: string): SearchRow[] {
  const title = `${work.key}: ${work.title}`
  const rows: SearchRow[] = [{ ref: `work:${work.id}`, kind: 'doc', title, text: work.description, at: work.updatedAt }]
  for (const s of docSections(doc)) rows.push({ ref: `doc:${work.id}#${s.slug}`, kind: 'doc', title: s.heading ? `${title} › ${s.heading}` : title, text: s.text, at: work.updatedAt })
  return rows
}

/** A work's decisions: one row per line of its §Decisions. */
export function rowsOfDecisions(work: WorkFields, doc: string): SearchRow[] {
  const title = `${work.key}: ${work.title}`
  return decisionLines(doc).map((text, n) => ({ ref: `dec:${work.id}#${n}`, kind: 'decision', title, text, at: work.updatedAt }))
}

/** What the index keeps of a meeting: its title, start, summary.md and transcript.md as they are. */
export interface MeetingSource {
  id: string
  title: string
  startedAt: string
  summary: string
  transcript: string
}

const LINE = /^\[(\d{2}):(\d{2}):(\d{2})\] (\S+: .*)$/

/** A meeting's rows: its summary lines without markup (at its start), then its transcript lines at their time. */
export function rowsOfMeeting(m: MeetingSource): SearchRow[] {
  const start = Date.parse(m.startedAt) || 0
  const summary = m.summary
    .split('\n')
    .map((l) => l.replace(/^#+\s*|^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
  const rows: SearchRow[] = [m.title, ...summary].map((text) => ({ ref: `mtg:${m.id}`, kind: 'meeting', title: m.title, text, at: start }))
  for (const l of m.transcript.split('\n')) {
    const x = LINE.exec(l)
    if (x) rows.push({ ref: `mtg:${m.id}@${x[1]}:${x[2]}:${x[3]}`, kind: 'meeting', title: m.title, text: x[4], at: start + (Number(x[1]) * 3600 + Number(x[2]) * 60 + Number(x[3])) * 1000 })
  }
  return rows
}

/** What the index keeps of a deliverable: its own ref (`<folder>:dlv:<slug>`) and the text of the versions indexed. */
export interface DeliverableSource {
  ref: string
  title: string
  kind: string
  /** As the author named them. */
  labels: string[]
  versions: { n: number; at: number; text: string }[]
}

/** A deliverable's rows: per version, its title line, then its text per section; each opens that version (`@<n>`). */
export function rowsOfDeliverable(d: DeliverableSource): SearchRow[] {
  return d.versions.flatMap((v) => {
    const ref = `${d.ref}@${v.n}`
    const title = `${d.title} · v${v.n}`
    const head: SearchRow = { ref, kind: 'deliverable', title, text: [d.title, d.kind, ...d.labels].join(' · '), at: v.at }
    return [head, ...docSections(v.text).map((s) => ({ ref, kind: 'deliverable' as const, title: s.heading ? `${title} › ${s.heading}` : title, text: s.text, at: v.at }))]
  })
}

/** What the index keeps of a person: what the directories say, and their handles. */
export interface PersonSource {
  id: string
  name: string
  email: string | null
  title: string | null
  handles: { system: string; handle: string; name?: string }[]
  syncedAt: number
}

/** A person's row: name, title, email and every handle. */
export function rowsOfPerson(p: PersonSource): SearchRow[] {
  const handles = p.handles.map((h) => `${h.system} ${h.handle}${h.name && h.name !== p.name ? ` (${h.name})` : ''}`)
  return [{ ref: `person:${p.id}`, kind: 'person', title: p.name, text: [p.name, p.title, p.email, ...handles].filter(Boolean).join('\n'), at: p.syncedAt }]
}

/** FNV-1a of a text: a cheap version of a source. */
export function textHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}
