// Refs and inbox keys of routines (routines-scheduled-drafts-and-a.1, .2) and follow-ups (.3); pure, so windows use
// them too.

/** The inbox key of a due follow-up; its Done closes the follow-up. */
export const followUpKey = (followUpId: string) => `follow_up:${followUpId}`

/** The follow-up id of a follow-up's inbox key, else null. */
export const followUpOfKey = (key: string) => /^follow_up:([\w-]+)$/.exec(key)?.[1] ?? null

/** The hour a date-only due comes back at: the start of a working day. */
export const DUE_HOUR = 9

/**
 * A due date as ms: "YYYY-MM-DD" (DUE_HOUR local), "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM" (local), or an ISO time
 * with its zone. Throws for anything else.
 */
export function dueAtOf(value: string): number {
  const v = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v)
  if (m) {
    const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? String(DUE_HOUR), m[5] ?? '0'].map(Number)
    const t = new Date(y, mo - 1, d, h, mi)
    if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d || h > 23 || mi > 59) throw new Error(`Not a date: ${value}`)
    return t.getTime()
  }
  const t = /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN
  if (Number.isNaN(t)) throw new Error(`Not a date: ${value} (YYYY-MM-DD, or YYYY-MM-DD HH:MM)`)
  return t
}

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
