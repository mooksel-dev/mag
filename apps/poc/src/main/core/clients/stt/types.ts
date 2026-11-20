// Types of speech to text, for callers that run without Node (the renderer).
/** Times in seconds from the start of the chunk. */
export interface Segment {
  start: number
  end: number
  text: string
}

export type SetupProgress =
  | { step: 'install' }
  | { step: 'model'; done: number; total: number | null }
  | { step: 'load' }
