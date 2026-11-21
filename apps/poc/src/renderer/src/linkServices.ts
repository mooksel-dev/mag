// External link pills (T-36): one registry of the services mag links to. A new service (GitLab, Bitbucket…) is one entry.
import { ticketLabel, type RepoWork, type TicketRef } from '@mag/core'
import type { Tone } from './ui/tones.ts'

export type LinkService = 'github'

export interface ServiceInfo {
  name: string
  /** SVG path of the logo, 24×24 viewBox (Simple Icons, CC0). */
  icon: string
}

export const LINK_SERVICES: Record<LinkService, ServiceInfo> = {
  github: {
    name: 'GitHub',
    icon: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
}

/** A PR as its pill shows it: an open draft is its own state here. */
export type PrPillState = 'open' | 'draft' | 'merged' | 'closed'

/** A PR state's Pill tone: open green, draft grey, merged accent, closed red. */
export const PR_STATE_TONES: Record<PrPillState, Tone> = { open: 'green', draft: 'grey', merged: 'acc', closed: 'red' }

/** The pill state of a repo's PR; null while it has not been checked. */
export function prPillState(r: Pick<RepoWork, 'prState' | 'prDraft'>): PrPillState | null {
  if (r.prState === 'open' && r.prDraft) return 'draft'
  return r.prState
}

/** "#34" from a GitHub pull request URL. */
export const prNumber = (url: string) => `#${url.match(/\/pull\/(\d+)/)?.[1] ?? '?'}`

/** "owner/repo" from a GitHub pull request URL, or null. */
export const prRepo = (url: string) => url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? null

const COPY_HINT = '⌥-click copies the link'

/** Tooltip of a PR pill: name, repository and state, URL. */
export function prTooltip(r: Pick<RepoWork, 'prUrl' | 'prState' | 'prDraft'>): string {
  const url = r.prUrl ?? ''
  return [`PR ${prNumber(url)}`, [prRepo(url) ?? LINK_SERVICES.github.name, prPillState(r) ?? 'not checked yet'].join(' · '), url, COPY_HINT].join('\n')
}

/** Tooltip of a ticket pill (T-55.5: only a link): its key when known, the URL. */
export function ticketTooltip(t: TicketRef): string {
  return [...(t.key ? [t.key] : []), t.url, COPY_HINT].join('\n')
}

export { ticketLabel }
