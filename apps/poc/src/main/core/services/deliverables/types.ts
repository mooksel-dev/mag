// Types of the deliverables service, for callers that run without Node (the renderer).
import type { Destination, FindingLevel } from '@mag/core'

export const DELIVERABLE_KINDS = ['report', 'assessment', 'proposal', 'decision', 'reply', 'ticket', 'agenda', 'other'] as const
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]

/** draft → in_review (a verifier ran, step .2) → final → published; a new version sends it back to draft. */
export type DeliverableState = 'draft' | 'in_review' | 'final' | 'published'

/** people: about a person (an assessment); shown only where asked for. */
export type Sensitivity = 'work' | 'people'

export const CLAIM_KINDS = ['count', 'fact', 'inference', 'opinion'] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

/** mag's mechanical check of a claim: ok, no refs, a count without its query, a ref that does not resolve, a person claim without a primary source. */
export type ClaimCheck = 'ok' | 'missing_ref' | 'no_query' | 'unresolved' | 'weak_source'

/** A statement of a version (step .2): its exact span in the markdown and what backs it. */
export interface Claim {
  id: string
  text: string
  kind: ClaimKind
  /** URLs, PRs (owner/repo#N), tickets (ABC-12), dlv:<slug>, mtg:<id>@<hh:mm:ss>, topic:<id>, absolute file paths. */
  refs: string[]
  /** The command or JQL that produced a count. */
  query: string | null
  /** The person it is about; in a people-sensitive deliverable every claim is about one. */
  person: string | null
  check: ClaimCheck
  /** Why the check failed; null when ok. */
  why: string | null
}

export const VERDICTS = ['publish', 'changes', 'look'] as const
/** publish: ready to send; changes: the author fixes the findings first; look: the user decides. */
export type Verdict = (typeof VERDICTS)[number]

export interface VerdictFinding {
  claimId: string | null
  text: string
  level: FindingLevel
}

/** A verifier's verdict on one version. */
export interface VersionVerdict {
  verdict: Verdict
  findings: VerdictFinding[]
  verifierSessionId: string
  /** true: a fresh session without the topic's context; false: a fork of the topic. */
  fresh: boolean
  at: number
}

/** A version's text is v<n>.md in the deliverable's folder. */
export interface DeliverableVersion {
  n: number
  at: number
  by: 'agent' | 'user'
  /** set_claims' ledger of this version; missing until set. */
  claims?: Claim[]
  verdict?: VersionVerdict | null
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
  /** The verifier mag started last: only it sets the verdict of version n. Missing on records before step .2. */
  verifying?: { sessionId: string; n: number; fresh: boolean; at: number } | null
  createdAt: number
  updatedAt: number
}

/** Where the records live: the app's store, which writes them to workspace-db. */
export interface DeliverableRecords {
  all(): Deliverable[]
  put(d: Deliverable): void
  remove(id: string): void
}
