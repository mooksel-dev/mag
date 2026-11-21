// Types of the search service, for callers that run without Node (the renderer).
import type { Sensitivity } from '../../clients/search-index/types.ts'
import type { SearchKind } from '../../lib/search-rows/index.ts'

export type { Sensitivity } from '../../clients/search-index/types.ts'
export type { SearchKind } from '../../lib/search-rows/index.ts'

/** One hit per source: its best row. `ref` opens it (read), `labels` are label ids. */
export interface Hit {
  ref: string
  kind: SearchKind
  title: string
  /** Matched words between \u0002 and \u0003. */
  snippet: string
  /** ms. */
  at: number
  labels: string[]
}

export interface QueryOptions {
  /** The caller's workspace: the default scope. */
  workspaceId: string
  /** 'all', or another workspace's id; the caller's when missing. */
  scope?: string
  kinds?: SearchKind[]
  /** Every group matched: a hit has one of the group's label ids. */
  labels?: string[][]
  /** Rows about people (person notes) and of the Personal workspace outside its own scope; off by default. */
  people?: boolean
  /** ms. */
  from?: number
  to?: number
  /** Only these sources. */
  sources?: string[]
  limit?: number
  /** For the recency decay; Date.now() by default. */
  now?: number
}
