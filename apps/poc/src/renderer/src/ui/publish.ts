import type { IconName } from './icons'
import type { Tone } from './tones'

/** Where a write goes: a Slack channel, a Jira ticket, a PR comment, a doc. */
export interface PublishDestination {
  icon: IconName
  name: string
  /** The service, e.g. Slack; shown before the name. */
  service?: string
  /** What is published can't be edited after (a Slack message, a Jira comment). */
  final?: boolean
}

/** A rule of the destination, e.g. "append only"; `met` false when the preview breaks it, absent when not checked. */
export interface PublishRule {
  text: string
  met?: boolean
}

/** The rules' summary pill: how many of the checked rules the preview meets; null when none is checked. */
export function rulesSummary(rules: PublishRule[]): { text: string; tone: Tone } | null {
  const checked = rules.filter((r) => r.met !== undefined)
  if (!checked.length) return null
  const met = checked.filter((r) => r.met).length
  return { text: `${met} / ${checked.length} met`, tone: met === checked.length ? 'green' : 'red' }
}

/** A pill's tone for one rule: red when broken, grey otherwise. */
export const ruleTone = (r: PublishRule): Tone => (r.met === false ? 'red' : 'grey')

/** One piece of a claim's evidence: a source ref (a PR, a file, a message) and the query that found it. */
export interface Evidence {
  source: string
  query?: string
}

/** verified: its evidence backs it; unverified: the check found nothing that does (red). */
export type ClaimStatus = 'verified' | 'unverified'

/** What a claim's hover says when it has no evidence. */
export const noEvidenceNote = (status: ClaimStatus): string => (status === 'unverified' ? 'No source: unverified.' : 'No source given.')
