// Types of meetings on disk, for callers that run without Node (the renderer).
/** What a meeting is linked to: a topic (its session id) or a work (its key) of a project. */
export interface MeetingLink {
  projectId: string
  topicId?: string
  workKey?: string
}

/** meta.json. `id`: the folder's name. Times are ISO. */
export interface MeetingMeta {
  id: string
  title: string
  startedAt: string
  endedAt?: string
  /** Why the transcript is incomplete, when it is. */
  error?: string
  /** The call's app, when known. */
  app?: 'zoom' | 'meet' | 'huddle' | 'other'
  /** Names the summary found. */
  participants?: string[]
  links?: MeetingLink[]
}

export type Speaker = 'me' | 'others'

/** `at`: seconds since the meeting started. */
export interface TranscriptLine {
  at: number
  speaker: Speaker
  text: string
}

/** A meeting's files as they are; '' for a file that is not there. */
export interface MeetingContent {
  meta: MeetingMeta
  summary: string
  transcript: string
  dir: string
}
