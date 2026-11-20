// Types of the meeting index, for callers that run without Node (the renderer).
/** One matching line. `at`: hh:mm:ss of a transcript line, null for the title and summary. */
export interface IndexHit {
  meetingId: string
  part: 'summary' | 'transcript'
  at: string | null
  /** The line around the match; matched words between \u0002 and \u0003. */
  snippet: string
}
