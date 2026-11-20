// Types of the meetings service, for callers that run without Node (the renderer).
import type { MeetingMeta } from '../../clients/meeting-files/types.ts'

export type { MeetingContent, MeetingLink } from '../../clients/meeting-files/types.ts'
import type { IndexHit } from '../../clients/meeting-index/types.ts'
import type { SetupProgress } from '../../clients/stt/types.ts'

export type Meeting = MeetingMeta

export interface Recording {
  /** null while the capture is starting (the first time: waiting for the user's permissions). */
  meeting: Meeting | null
  /** The meeting's folder, once created. */
  dir: string | null
  startedAt: string
  phase: 'starting' | 'recording' | 'stopping'
  /** Transcription's first-run setup (install, model download, load); null once ready. */
  setup: SetupProgress | null
  /** Chunks recorded but not transcribed yet. */
  pending: number
  error?: string
}

/** A line search found, with its meeting's title and start. */
export interface MeetingHit extends IndexHit {
  title: string
  startedAt: string
}

/** Dates are ISO; a date alone is the local day. `people`: any of them took part (a part of a name). */
export interface SearchFilters {
  from?: string
  to?: string
  people?: string[]
  limit?: number
}
