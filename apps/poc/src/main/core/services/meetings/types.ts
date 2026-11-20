// Types of the meetings service, for callers that run without Node (the renderer).
import type { MeetingMeta } from '../../clients/meeting-files/types.ts'
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
