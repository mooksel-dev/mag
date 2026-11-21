// The claims ledger's mechanical check (deliverables-library-claims-review-and.2): mag's, not the agent's word. Every
// claim has refs, a count has its query, every ref resolves, and a claim about a person cites a primary source (a PR, a
// ticket, a message, a transcript time).
import { CLAIM_KINDS, type Claim, type ClaimCheck, type ClaimKind } from './types.ts'

/** What a ref is; meeting, topic and file refs resolve through the app (RefResolver). */
export type RefKind = 'url' | 'pr' | 'ticket' | 'message' | 'dlv' | 'meeting' | 'transcript' | 'topic' | 'file'

/** Resolves the refs only the app can: null when it does, else why not. */
export type RefResolver = (kind: 'meeting' | 'transcript' | 'topic' | 'file', ref: string) => string | null

/** A claim as an agent passes it to set_claims. */
export interface ClaimInput {
  id?: string
  text: string
  kind: string
  refs?: string[]
  query?: string | null
  person?: string | null
}

/** set_claims' answer: every claim with its check, and the ones that failed. */
export interface ClaimsCheck {
  claims: Claim[]
  failed: Claim[]
}

const PRIMARY: RefKind[] = ['pr', 'ticket', 'message', 'transcript']

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/(?:pull\/\d+|commit\/[0-9a-f]{7,40}|issues\/\d+)(?:[/?#]\S*)?$/i
const TICKET_URL = /^https?:\/\/\S+\/(?:browse|issue)\/[A-Z][A-Z0-9]+-\d+(?:[/?#]\S*)?$/i
const MESSAGE_URL = /^https?:\/\/[^/\s]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+\S*$/i

/** What `ref` is, or null when mag can't tell. */
export function refKind(ref: string): RefKind | null {
  const r = ref.trim()
  if (/^https?:\/\//i.test(r)) {
    if (!URL.canParse(r)) return null
    if (PR_URL.test(r)) return 'pr'
    if (TICKET_URL.test(r)) return 'ticket'
    if (MESSAGE_URL.test(r)) return 'message'
    return 'url'
  }
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(r)) return 'pr'
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(r)) return 'ticket'
  if (/(^|:)dlv:[\p{L}\p{N}][\p{L}\p{N}-]*$/u.test(r)) return 'dlv'
  if (/^mtg:[^@\s]+@\d{1,2}:\d{2}(:\d{2})?$/.test(r)) return 'transcript'
  if (/^mtg:[^@\s]+$/.test(r)) return 'meeting'
  if (/^topic:\S+$/.test(r)) return 'topic'
  if (r.startsWith('/')) return 'file'
  return null
}

export const isPrimary = (kind: RefKind | null) => !!kind && PRIMARY.includes(kind)

const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * The claims of a version from set_claims' input, each checked. `md`: the version's text, which holds every claim's
 * span; `people`: the deliverable is about people, so every claim is about a person; `resolve`: whether a ref resolves
 * (null) or why not. Throws on input that is not a ledger (a span not in the text, an unknown kind, a repeated id).
 */
export function checkClaims(inputs: ClaimInput[], md: string, people: boolean, resolve: (kind: RefKind, ref: string) => string | null): Claim[] {
  const ids = new Set<string>()
  const errors: string[] = []
  const claims = inputs.map((c, i) => {
    const text = typeof c.text === 'string' ? c.text.trim() : ''
    const id = clean(c.id) ?? `c${i + 1}`
    if (ids.has(id)) errors.push(`claim id ${id} is repeated`)
    ids.add(id)
    if (!text) errors.push(`claim ${id} has no text`)
    else if (!md.includes(text)) errors.push(`claim ${id}: "${text.slice(0, 80)}" is not in the version's text; pass the exact span`)
    if (!(CLAIM_KINDS as readonly string[]).includes(c.kind)) errors.push(`claim ${id}: kind must be one of ${CLAIM_KINDS.join(', ')}`)
    const refs = [...new Set((Array.isArray(c.refs) ? c.refs : []).map(clean).filter((r): r is string => !!r))]
    const claim: Claim = { id, text, kind: c.kind as ClaimKind, refs, query: clean(c.query), person: clean(c.person), check: 'ok', why: null }
    return claim
  })
  if (errors.length) throw new Error(`Not a claims ledger:\n- ${errors.join('\n- ')}`)
  for (const c of claims) Object.assign(c, check(c, people, resolve))
  return claims
}

function check(c: Claim, people: boolean, resolve: (kind: RefKind, ref: string) => string | null): { check: ClaimCheck; why: string | null } {
  if (!c.refs.length) return { check: 'missing_ref', why: 'No refs: cite what backs it.' }
  if (c.kind === 'count' && !c.query) return { check: 'no_query', why: 'A count needs the command or JQL that produced it.' }
  const unresolved = c.refs.flatMap((r) => {
    const kind = refKind(r)
    if (!kind) return [`${r}: not a ref mag can check (a URL, owner/repo#N, ABC-12, dlv:<slug>, mtg:<id>@<hh:mm:ss>, topic:<id> or an absolute path)`]
    const why = resolve(kind, r)
    return why ? [`${r}: ${why}`] : []
  })
  if (unresolved.length) return { check: 'unresolved', why: unresolved.join('; ') }
  if ((people || c.person) && !c.refs.some((r) => isPrimary(refKind(r))))
    return { check: 'weak_source', why: `About ${c.person ?? 'a person'}: cite a primary source (a PR, a ticket, a message or a transcript time), not only summaries.` }
  return { check: 'ok', why: null }
}
