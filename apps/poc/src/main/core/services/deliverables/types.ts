// Types of the deliverables service, for callers that run without Node (the renderer).
import type { Destination } from '@mag/core'

export const DELIVERABLE_KINDS = ['report', 'assessment', 'proposal', 'decision', 'reply', 'ticket', 'agenda', 'other'] as const
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]

/** draft → in_review (a verifier ran, step .2) → final → published; a new version sends it back to draft. */
export type DeliverableState = 'draft' | 'in_review' | 'final' | 'published'

/** people: about a person (an assessment); shown only where asked for. */
export type Sensitivity = 'work' | 'people'

/** A version's text is v<n>.md in the deliverable's folder. */
export interface DeliverableVersion {
  n: number
  at: number
  by: 'agent' | 'user'
}

/**
 * A non-code result (a report, an assessment, a reply…) with its versions and the one that is final. Its ref is
 * `<folder>:dlv:<slug>`.
 */
export interface Deliverable {
  id: string
  /** Unique in its workspace: the folder name under deliverables/. */
  slug: string
  workspaceId: string
  /** The workspace's folder under ~/Documents/mag, fixed when the deliverable was made. */
  folder: string
  /** null: made in a topic without a project; follows its topic when the topic moves. */
  projectId: string | null
  /** The topic it was made in. */
  topicId: string | null
  taskId: string | null
  kind: DeliverableKind
  title: string
  labels: string[]
  sensitivity: Sensitivity
  state: DeliverableState
  /** The version marked final last; kept when a new version sends it back to draft. */
  finalVersion: number | null
  destination: Destination | null
  publishedAt: number | null
  versions: DeliverableVersion[]
  /** The user's Publish, sent to this session: its next allowed write to a destination publishes the deliverable. */
  publishing: { sessionId: string; at: number } | null
  createdAt: number
  updatedAt: number
}

/** Where the records live: the app's store, which writes them to workspace-db. */
export interface DeliverableRecords {
  all(): Deliverable[]
  put(d: Deliverable): void
  remove(id: string): void
}
