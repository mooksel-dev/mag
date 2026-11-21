// Full-text search over the workspace (unified-search-across-the-workspace.1): SQLite FTS5 (node:sqlite) in one
// .index.sqlite, the rows of every indexed source and the version of each source it holds. Derived only: safe to
// delete, built again from the sources.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MARK_END, MARK_START, type IndexRow, type MatchRow, type MatchWhere } from './types.ts'

export type * from './types.ts'
export { MARK_END, MARK_START } from './types.ts'

export interface SearchIndex {
  /** Replaces the source's rows and records its version. */
  put(source: string, version: string, rows: IndexRow[]): void
  drop(source: string): void
  /** Source → the version it is indexed at. */
  versions(): Map<string, string>
  /** Rows matching the FTS5 query `fts` (see ftsQuery), best bm25 first; [] for an empty one. */
  match(fts: string, where?: MatchWhere): MatchRow[]
  close(): void
}

/** Marks around the matched words in a snippet. */
const DEFAULT_LIMIT = 50
/** A change of the tables: an index of another schema is dropped and built again. */
const SCHEMA = 1
const COLUMNS = ['ref', 'source', 'kind', 'workspaceId', 'labels', 'sensitivity', 'at', 'title', 'text'] as const
/** bm25 weights per column: only title and text are indexed; the title counts ×3. */
const WEIGHTS = COLUMNS.map((c) => (c === 'title' ? 3 : c === 'text' ? 1 : 0)).join(', ')

/** The user's words as an FTS5 query: each a quoted prefix, all required; operators and punctuation are plain text. */
export function ftsQuery(q: string): string {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return words.map((w) => `"${w}"*`).join(' ')
}

const list = (n: number) => Array.from({ length: n }, () => '?').join(',')
const spaced = (labels: string[]) => (labels.length ? ` ${labels.join(' ')} ` : '')

/** `path`: read on every call, so a changed root gets its own index. */
export function createSearchIndex(path: () => string): SearchIndex {
  let open: { path: string; db: DatabaseSync } | null = null
  const db = () => {
    const p = path()
    if (open?.path === p) return open.db
    open?.db.close()
    mkdirSync(dirname(p), { recursive: true })
    const d = new DatabaseSync(p)
    const version = Number((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version !== SCHEMA) {
      // meetings_*: the meetings-only index this one replaces.
      d.exec('DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_indexed; DROP TABLE IF EXISTS meetings_fts; DROP TABLE IF EXISTS meetings_indexed')
      d.exec(`PRAGMA user_version = ${SCHEMA}`)
    }
    d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(${COLUMNS.map((c) => (c === 'title' || c === 'text' ? c : `${c} UNINDEXED`)).join(', ')}, tokenize = 'unicode61 remove_diacritics 2')`)
    d.exec('CREATE TABLE IF NOT EXISTS search_indexed (source TEXT PRIMARY KEY, version TEXT NOT NULL)')
    open = { path: p, db: d }
    return d
  }
  const inTransaction = (f: (d: DatabaseSync) => void) => {
    const d = db()
    d.exec('BEGIN')
    try {
      f(d)
      d.exec('COMMIT')
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
  }
  return {
    put: (source, version, rows) =>
      inTransaction((d) => {
        d.prepare('DELETE FROM search_fts WHERE source = ?').run(source)
        const insert = d.prepare(`INSERT INTO search_fts (${COLUMNS.join(', ')}) VALUES (${list(COLUMNS.length)})`)
        for (const r of rows) insert.run(r.ref, source, r.kind, r.workspaceId, spaced(r.labels), r.sensitivity, r.at, r.title, r.text)
        d.prepare('INSERT INTO search_indexed (source, version) VALUES (?, ?) ON CONFLICT (source) DO UPDATE SET version = excluded.version').run(source, version)
      }),
    drop: (source) =>
      inTransaction((d) => {
        d.prepare('DELETE FROM search_fts WHERE source = ?').run(source)
        d.prepare('DELETE FROM search_indexed WHERE source = ?').run(source)
      }),
    versions: () => new Map((db().prepare('SELECT source, version FROM search_indexed').all() as { source: string; version: string }[]).map((r) => [r.source, String(r.version)])),
    match(fts, w = {}) {
      if (!fts || [w.workspaceIds, w.kinds, w.sources, ...(w.labels ?? [])].some((x) => x?.length === 0)) return []
      const where = ['search_fts MATCH ?']
      const params: (string | number)[] = [fts]
      if (w.workspaceIds) (where.push(`workspaceId IN (${list(w.workspaceIds.length + 1)})`), params.push('', ...w.workspaceIds))
      if (w.kinds) (where.push(`kind IN (${list(w.kinds.length)})`), params.push(...w.kinds))
      if (w.sources) (where.push(`source IN (${list(w.sources.length)})`), params.push(...w.sources))
      if (w.exclude?.length) (where.push(`sensitivity NOT IN (${list(w.exclude.length)})`), params.push(...w.exclude))
      for (const group of w.labels ?? []) (where.push(`(${group.map(() => 'instr(labels, ?) > 0').join(' OR ')})`), params.push(...group.map((l) => ` ${l} `)))
      if (w.from !== undefined) (where.push('at >= ?'), params.push(w.from))
      if (w.to !== undefined) (where.push('at <= ?'), params.push(w.to))
      const sql = `SELECT ref, source, kind, workspaceId, labels, at, title, snippet(search_fts, -1, '${MARK_START}', '${MARK_END}', '…', 16) AS snippet, bm25(search_fts, ${WEIGHTS}) AS rank
        FROM search_fts WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`
      const rows = db().prepare(sql).all(...params, w.limit ?? DEFAULT_LIMIT) as Record<string, string | number>[]
      return rows.map((r) => ({
        ref: String(r.ref),
        source: String(r.source),
        kind: String(r.kind),
        workspaceId: String(r.workspaceId),
        labels: String(r.labels).split(' ').filter(Boolean),
        at: Number(r.at),
        title: String(r.title),
        snippet: String(r.snippet),
        rank: Number(r.rank),
      }))
    },
    close() {
      open?.db.close()
      open = null
    },
  }
}
