// Routines and their runs as stored and as windows get them (routines-scheduled-drafts-and-a.1, .2: a trigger and a prompt).
import type { ModelChoice } from '@mag/core'

/** What starts a routine. Only a schedule now; event triggers (a new PR, a Slack message) join this union later. */
export type RoutineTrigger = { kind: 'schedule'; cron: string }

export interface Routine {
  id: string
  workspaceId: string
  name: string
  trigger: RoutineTrigger
  /** The instruction a run starts on, in the user's words. */
  prompt: string
  /** The Project label it runs in (its repos, notes and label); null: the workspace. */
  projectId: string | null
  /** The agent, model and effort a run uses; null: the drafter role's defaults. */
  choice: ModelChoice | null
  enabled: boolean
  /** The next time its trigger fires (ms); null when disabled or it never fires. */
  nextAt: number | null
  createdAt: number
  updatedAt: number
}

/** A row of .1 that says drafted reads as done. */
export type RunStatus = 'running' | 'done' | 'failed'

export interface RoutineRun {
  id: string
  routineId: string
  /** The trigger's slot it runs (its lock); null for Run now. */
  slot: number | null
  startedAt: number
  endedAt: number | null
  status: RunStatus
  /** The headless session. */
  sessionId: string | null
  /** `<workspace>:dlv:<slug>` of the draft it made, if it made one. */
  deliverableRef: string | null
  /** Its last line: what it did. */
  summary?: string | null
  error: string | null
}

/** A new routine (no id) or an edit of one; fields left out keep theirs. */
export interface RoutineInput {
  id?: string
  workspaceId?: string
  name?: string
  trigger?: RoutineTrigger
  prompt?: string
  projectId?: string | null
  choice?: ModelChoice | null
  enabled?: boolean
}

export type RunResult = { status: 'done'; summary: string | null; deliverableRef: string | null } | { status: 'failed'; error: string; deliverableRef?: string | null }

/** Where the routines keep their rows; writes persist. */
export interface RoutineRecords {
  routines(): Routine[]
  putRoutine(r: Routine): void
  removeRoutine(id: string): void
  runs(): RoutineRun[]
  putRun(r: RoutineRun): void
  removeRuns(ids: string[]): void
}
