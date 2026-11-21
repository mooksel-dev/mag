// Refs of routines as inbox items carry them (routines-scheduled-drafts-and-a.1); pure, so windows use them too.

/** What an inbox item of a routine is about: `<folder>:routine:<id>`; Retry runs it. */
export const routineRef = (folder: string, routineId: string) => `${folder}:routine:${routineId}`

/** The routine id of a routine's ref, else null. */
export const routineOfRef = (ref: string | null | undefined) => /(?:^|:)routine:([\w-]+)$/.exec(ref ?? '')?.[1] ?? null
