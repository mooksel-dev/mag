// The ⌘K palette's model (unified-search-across-the-workspace.2): tabs, the source line of a hit, label filters, and
// where opening a hit goes.
import type { Label, LabelGroup, Project, Task, Workspace } from '@mag/core'
import { docSections, parseRef } from '../../main/core/lib/search-rows/index.ts'
import type { Deliverable } from '../../main/core/services/deliverables/types.ts'
import { MARK_END, MARK_START, type Hit, type SearchKind } from '../../main/core/services/search/types.ts'

export type PaletteTab = 'all' | SearchKind

export const PALETTE_TABS: { id: PaletteTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'topic', label: 'Topics' },
  { id: 'doc', label: 'Docs' },
  { id: 'decision', label: 'Decisions' },
  { id: 'meeting', label: 'Meetings' },
  { id: 'deliverable', label: 'Deliverables' },
  { id: 'person', label: 'People' },
]

const KIND_NAMES: Record<SearchKind, string> = { topic: 'Topic', doc: 'Doc', decision: 'Decision', meeting: 'Meeting', deliverable: 'Deliverable', person: 'Person' }

/** A tab's count; at the palette's limit it may have more. */
export const countText = (n: number, limit: number) => (n >= limit ? `${limit}+` : String(n))

/** A snippet cut at its marks: the matched words are `hit`. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []
  for (const [n, part] of snippet.replace(/\s+/g, ' ').split(MARK_START).entries()) {
    const [hit, rest] = n === 0 ? [null, part] : part.includes(MARK_END) ? [part.slice(0, part.indexOf(MARK_END)), part.slice(part.indexOf(MARK_END) + 1)] : [part, '']
    if (hit) out.push({ text: hit, hit: true })
    if (rest) out.push({ text: rest, hit: false })
  }
  return out
}

export interface SourceContext {
  workspaceId: string
  workspaces: Pick<Workspace, 'id' | 'name'>[]
  projects: Pick<Project, 'id' | 'name'>[]
  labels: Pick<Label, 'id' | 'name'>[]
  deliverables: Pick<Deliverable, 'folder' | 'slug' | 'workspaceId'>[]
}

/** The workspace a hit is in; null for a workspace-wide one (a meeting). */
export function hitWorkspace(ref: string, ctx: Pick<SourceContext, 'deliverables'>): string | null {
  const r = parseRef(ref)
  if (!r || r.kind === 'mtg') return null
  if (r.kind === 'dlv') return ctx.deliverables.find((d) => d.folder === r.ws && d.slug === r.id)?.workspaceId ?? null
  return r.ws ?? null
}

/** Where a hit comes from, as its row shows it: its kind, its workspace when it is another one, its labels. */
export function sourceLine(hit: Pick<Hit, 'ref' | 'kind' | 'labels'>, ctx: SourceContext): string {
  const ws = hitWorkspace(hit.ref, ctx)
  const names = new Map([...ctx.projects.map((p) => [p.id, p.name] as const), ...ctx.labels.map((l) => [l.id, l.name] as const)])
  const other = ws && ws !== ctx.workspaceId ? ctx.workspaces.find((w) => w.id === ws)?.name ?? 'another workspace' : null
  return [KIND_NAMES[hit.kind] ?? hit.kind, other, ...hit.labels.flatMap((id) => names.get(id) ?? [])].filter(Boolean).join(' · ')
}

/** The picked labels as the query takes them: one group per label group, any of its labels; every group matched. */
export function labelQuery(picked: string[], groups: { group: Pick<LabelGroup, 'id'>; labels: { id: string }[] }[]): string[][] | undefined {
  const out = groups.map((g) => g.labels.filter((l) => picked.includes(l.id)).map((l) => l.id)).filter((ids) => ids.length)
  return out.length ? out : undefined
}

/** Where opening a hit goes; null when what it points at is gone. */
export type HitTarget =
  | { kind: 'elsewhere'; workspaceId: string }
  | { kind: 'topic'; id: string; item?: number }
  | { kind: 'work'; id: string; section?: string; decisions?: boolean }
  | { kind: 'meeting'; id: string; at?: string }
  | { kind: 'deliverable'; id: string; version?: number; topicId: string | null }
  | { kind: 'person'; id: string; name: string }

export interface TargetContext {
  workspaceId: string
  sessions: { id: string; taskId: string | null }[]
  tasks: Pick<Task, 'id' | 'parentId'>[]
  deliverables: Pick<Deliverable, 'id' | 'folder' | 'slug' | 'workspaceId' | 'topicId'>[]
}

/** What a hit opens in this window: a topic at its message, a work at its doc section, a meeting at its line… */
export function hitTarget(ref: string, title: string, ctx: TargetContext): HitTarget | null {
  const r = parseRef(ref)
  if (!r) return null
  const ws = hitWorkspace(ref, ctx)
  if (ws && ws !== ctx.workspaceId) return { kind: 'elsewhere', workspaceId: ws }
  const work = (id: string) => {
    const t = ctx.tasks.find((x) => x.id === id)
    return t ? t.parentId ?? t.id : null
  }
  switch (r.kind) {
    case 'topic': {
      const s = ctx.sessions.find((x) => x.id === r.id)
      if (!s) return null
      // A work's agent: its work opens; the message is in that agent's log.
      if (s.taskId) {
        const id = work(s.taskId)
        return id ? { kind: 'work', id } : null
      }
      return { kind: 'topic', id: s.id, ...(r.item !== undefined && { item: r.item }) }
    }
    case 'work':
    case 'doc':
    case 'dec': {
      const id = work(r.id)
      if (!id) return null
      return { kind: 'work', id, ...(r.kind === 'doc' && r.section && { section: r.section }), ...(r.kind === 'dec' && { decisions: true }) }
    }
    case 'mtg':
      return { kind: 'meeting', id: r.id, ...(r.at && { at: r.at }) }
    case 'dlv': {
      const d = ctx.deliverables.find((x) => x.folder === r.ws && x.slug === r.id)
      return d ? { kind: 'deliverable', id: d.id, topicId: d.topicId, ...(r.version !== undefined && { version: r.version }) } : null
    }
    case 'person':
      return { kind: 'person', id: r.id, name: title }
  }
}

/** Which heading of the rendered doc a section is (its slug, or the §Decisions); -1 when there is none. */
export function headingIndex(doc: string, section?: string, decisions?: boolean): number {
  const headed = docSections(doc).filter((s) => s.level > 0)
  return headed.findIndex((s) => (section ? s.slug === section : !!decisions && /^decisions\b/i.test(s.heading)))
}
