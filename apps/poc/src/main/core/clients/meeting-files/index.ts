// Meetings on disk, one visible folder each: <root>/YYYY/MM/<YYYY-MM-DD-HHMM-slug>/ with transcript.md, summary.md and
// meta.json. The folders are the record; deleting one deletes the meeting.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingContent, MeetingMeta, TranscriptLine } from './types.ts'

export type * from './types.ts'

export interface MeetingDir {
  id: string
  dir: string
}

export interface MeetingFiles {
  /** Creates the meeting's folder (a suffix when the name is taken), its meta.json and transcript.md's header. */
  create(meta: Omit<MeetingMeta, 'id'>): MeetingDir
  appendTranscript(id: string, lines: TranscriptLine[]): void
  writeMeta(id: string, meta: MeetingMeta): void
  writeSummary(id: string, md: string): void
  /** Every meeting under the root, newest first; a folder without a readable meta.json is skipped. */
  list(): MeetingMeta[]
  /** Throws when there is no such meeting. */
  read(id: string): MeetingContent
  /** Deletes the meeting's folder. */
  remove(id: string): void
  /** The folder of a meeting id (whether it exists or not). */
  dirOf(id: string): string
  /** When any of its files last changed, whole ms; 0 when there are none. */
  changedAt(id: string): number
}

export const NOTICE = '> Recorded and transcribed locally by mag; no audio is kept. Make sure everyone on the call and your workplace allow transcripts.'

/** A meeting id: what folderName makes, with a collision suffix maybe. Anything else (a path) is refused. */
const ID = /^(\d{4})-(\d{2})-\d{2}-\d{4}-[\p{L}\p{N}-]+$/u

const pad = (n: number) => String(n).padStart(2, '0')

export const slug = (title: string) =>
  title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'call'

/** 2026-11-20-1430-dbo-sync, in local time as the user saw the call start. */
export const folderName = (startedAt: Date, title: string) =>
  `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}-${slug(title)}`

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

export const formatLine = (l: TranscriptLine) => `[${clock(l.at)}] ${l.speaker}: ${l.text}`

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** `root`: read on every call, so a changed storage root applies at once. */
export function createMeetingFiles(root: () => string): MeetingFiles {
  const dirOf = (id: string) => {
    const m = ID.exec(id)
    if (!m) throw new Error(`Not a meeting id: ${id}`)
    return join(root(), m[1], m[2], id)
  }
  const existing = (id: string) => {
    const dir = dirOf(id)
    if (!existsSync(join(dir, 'meta.json'))) throw new Error(`No meeting ${id}`)
    return dir
  }
  const writeAtomic = (dir: string, file: string, text: string) => {
    const tmp = join(dir, `.${file}.tmp`)
    writeFileSync(tmp, text)
    renameSync(tmp, join(dir, file))
  }
  const subdirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
    } catch {
      return []
    }
  }
  return {
    dirOf,
    create(meta) {
      const started = new Date(meta.startedAt)
      const month = join(root(), String(started.getFullYear()), pad(started.getMonth() + 1))
      mkdirSync(month, { recursive: true })
      const base = folderName(started, meta.title)
      for (let n = 1; ; n++) {
        const id = n === 1 ? base : `${base}-${n}`
        const dir = join(month, id)
        try {
          mkdirSync(dir)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw e
        }
        writeAtomic(dir, 'meta.json', `${JSON.stringify({ id, ...meta }, null, 2)}\n`)
        writeFileSync(join(dir, 'transcript.md'), `# ${meta.title}\n\n${NOTICE}\n\n`)
        return { id, dir }
      }
    },
    appendTranscript(id, lines) {
      if (lines.length) appendFileSync(join(existing(id), 'transcript.md'), lines.map((l) => `${formatLine(l)}\n`).join(''))
    },
    writeMeta(id, meta) {
      writeAtomic(existing(id), 'meta.json', `${JSON.stringify(meta, null, 2)}\n`)
    },
    writeSummary(id, md) {
      writeAtomic(existing(id), 'summary.md', md.endsWith('\n') ? md : `${md}\n`)
    },
    list() {
      const r = root()
      const metas: MeetingMeta[] = []
      for (const year of subdirs(r).filter((y) => /^\d{4}$/.test(y))) {
        for (const month of subdirs(join(r, year)).filter((m) => /^\d{2}$/.test(m))) {
          for (const id of subdirs(join(r, year, month))) {
            if (!ID.test(id)) continue
            try {
              const meta = JSON.parse(readFileSync(join(r, year, month, id, 'meta.json'), 'utf8')) as MeetingMeta
              metas.push({ ...meta, id })
            } catch {
              // not a meeting folder, or one half deleted
            }
          }
        }
      }
      return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
    read(id) {
      const dir = existing(id)
      const meta = { ...(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as MeetingMeta), id }
      return { meta, summary: readText(join(dir, 'summary.md')), transcript: readText(join(dir, 'transcript.md')), dir }
    },
    remove(id) {
      rmSync(existing(id), { recursive: true, force: true })
    },
    changedAt(id) {
      const dir = dirOf(id)
      return Math.floor(Math.max(0, ...['meta.json', 'transcript.md', 'summary.md'].map((f) => statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0)))
    },
  }
}
