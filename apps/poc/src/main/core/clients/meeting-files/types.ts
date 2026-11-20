// Types of meetings on disk, for callers that run without Node (the renderer).
/** meta.json. `id`: the folder's name. Times are ISO. */
export interface MeetingMeta {
  id: string
  title: string
  startedAt: string
  endedAt?: string
  /** Why the transcript is incomplete, when it is. */
  error?: string
}

export type Speaker = 'me' | 'others'

/** `at`: seconds since the meeting started. */
export interface TranscriptLine {
  at: number
  speaker: Speaker
  text: string
}
