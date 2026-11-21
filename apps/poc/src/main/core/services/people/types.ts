/** Where a handle comes from; meeting: a name spoken on a call or in its invite. */
export type PeopleSystem = 'slack' | 'atlassian' | 'github' | 'meeting'
export const PEOPLE_SYSTEMS: readonly PeopleSystem[] = ['slack', 'atlassian', 'github', 'meeting']

/** A person of a workspace; the same human in two workspaces is two persons. */
export interface Person {
  /** A stable slug of the name, unique in the store. */
  id: string
  workspaceId: string
  name: string
  /** Lower case; unique in the workspace. */
  email: string | null
  title: string | null
  avatar: string | null
  /** A vendor's: a Slack Connect or guest user. */
  external: boolean
  syncedAt: number
}

/** How an identity got its person. */
export type IdentitySource = 'directory' | 'email' | 'commit' | 'override'

/** A handle of a system as a directory listed it, and its person once matched. Kept by (workspace, system, handle). */
export interface Identity {
  /** `${workspaceId}|${system}|${handle}`. */
  id: string
  workspaceId: string
  system: PeopleSystem
  handle: string
  /** null: not matched yet (or not a person, by an override). */
  personId: string | null
  source: IdentitySource | null
  /** What the directory says about the handle. */
  name?: string
  email?: string
  /** GitHub: the login's commit emails in the workspace repos. */
  commitEmails?: string[]
  /** Persons the user said this handle is not; never suggested again. */
  rejected?: string[]
  syncedAt: number
}

/** The user's correction of a handle's person; it wins over every directory and survives every sync. */
export interface IdentityOverride {
  /** As Identity.id. */
  id: string
  workspaceId: string
  system: PeopleSystem
  handle: string
  /** null: not a person (a bot). */
  personId: string | null
  at: number
}

export interface PersonView extends Person {
  handles: { system: PeopleSystem; handle: string; name?: string; source: IdentitySource | null }[]
}

/** What a handle is. */
export type Resolution =
  | { kind: 'person'; person: PersonView; source: IdentitySource }
  | { kind: 'notPerson' }
  /** suggestion: the one person whose name is close; the user confirms it. */
  | { kind: 'unknown'; suggestion?: PersonView }

/** "Is `handle` = `person`?", for the user to confirm or reject. */
export interface Suggestion {
  system: PeopleSystem
  handle: string
  name: string
  person: PersonView
}

export interface SyncReport {
  workspaceId: string
  at: number
  /** Handles synced this time that have a person, and were not made into one now. */
  matched: number
  /** Persons made now. */
  new: number
  /** Handles synced this time without a person. */
  unmatched: number
  /** A directory that failed, one line each; the others synced. */
  errors: string[]
}

/** The People section of a workspace. */
export interface PeopleList {
  persons: PersonView[]
  suggestions: Suggestion[]
  /** Handles without a person and without a suggestion. */
  unmatched: Identity[]
  lastSync: SyncReport | null
  syncing: boolean
}

/** The user's correction of a handle. */
export interface OverrideInput {
  workspaceId: string
  system: PeopleSystem
  handle: string
  /** null: not a person. */
  personId: string | null
}

/** A Project label as activity reaches it: its repositories (paths) and Jira keys. */
export interface ProjectScope {
  id: string
  name: string
  repos: string[]
  jiraKeys: string[]
}

/** A meeting of the workspace as activity counts it: the Project labels it is linked to, the names said to take part. */
export interface MeetingFacts {
  id: string
  /** ms. */
  startedAt: number
  projectIds: string[]
  names: string[]
}

/** A person's activity in one Project label over the window. */
export interface ProjectActivity {
  labelId: string
  label: string
  /** PRs they opened. */
  prs: number
  /** Others' PRs they reviewed. */
  reviews: number
  /** Work items they are the assignee or reporter of, updated in the window. */
  tickets: number
  /** Linked meetings they took part in. */
  meetings: number
}

/** Where a person works: derived from activity, never declared. */
export interface WhereWorks {
  personId: string
  days: number
  /** The window's start (ms). */
  from: number
  /** When the PRs and tickets were fetched (ms); they are kept for the day. */
  fetchedAt: number
  /** Most active first; labels without activity left out. */
  projects: ProjectActivity[]
  /** A source that failed, one line each; its counts are missing. */
  errors: string[]
}

/** PRs and reviews of one person (or an unmatched login) in one Project label. */
export interface PrStatsRow {
  /** null: a GitHub login without a person. */
  personId: string | null
  name: string
  /** The logins of theirs that count here. */
  logins: string[]
  /** null: a repository of no Project label. */
  labelId: string | null
  label: string
  /** PRs opened in the window. */
  prs: number
  /** Their PRs merged in the window. */
  merged: number
  /** Others' PRs they reviewed in the window, each PR once. */
  reviews: number
}

export interface PrStats {
  from: number
  to: number
  /** By label, then most PRs and reviews first. */
  rows: PrStatsRow[]
  errors: string[]
}

/** A name said to take part in a meeting, as one workspace's people resolve it: a chip on the meeting. */
export interface MeetingPerson {
  name: string
  /** The person it is; missing when unknown or not a person. */
  person?: { id: string; name: string; avatar: string | null }
  /** The person it may be, unconfirmed: the user confirms it in People. */
  suggestion?: { id: string; name: string }
  notPerson?: true
}
