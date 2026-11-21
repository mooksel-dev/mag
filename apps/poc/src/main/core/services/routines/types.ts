// Routines, their runs and follow-ups as stored and as windows get them (routines-scheduled-drafts-and-a.1, .2: a
// trigger and a prompt; .3: follow-ups).
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

/** open: waits for its date; surfaced: due, in the Inbox; done: closed (the Inbox item's Done). */
export type FollowUpStatus = 'open' | 'surfaced' | 'done'

/** Something to follow up on with someone by a date (routines-scheduled-drafts-and-a.3). */
export interface FollowUp {
  id: string
  workspaceId: string
  projectId: string | null
  /** Who it is with, as the user calls them ("me" when it is the user's own). */
  who: string
  what: string
  /** When it comes back to the Inbox (ms). */
  dueAt: number
  /** What it came from: an Inbox item's ref, a meeting (mtg:<id>), a URL; null: nothing. */
  sourceRef: string | null
  status: FollowUpStatus
  createdAt: number
  closedAt: number | null
}

export type FollowUpInput = Pick<FollowUp, 'workspaceId' | 'who' | 'what' | 'dueAt'> & Partial<Pick<FollowUp, 'projectId' | 'sourceRef'>>

/** Where the routines keep their rows; writes persist. */
export interface RoutineRecords {
  routines(): Routine[]
  putRoutine(r: Routine): void
  removeRoutine(id: string): void
  runs(): RoutineRun[]
  putRun(r: RoutineRun): void
  removeRuns(ids: string[]): void
  followUps(): FollowUp[]
  putFollowUp(f: FollowUp): void
}
