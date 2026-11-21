// Types of the search index, for callers that run without Node (the renderer).
export type Sensitivity = 'work' | 'people' | 'personal'

/** Around the matched words of a snippet. */
export const MARK_START = '\u0002'
export const MARK_END = '\u0003'

/** One row of the index: a message, a doc section, a decision, a meeting line… of one indexed source. */
export interface IndexRow {
  /** Opens the row, with its workspace: see parseRef. */
  ref: string
  kind: string
  /** '' for workspace-wide rows (meetings): they are in every scope. */
  workspaceId: string
  labels: string[]
  sensitivity: Sensitivity
  /** ms. */
  at: number
  title: string
  text: string
}

/** Which rows a match keeps. Missing = no filter; an empty list matches nothing. */
export interface MatchWhere {
  /** These workspaces and the workspace-wide rows. */
  workspaceIds?: string[]
  kinds?: string[]
  /** Every group matched: a row has one of the group's label ids. */
  labels?: string[][]
  /** Rows of these sensitivities are left out. */
  exclude?: Sensitivity[]
  sources?: string[]
  from?: number
  to?: number
  limit?: number
}

export interface MatchRow {
  ref: string
  source: string
  kind: string
  workspaceId: string
  labels: string[]
  at: number
  title: string
  /** The best part of the row around the match; matched words between \u0002 and \u0003. */
  snippet: string
  /** bm25 with the title ×3: lower is better (negative). */
  rank: number
}
