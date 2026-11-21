import { sessionTree, type SessionHeader } from '@mag/core'
import type { AppState } from '../../preload/api'
import type { Claim, Deliverable, DeliverableState, Verdict, VersionVerdict } from '../../main/core/services/deliverables/types.ts'

/** The deliverables of a topic (deliverables-library-claims-review-and.1): made in it or below it, newest first. */
export function topicDeliverables(topic: SessionHeader | null, state: Pick<AppState, 'sessions' | 'deliverables'>): Deliverable[] {
  if (!topic) return []
  const ids = new Set(sessionTree(topic.id, state.sessions).map((s) => s.id))
  return (state.deliverables ?? []).filter((d) => !!d.topicId && ids.has(d.topicId)).sort((a, b) => b.updatedAt - a.updatedAt)
}

export const DELIVERABLE_STATE_LABELS: Record<DeliverableState, string> = { draft: 'draft', in_review: 'in review', final: 'final', published: 'published' }
export const DELIVERABLE_STATE_TONES: Record<DeliverableState, 'grey' | 'amber' | 'green' | 'blue'> = { draft: 'grey', in_review: 'amber', final: 'green', published: 'blue' }

export interface DiffLine {
  op: 'same' | 'add' | 'del'
  text: string
}

/** Above this many line pairs the diff is the old text out and the new one in: an LCS would take too long. */
const MAX_CELLS = 4_000_000

const linesOf = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : [])

/** The lines from `before` to `after`: an LCS diff, deletions before additions at each change. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before)
  const b = linesOf(after)
  if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))]
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ op: 'same', text: a[i++] }), j++
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: 'del', text: a[i++] })
    else out.push({ op: 'add', text: b[j++] })
  }
  while (i < a.length) out.push({ op: 'del', text: a[i++] })
  while (j < b.length) out.push({ op: 'add', text: b[j++] })
  return out
}

/** Where claim i sits in the markdown placeClaims returns; marked keeps it as text. */
export const CLAIM_MARK = /\u2063(\d+)\u2063/g
const mark = (i: number) => `\u2063${i}\u2063`

/** The ranges of fenced code blocks: a claim's span is never looked for inside one. */
function fences(md: string): [number, number][] {
  const out: [number, number][] = []
  const re = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm
  for (let m = re.exec(md); m; m = re.exec(md)) out.push([m.index, m.index + m[0].length])
  return out
}

/**
 * The markdown with each claim's first span (outside code) replaced by its mark, and the claims not found: their span
 * changed, crosses paragraphs, or overlaps one placed before.
 */
export function placeClaims(md: string, claims: Claim[]): { md: string; unplaced: Claim[] } {
  let out = md
  const unplaced: Claim[] = []
  claims.forEach((c, i) => {
    const code = fences(out)
    // An inline mark can't span paragraphs.
    let at = c.text && !/\n\s*\n/.test(c.text) ? out.indexOf(c.text) : -1
    while (at >= 0 && code.some(([a, b]) => at < b && at + c.text.length > a)) at = out.indexOf(c.text, at + 1)
    if (at < 0) return void unplaced.push(c)
    out = out.slice(0, at) + mark(i) + out.slice(at + c.text.length)
  })
  return { md: out, unplaced }
}

/** A claim's span as plain text: its emphasis, code and link marks dropped. */
export const plainSpan = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|\*|_|`)/g, '')

/** Red when mag's check fails or the verifier's blocker or should-fix is about it. */
export function claimFails(c: Claim, verdict: VersionVerdict | null | undefined): boolean {
  return c.check !== 'ok' || !!verdict?.findings.some((f) => f.claimId === c.id && (f.level === 'blocker' || f.level === 'should_fix'))
}

/** Every non-alphanumeric ASCII character as an entity, so neither markdown nor HTML reads the text. */
const literal = (s: string) => s.replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, (ch) => `&#${ch.codePointAt(0)};`)

/**
 * A claim as inline HTML around its own markdown span (ClaimMark, the markup of ui/Claim): underlined, its refs, query,
 * mag's check and the verifier's findings on hover, red when it fails.
 */
export function claimMark(c: Claim, verdict: VersionVerdict | null | undefined): string {
  const ev = (cls: string, html: string) => `<span class="${cls}">${html}</span>`
  const pop = [
    ...(c.check !== 'ok' ? [ev('ev st', literal(`${c.check.replace('_', ' ')}: ${c.why ?? ''}`))] : []),
    ...(c.refs.length ? c.refs.map((r) => ev('ev', `<b>${literal(r)}</b>`)) : [ev('ev', 'No source given.')]),
    ...(c.query ? [ev('ev', `<code>${literal(c.query)}</code>`)] : []),
    ...(verdict?.findings.filter((f) => f.claimId === c.id).map((f) => ev(f.level === 'blocker' || f.level === 'should_fix' ? 'ev st' : 'ev', literal(`Verifier: ${f.text}`))) ?? []),
  ]
  return `<span class="claimhl${claimFails(c, verdict) ? ' bad' : ''}" tabindex="0" data-claim="${literal(c.id)}">${c.text}<span class="claimpop" role="tooltip">${pop.join('')}</span></span>`
}

/** The version's markdown with its claims marked (claimMark), and the claims whose span it no longer has. */
export function markClaims(md: string, claims: Claim[], verdict: VersionVerdict | null | undefined): { md: string; unplaced: Claim[] } {
  const placed = placeClaims(md, claims)
  return { md: placed.md.replace(CLAIM_MARK, (_, i: string) => claimMark(claims[Number(i)], verdict)), unplaced: placed.unplaced }
}

export const VERDICT_LABELS: Record<Verdict, string> = { publish: 'Publish', changes: 'Changes', look: 'Look' }
export const VERDICT_TONES: Record<Verdict, 'green' | 'red' | 'amber'> = { publish: 'green', changes: 'red', look: 'amber' }
