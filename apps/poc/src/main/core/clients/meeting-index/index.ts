// Full-text search over meetings: SQLite FTS5 (node:sqlite) in <root>/.index.sqlite, one row per transcript line and per
// summary line, and the version of each meeting it holds. Derived from the files only: safe to delete, built again from
// them.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IndexHit } from './types.ts'

export type * from './types.ts'

/** What the index keeps of a meeting: its title, summary.md and transcript.md as they are. */
export interface IndexedMeeting {
  id: string
  /** When its files last changed (ms); reindex skips a meeting indexed at this version. */
  version: number
  title: string
  summary: string
  transcript: string
}

export interface QueryFilters {
  /** Only these meetings; all when not given. */
  meetingIds?: string[]
  limit?: number
}

export interface MeetingIndex {
  upsert(meeting: IndexedMeeting): void
  remove(id: string): void
  /** Ranked best first; [] for a query without words. */
  query(q: string, filters?: QueryFilters): IndexHit[]
  /** Meeting id → the version it is indexed at. */
  versions(): Map<string, number>
  close(): void
}

/** Marks around the matched words in a snippet. */
export const MARK_START = '\u0002'
export const MARK_END = '\u0003'
const DEFAULT_LIMIT = 50

/** The user's words as an FTS5 query: each a quoted prefix, all required; operators and punctuation are plain text. */
export function ftsQuery(q: string): string {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return words.map((w) => `"${w}"*`).join(' ')
}

const LINE = /^\[(\d{2}:\d{2}:\d{2})\] (\S+: .*)$/

/** Rows of a meeting: its title and summary lines (no time), then its transcript lines with their [hh:mm:ss]. */
export function rowsOf(m: IndexedMeeting): { part: 'summary' | 'transcript'; at: string; text: string }[] {
  const summary = [m.title, ...m.summary.split('\n')].map((l) => l.replace(/^#+\s*|^\s*[-*]\s+/, '').trim()).filter(Boolean)
  const transcript = m.transcript.split('\n').flatMap((l) => {
    const x = LINE.exec(l)
    return x ? [{ part: 'transcript' as const, at: x[1], text: x[2] }] : []
  })
  return [...summary.map((text) => ({ part: 'summary' as const, at: '', text })), ...transcript]
}

/** `path`: read on every call, so a changed storage root gets its own index. */
export function createMeetingIndex(path: () => string): MeetingIndex {
  let open: { path: string; db: DatabaseSync } | null = null
  const db = () => {
    const p = path()
    if (open?.path === p) return open.db
    open?.db.close()
    mkdirSync(dirname(p), { recursive: true })
    const d = new DatabaseSync(p)
    d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(meetingId UNINDEXED, part UNINDEXED, at UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')`)
    d.exec('CREATE TABLE IF NOT EXISTS meetings_indexed (meetingId TEXT PRIMARY KEY, version INTEGER NOT NULL)')
    open = { path: p, db: d }
    return d
  }
  const write = (d: DatabaseSync, m: IndexedMeeting) => {
    d.prepare('DELETE FROM meetings_fts WHERE meetingId = ?').run(m.id)
    const insert = d.prepare('INSERT INTO meetings_fts (meetingId, part, at, text) VALUES (?, ?, ?, ?)')
    for (const r of rowsOf(m)) insert.run(m.id, r.part, r.at, r.text)
    d.prepare('INSERT INTO meetings_indexed (meetingId, version) VALUES (?, ?) ON CONFLICT (meetingId) DO UPDATE SET version = excluded.version').run(m.id, m.version)
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
    upsert: (m) => inTransaction((d) => write(d, m)),
    remove: (id) =>
      inTransaction((d) => {
        d.prepare('DELETE FROM meetings_fts WHERE meetingId = ?').run(id)
        d.prepare('DELETE FROM meetings_indexed WHERE meetingId = ?').run(id)
      }),
    versions: () => new Map((db().prepare('SELECT meetingId, version FROM meetings_indexed').all() as { meetingId: string; version: number }[]).map((r) => [r.meetingId, Number(r.version)])),
    query(q, filters = {}) {
      const match = ftsQuery(q)
      if (!match || filters.meetingIds?.length === 0) return []
      const ids = filters.meetingIds
      const sql = `SELECT meetingId, part, at, snippet(meetings_fts, 3, '${MARK_START}', '${MARK_END}', '…', 16) AS snippet
        FROM meetings_fts WHERE meetings_fts MATCH ?${ids ? ` AND meetingId IN (${ids.map(() => '?').join(',')})` : ''}
        ORDER BY bm25(meetings_fts) LIMIT ?`
      const rows = db().prepare(sql).all(match, ...(ids ?? []), filters.limit ?? DEFAULT_LIMIT) as unknown as IndexHit[]
      return rows.map((r) => ({ meetingId: r.meetingId, part: r.part, at: r.at || null, snippet: r.snippet }))
    },
    close() {
      open?.db.close()
      open = null
    },
  }
}
