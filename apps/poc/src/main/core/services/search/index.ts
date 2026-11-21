// Search across the workspace (unified-search-across-the-workspace.1): one index of topics, docs, decisions and
// meetings, fed by the app layer from each source's changes; queries scoped by workspace, labels and kinds, with rows
// about people and the Personal workspace left out unless asked.
import type { IndexRow, MatchRow, SearchIndex, Sensitivity } from '../../clients/search-index/index.ts'
import { ftsQuery } from '../../clients/search-index/index.ts'
import { withWorkspace, type SearchKind, type SearchRow } from '../../lib/search-rows/index.ts'
import type { Hit, QueryOptions } from './types.ts'

export type * from './types.ts'
export { MARK_END, MARK_START } from '../../clients/search-index/index.ts'

/** One indexed source (a session, a work's doc, its decisions, a meeting) at a version; rows are built only when needed. */
export interface IndexDoc {
  /** e.g. session:<id>, doc:<taskId>, dec:<taskId>, mtg:<id>. */
  source: string
  /** Changes whenever its rows would: a source indexed at this version is skipped. */
  version: string
  /** '' for workspace-wide sources (meetings). */
  workspaceId: string
  labels: string[]
  sensitivity: Sensitivity
  rows(): SearchRow[]
}

export interface Search {
  /** Indexes the docs whose version changed; returns how many it wrote. */
  upsert(docs: IndexDoc[]): number
  remove(source: string): void
  /** One hit per source, best first; [] for a query without words. */
  query(q: string, opts: QueryOptions): Hit[]
  /**
   * Brings the sources whose names start with one of `prefixes` to exactly `all`: changed ones written, missing ones
   * dropped. It yields between sources, so a full backfill does not hold the app up; a source that fails is skipped.
   */
  rebuild(all: IndexDoc[], prefixes: string[]): Promise<{ updated: number; removed: number }>
}

export const HALF_LIFE_DAYS = 90
const DAY = 86_400_000
const DEFAULT_LIMIT = 30
/** Rows ranked before grouping per source: enough for the limit after the recency decay reorders them. */
const CANDIDATES = 1000

/** A row's score: bm25 (negative, lower is better) shrunk toward 0 by its age, halved every HALF_LIFE_DAYS. */
export function score(rank: number, at: number, now: number): number {
  const days = Math.max(0, now - at) / DAY
  return rank * 0.5 ** (days / HALF_LIFE_DAYS)
}

export function createSearch(deps: { index: SearchIndex; onError?: (message: string, e: unknown) => void }): Search {
  const { index } = deps
  const write = (d: IndexDoc) => {
    const rows: IndexRow[] = d.rows().map((r) => ({ ...r, ref: withWorkspace(d.workspaceId, r.ref), workspaceId: d.workspaceId, labels: d.labels, sensitivity: d.sensitivity }))
    index.put(d.source, d.version, rows)
  }
  return {
    upsert(docs) {
      const versions = index.versions()
      const changed = docs.filter((d) => versions.get(d.source) !== d.version)
      for (const d of changed) write(d)
      return changed.length
    },
    remove: (source) => index.drop(source),
    query(q, o) {
      const now = o.now ?? Date.now()
      const all = o.scope === 'all'
      const exclude: Sensitivity[] = o.people ? [] : all ? ['people', 'personal'] : ['people']
      const rows = index.match(ftsQuery(q), {
        workspaceIds: all ? undefined : [o.scope || o.workspaceId],
        kinds: o.kinds,
        labels: o.labels,
        exclude,
        sources: o.sources,
        from: o.from,
        to: o.to,
        limit: CANDIDATES,
      })
      const best = new Map<string, { row: MatchRow; score: number }>()
      for (const row of rows) {
        const s = score(row.rank, row.at, now)
        const was = best.get(row.source)
        if (!was || s < was.score) best.set(row.source, { row, score: s })
      }
      return [...best.values()]
        .sort((a, b) => a.score - b.score)
        .slice(0, o.limit ?? DEFAULT_LIMIT)
        .map(({ row: r }) => ({ ref: r.ref, kind: r.kind as SearchKind, title: r.title, snippet: r.snippet, at: r.at, labels: r.labels }))
    },
    async rebuild(docs, prefixes) {
      const versions = index.versions()
      let updated = 0
      for (const d of docs) {
        if (versions.get(d.source) === d.version) continue
        try {
          write(d)
          updated++
        } catch (e) {
          // Gone while the rebuild yielded, or unreadable: the next rebuild tries it again.
          deps.onError?.(`Indexing ${d.source} failed: ${(e as Error).message}`, e)
        }
        await new Promise((r) => setImmediate(r))
      }
      const there = new Set(docs.map((d) => d.source))
      const gone = [...versions.keys()].filter((s) => prefixes.some((p) => s.startsWith(p)) && !there.has(s))
      for (const s of gone) index.drop(s)
      return { updated, removed: gone.length }
    },
  }
}
