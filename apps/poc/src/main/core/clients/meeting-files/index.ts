// Meetings on disk, one visible folder each: <root>/YYYY/MM/<YYYY-MM-DD-HHMM-slug>/ with transcript.md and meta.json.
// The folders are the record; deleting one deletes the meeting.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingMeta, TranscriptLine } from './types.ts'

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
}

export const NOTICE = '> Recorded and transcribed locally by mag; no audio is kept. Make sure everyone on the call and your workplace allow transcripts.'

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

export function createMeetingFiles(root: string): MeetingFiles {
  const dirs = new Map<string, string>()
  const dirOf = (id: string) => {
    const dir = dirs.get(id)
    if (!dir) throw new Error(`No meeting ${id} in this session`)
    return dir
  }
  const writeJson = (dir: string, meta: MeetingMeta) => {
    const tmp = join(dir, '.meta.json.tmp')
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`)
    renameSync(tmp, join(dir, 'meta.json'))
  }
  return {
    create(meta) {
      const started = new Date(meta.startedAt)
      const month = join(root, String(started.getFullYear()), pad(started.getMonth() + 1))
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
        dirs.set(id, dir)
        writeJson(dir, { id, ...meta })
        writeFileSync(join(dir, 'transcript.md'), `# ${meta.title}\n\n${NOTICE}\n\n`)
        return { id, dir }
      }
    },
    appendTranscript(id, lines) {
      if (lines.length) appendFileSync(join(dirOf(id), 'transcript.md'), lines.map((l) => `${formatLine(l)}\n`).join(''))
    },
    writeMeta(id, meta) {
      writeJson(dirOf(id), meta)
    },
  }
}
