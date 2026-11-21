// The workspace's store on SQLite (node:sqlite, WAL): one row per entity (a project, task, session, doc...) as JSON, and
// a session's chat items as rows of their own, so a session's history loads only when it is read.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** An entity as stored: `kind` and `id` are its key; `json` its content. */
export interface EntityRow {
  kind: string
  id: string
  projectId: string | null
  json: string
}

/** Rows per entity kind and items per session. */
export interface Counts {
  entities: Record<string, number>
  items: Record<string, number>
}

/** What an import stores: entities in their order, and each session's items in theirs. */
export interface ImportData {
  entities: EntityRow[]
  items: Record<string, string[]>
}

export interface WorkspaceDb {
  /** Whether the db holds a workspace: set by an import or `init`, in the same transaction. */
  ready(): boolean
  /** Marks an empty db as a workspace. */
  init(): void
  /** Every entity, in the order it was first put. */
  load(): EntityRow[]
  /** A session's items, oldest first. */
  items(sid: string): string[]
  /** Inserts or replaces an entity; a replaced one keeps its place in the order. */
  put(row: EntityRow): void
  /** Removes an entity; a session's items go with it. */
  remove(kind: string, id: string): void
  /** Sets the item at index `n` of a session. */
  putItem(sid: string, n: number, json: string): void
  /** Drops a session's items from index `from` on. */
  cutItems(sid: string, from: number): void
  /** Runs `fn` in one transaction: all of its writes or, when it throws, none. */
  transaction(fn: () => void): void
  /**
   * Stores `data` into the empty db in one transaction and marks it ready. Throws, with nothing stored, when the rows
   * stored per kind or per session differ from `expected`.
   */
  importAll(data: ImportData, expected: Counts): void
  /**
   * The day's first call writes a copy to `dir/mag-YYYY-MM-DD.sqlite` (VACUUM INTO), keeping the newest BACKUPS_KEPT.
   * Returns its path, or null when today's is there.
   */
  backup(dir: string, now?: Date): string | null
  close(): void
}

/** Daily backups kept. */
export const BACKUPS_KEPT = 7

/** `mag-YYYY-MM-DD.sqlite`, by local day. */
export function backupName(at: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `mag-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.sqlite`
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT, json TEXT NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (kind, id));
  CREATE INDEX IF NOT EXISTS entities_seq ON entities (seq);
  CREATE TABLE IF NOT EXISTS items (session_id TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (session_id, n));
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** Removes a db file with its WAL and shared-memory files. */
export function removeDb(path: string) {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true })
}

export function openWorkspaceDb(path: string): WorkspaceDb {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  let seq = Number((db.prepare('SELECT coalesce(max(seq), 0) AS s FROM entities').get() as { s: number }).s)
  const putRow = db.prepare(
    'INSERT INTO entities (kind, id, project_id, json, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET project_id = excluded.project_id, json = excluded.json, updated_at = excluded.updated_at',
  )
  const putItemRow = db.prepare('INSERT INTO items (session_id, n, json) VALUES (?, ?, ?) ON CONFLICT (session_id, n) DO UPDATE SET json = excluded.json')
  const markReady = () => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('workspace', '1')").run()

  const self: WorkspaceDb = {
    ready: () => !!db.prepare("SELECT 1 FROM meta WHERE key = 'workspace'").get(),
    init: () => void markReady(),
    load: () => db.prepare('SELECT kind, id, project_id AS projectId, json FROM entities ORDER BY seq').all() as unknown as EntityRow[],
    items: (sid) => (db.prepare('SELECT json FROM items WHERE session_id = ? ORDER BY n').all(sid) as { json: string }[]).map((r) => r.json),
    put: (r) => void putRow.run(r.kind, r.id, r.projectId, r.json, Date.now(), ++seq),
    remove(kind, id) {
      db.prepare('DELETE FROM entities WHERE kind = ? AND id = ?').run(kind, id)
      if (kind === 'session') self.cutItems(id, 0)
    },
    putItem: (sid, n, json) => void putItemRow.run(sid, n, json),
    cutItems: (sid, from) => void db.prepare('DELETE FROM items WHERE session_id = ? AND n >= ?').run(sid, from),
    transaction(fn) {
      db.exec('BEGIN')
      try {
        fn()
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        seq = Number((db.prepare('SELECT coalesce(max(seq), 0) AS s FROM entities').get() as { s: number }).s)
        throw e
      }
    },
    importAll(data, expected) {
      self.transaction(() => {
        db.exec('DELETE FROM entities; DELETE FROM items; DELETE FROM meta')
        // OR IGNORE: a repeated key is not an error here but a count that differs, reported below.
        const insert = db.prepare('INSERT OR IGNORE INTO entities (kind, id, project_id, json, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)')
        const insertItem = db.prepare('INSERT OR IGNORE INTO items (session_id, n, json) VALUES (?, ?, ?)')
        const now = Date.now()
        for (const r of data.entities) insert.run(r.kind, r.id, r.projectId, r.json, now, ++seq)
        for (const [sid, items] of Object.entries(data.items)) items.forEach((json, n) => insertItem.run(sid, n, json))
        const got = countsOf(db)
        const diff = countsDiff(expected, got)
        if (diff.length) throw new Error(`import counts differ: ${diff.join('; ')}`)
        markReady()
      })
    },
    backup(dir, now = new Date()) {
      const dest = join(dir, backupName(now))
      if (existsSync(dest)) return null
      mkdirSync(dir, { recursive: true })
      db.prepare('VACUUM INTO ?').run(dest)
      const all = readdirSync(dir).filter((f) => /^mag-\d{4}-\d\d-\d\d\.sqlite$/.test(f)).sort()
      for (const f of all.slice(0, -BACKUPS_KEPT)) rmSync(join(dir, f), { force: true })
      return dest
    },
    close: () => db.close(),
  }
  return self
}

function countsOf(db: DatabaseSync): Counts {
  const entities: Record<string, number> = {}
  for (const r of db.prepare('SELECT kind, count(*) AS c FROM entities GROUP BY kind').all() as { kind: string; c: number }[]) entities[r.kind] = Number(r.c)
  const items: Record<string, number> = {}
  for (const r of db.prepare('SELECT session_id AS sid, count(*) AS c FROM items GROUP BY session_id').all() as { sid: string; c: number }[]) items[r.sid] = Number(r.c)
  return { entities, items }
}

/** Lines naming each kind and session whose count differs; a zero and a missing count are the same. */
export function countsDiff(want: Counts, got: Counts): string[] {
  const diff = (what: string, a: Record<string, number>, b: Record<string, number>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => ((a[k] ?? 0) === (b[k] ?? 0) ? [] : [`${what} ${k}: ${a[k] ?? 0} in the source, ${b[k] ?? 0} stored`]))
  return [...diff('kind', want.entities, got.entities), ...diff('items of session', want.items, got.items)]
}
