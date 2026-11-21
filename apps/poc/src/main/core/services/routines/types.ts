// Routines and their runs as stored and as windows get them (routines-scheduled-drafts-and-a.1).
import type { Destination } from '@mag/core'

export interface Routine {
  id: string
  workspaceId: string
  title: string
  /** Cron string, local time (core/lib/cron). */
  schedule: string
  /** Deliverable kind: its pack gives the prompt and rules. */
  kind: string
  /** What to draft beyond the pack, in the user's words; '' for the pack alone. */
  brief: string
  /** Where to read from, e.g. jira:PRVP, gh:org/repo, slack:#chan, meetings. */
  sources: string[]
  /** Where the final version will be published; checked by core/lib/destinations when it is. */
  destination: Destination | null
  /** Label ids it is scoped to. */
  labels: string[]
  enabled: boolean
  /** The next slot (ms); null when disabled or the schedule never fires. */
  nextAt: number | null
  createdAt: number
  updatedAt: number
}

export type RunStatus = 'running' | 'drafted' | 'failed'

export interface RoutineRun {
  id: string
  routineId: string
  /** The scheduled slot it runs (its lock); null for Run now. */
  slot: number | null
  startedAt: number
  endedAt: number | null
  status: RunStatus
  /** The headless drafter session. */
  sessionId: string | null
  /** `<workspace>:dlv:<slug>` of its draft. */
  deliverableRef: string | null
  error: string | null
}

/** A new routine (no id) or an edit of one; fields left out keep theirs. */
export interface RoutineInput {
  id?: string
  workspaceId?: string
  title?: string
  schedule?: string
  kind?: string
  brief?: string
  sources?: string[]
  destination?: Destination | null
  labels?: string[]
  enabled?: boolean
}

export type RunResult = { status: 'drafted'; deliverableRef: string } | { status: 'failed'; error: string; deliverableRef?: string | null }

/** Where the routines keep their rows; writes persist. */
export interface RoutineRecords {
  routines(): Routine[]
  putRoutine(r: Routine): void
  removeRoutine(id: string): void
  runs(): RoutineRun[]
  putRun(r: RoutineRun): void
  removeRuns(ids: string[]): void
}
