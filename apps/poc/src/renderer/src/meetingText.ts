import type { Meeting, MeetingLink } from '../../main/core/services/meetings/types.ts'

export interface ShownLine {
  /** hh:mm:ss as written. */
  at: string
  speaker: string
  text: string
}

/** transcript.md's lines; its header (title, notice) and anything else is left out. */
export function transcriptLines(md: string): ShownLine[] {
  return md.split('\n').flatMap((l) => {
    const m = /^\[(\d{2}:\d{2}:\d{2})\] (\S+): (.*)$/.exec(l)
    return m ? [{ at: m[1], speaker: m[2], text: m[3] }] : []
  })
}

/** "20 Nov, 14:30 · 42 min" in the user's locale. */
export function meetingWhen(m: Pick<Meeting, 'startedAt' | 'endedAt'>, locale?: string): string {
  const start = new Date(m.startedAt)
  const day = start.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  const time = start.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (!m.endedAt) return `${day}, ${time}`
  const min = Math.max(1, Math.round((Date.parse(m.endedAt) - start.getTime()) / 60_000))
  return `${day}, ${time} · ${min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`}`
}

export const linkKey = (l: MeetingLink) => `${l.projectId}:${l.topicId ?? ''}:${l.workKey ?? ''}`
