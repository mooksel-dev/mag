// search_workspace and read(ref) (unified-search-across-the-workspace.1): every role finds and opens topics, docs,
// decisions and meetings across the workspace, or across all of them when the user asks.
import { chatTranscript, itemOffset, type Project } from '@mag/core'
import { decisionsSection, docSections, parseRef } from './core/lib/search-rows/index.ts'
import { bound, type Meetings } from './core/services/meetings/index.ts'
import { MARK_END, MARK_START, type Search, type SearchKind } from './core/services/search/index.ts'
import { meetingText } from './meeting-tools.ts'
import type { Store } from './store.ts'

/** A page of read, in characters. */
export const READ_PAGE = 40_000
export const SEARCH_KINDS: SearchKind[] = ['topic', 'doc', 'decision', 'meeting', 'deliverable', 'person']
const LIMIT = 30

export interface SearchToolDeps {
  store: Store
  search?: Pick<Search, 'query'>
  meetings?: Pick<Meetings, 'read'>
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : typeof v === 'string' && v.trim() ? [v.trim()] : [])
const day = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

/** The workspace `scope` names (a name or an id, any case); 'all' as is; the caller's when missing. */
function scopeArg(store: Store, v: unknown): string | undefined {
  const s = text(v)
  if (!s || s.toLowerCase() === 'all') return s?.toLowerCase()
  const w = store.data.workspaces.find((x) => x.id === s || x.name.toLowerCase() === s.toLowerCase())
  if (!w) throw new Error(`No workspace "${s}": pass "all" or one of ${store.data.workspaces.map((x) => x.name).join(', ')}`)
  return w.id
}

/** Label names (or ids) as groups of ids within the scope's workspaces: a project's name is its Project label. */
function labelsArg(store: Store, v: unknown, workspaces: string[] | null): string[][] | undefined {
  const names = strings(v)
  if (!names.length) return undefined
  const inScope = (ws: string) => !workspaces || workspaces.includes(ws)
  const groups = new Map(store.data.labelGroups.map((g) => [g.id, g.workspaceId]))
  const all = [...store.data.labels.filter((l) => inScope(groups.get(l.groupId) ?? '')).map((l) => ({ id: l.id, name: l.name })), ...store.data.projects.filter((p) => inScope(p.workspaceId)).map((p) => ({ id: p.id, name: p.name }))]
  return names.map((n) => {
    const ids = [...new Set(all.filter((l) => l.id === n || l.name.toLowerCase() === n.toLowerCase()).map((l) => l.id))]
    if (!ids.length) throw new Error(`No label "${n}" in the scope searched`)
    return ids
  })
}

/** Label ids as names, for the hit lines. */
function labelNames(store: Store) {
  const names = new Map([...store.data.labels.map((l) => [l.id, l.name] as const), ...store.data.projects.map((p) => [p.id, p.name] as const)])
  return (ids: string[]) => ids.map((i) => names.get(i) ?? i)
}

function page(all: string, offset: unknown, base = 0): string {
  const from = base + (typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0)
  const end = from + READ_PAGE
  return `${all.slice(from, end)}\n\n${end < all.length ? `(more: call read with this ref and offset ${end - base})` : '(end)'}`
}

export function searchWorkspace(deps: SearchToolDeps, project: Pick<Project, 'workspaceId'>, args: Record<string, unknown>): string {
  if (!deps.search) throw new Error('Search is not ready yet')
  const query = text(args.query)
  if (!query) throw new Error('Pass query: the words to find')
  const scope = scopeArg(deps.store, args.scope)
  const kinds = strings(args.kinds)
  const bad = kinds.filter((k) => !SEARCH_KINDS.includes(k as SearchKind))
  if (bad.length) throw new Error(`Unknown kind: ${bad.join(', ')}; one of ${SEARCH_KINDS.join(', ')}`)
  const from = text(args.from)
  const to = text(args.to)
  const hits = deps.search.query(query, {
    workspaceId: project.workspaceId,
    scope,
    kinds: kinds.length ? (kinds as SearchKind[]) : undefined,
    labels: labelsArg(deps.store, args.labels, scope === 'all' ? null : [scope ?? project.workspaceId]),
    people: args.people === true,
    from: from ? bound(from, false) : undefined,
    to: to ? bound(to, true) : undefined,
    limit: LIMIT,
  })
  if (!hits.length) return `Nothing matches "${query}"${scope === 'all' ? '' : ' in this workspace (scope: "all" searches every one)'}.`
  const names = labelNames(deps.store)
  const lines = hits.map((h) => `- ${h.ref} · ${h.kind} · ${h.title} · ${day(h.at)} UTC${h.labels.length ? ` · ${names(h.labels).join(', ')}` : ''}: ${h.snippet.replace(/\s+/g, ' ').replaceAll(MARK_START, '**').replaceAll(MARK_END, '**')}`)
  return `${lines.join('\n')}\n\nOpen one with read(ref).`
}

/** A hit opened: a topic from its message, a work, a doc section, a work's decisions, a meeting from its line. */
export function readRef(deps: SearchToolDeps, args: Record<string, unknown>): string {
  const raw = text(args.ref)
  const ref = raw ? parseRef(raw) : null
  if (!ref) throw new Error('Pass ref: a ref from search_workspace, e.g. ws1:topic:ab12cd34#7')
  const { store } = deps
  const task = (id: string) => {
    const t = store.data.tasks.find((x) => x.id === id) ?? store.data.tasks.find((x) => x.key.toLowerCase() === id.toLowerCase())
    if (!t) throw new Error(`No work ${id}`)
    return t
  }
  switch (ref.kind) {
    case 'topic': {
      const s = store.data.sessions.find((x) => x.id === ref.id)
      if (!s) throw new Error(`No topic ${ref.id}`)
      const base = ref.item === undefined ? 0 : itemOffset(s, ref.item)
      const all = chatTranscript(s, store.data.sessions, '', 0, Infinity).text
      return page(all, args.offset, base)
    }
    case 'work': {
      const t = task(ref.id)
      return page(chatTranscript(t, store.data.sessions, store.data.docs[t.parentId ?? t.id] ?? '', 0, Infinity).text, args.offset)
    }
    case 'doc':
    case 'dec': {
      const t = task(ref.id)
      const doc = store.data.docs[t.parentId ?? t.id] ?? ''
      const head = `Work ${t.key}: ${t.title}`
      if (ref.kind === 'dec') return page(`${head}\n\n${decisionsSection(doc) || '(no Decisions section)'}`, args.offset)
      const section = ref.section ? docSections(doc).find((s) => s.slug === ref.section) : undefined
      return page(`${head}${section ? ` (section ${section.heading}; read ${ref.ws ? `${ref.ws}:` : ''}doc:${ref.id} for the whole doc)` : ''}\n\n${section?.text ?? (doc.trim() || '(empty doc)')}`, args.offset)
    }
    case 'mtg': {
      if (!deps.meetings) throw new Error('Meetings are not ready yet')
      const all = meetingText(deps.meetings, ref.id)
      const line = ref.at ? all.indexOf(`[${ref.at}]`) : -1
      return page(all, args.offset, line < 0 ? 0 : line)
    }
    default:
      throw new Error(`${ref.kind === 'dlv' ? 'Deliverables' : 'People'} are not in the index yet`)
  }
}
