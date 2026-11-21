// Refs and inbox keys of routines (routines-scheduled-drafts-and-a.1, .2); pure, so windows use them too.

/** What an inbox item of a routine is about: `<folder>:routine:<id>`; Retry runs it. */
export const routineRef = (folder: string, routineId: string) => `${folder}:routine:${routineId}`

/** The routine id of a routine's ref, else null. */
export const routineOfRef = (ref: string | null | undefined) => /(?:^|:)routine:([\w-]+)$/.exec(ref ?? '')?.[1] ?? null

/** The inbox key of a routine's failure: one per routine, replaced by the next one, resolved by a run that ends fine. */
export const failedKey = (routineId: string) => `routine:${routineId}:failed`

/** The inbox key of a run's outcome; the Inbox finds its log and draft by it. */
export const runKey = (routineId: string, runId: string) => `routine:${routineId}:run:${runId}`

/** The routine and run of a run's inbox key, else null. */
export function runOfKey(key: string): { routineId: string; runId: string } | null {
  const m = /^routine:([\w-]+):run:([\w-]+)$/.exec(key)
  return m ? { routineId: m[1], runId: m[2] } : null
}
