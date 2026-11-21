// save_deliverable, list_deliverables and read (deliverables-library-claims-review-and.1): every role saves results
// for the user and reads them back by ref.
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DESTINATION_LABELS, type Destination, type DestinationKind } from '@mag/core'
import type { AgentSession, FindingLevel } from '@mag/core'
import { currentVersion, isKind, type Claim, type ClaimInput, type Deliverable, type DeliverableState, type Deliverables, type Origin, type RefResolver } from './core/services/deliverables/index.ts'
import type { Meetings } from './core/services/meetings/index.ts'
import type { Store } from './store'

const KINDS = Object.keys(DESTINATION_LABELS) as DestinationKind[]
const STATES: DeliverableState[] = ['draft', 'in_review', 'final', 'published']

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : undefined)

function destinationArg(v: unknown): Destination | undefined {
  if (v === undefined || v === null) return undefined
  const o = v as { kind?: unknown; target?: unknown }
  if (typeof o !== 'object' || !KINDS.includes(o.kind as DestinationKind)) throw new Error(`destination.kind must be one of ${KINDS.join(', ')}`)
  const kind = o.kind as DestinationKind
  const target = text(o.target) ?? ''
  return { kind, target, label: target ? `${DESTINATION_LABELS[kind]} ${target}` : DESTINATION_LABELS[kind] }
}

/** The version's text: md, else the file at `file`. */
function mdArg(args: Record<string, unknown>): string {
  if (typeof args.md === 'string' && args.md.trim()) return args.md
  const file = text(args.file)
  if (!file) throw new Error('Pass md (the version as markdown) or file (an absolute path of one)')
  if (!isAbsolute(file)) throw new Error(`file must be an absolute path: ${file}`)
  return readFileSync(file, 'utf8')
}

const line = (dlv: Deliverables, d: Deliverable) =>
  `- ${dlv.refOf(d)} · ${d.kind} · ${d.title} · ${d.state}${d.finalVersion ? ` · final v${d.finalVersion}` : ''} · v${d.versions.map((v) => v.n).join(', v')}${d.labels.length ? ` · labels ${d.labels.join(', ')}` : ''}`

export function deliverableTool(dlv: Deliverables | undefined, origin: Origin, name: 'save_deliverable' | 'list_deliverables' | 'read', args: Record<string, unknown>): string {
  if (!dlv) throw new Error('Deliverables are not ready yet')
  if (name === 'save_deliverable') {
    const ref = text(args.ref)
    const saved = dlv.save({ ref, kind: text(args.kind), title: text(args.title), md: mdArg(args), labels: strings(args.labels), destination: destinationArg(args.destination) }, origin)
    return `Saved ${saved.ref} v${saved.n} (${saved.deliverable.state}): ${saved.path}. The user sees it in the topic's panel; save the next version with ref "${saved.ref}".`
  }
  if (name === 'list_deliverables') {
    const kind = text(args.kind)
    if (kind !== undefined && !isKind(kind)) throw new Error(`Not a kind: ${kind}`)
    const state = strings(args.state)?.filter((s): s is DeliverableState => STATES.includes(s as DeliverableState))
    const list = dlv.list({ workspaceId: origin.workspaceId, kind, state: state?.length ? state : undefined, labels: strings(args.labels), topicIds: args.topic === true ? (origin.topicId ? [origin.topicId] : []) : undefined })
    return list.length ? `${list.map((d) => line(dlv, d)).join('\n')}\n\nRead one with read(ref).` : 'No deliverables match.'
  }
  const ref = text(args.ref)
  if (!ref) throw new Error('Pass ref, e.g. dlv:weekly-report')
  if (!/(^|:)dlv:/.test(ref)) throw new Error(`read takes deliverable refs (<workspace>:dlv:<slug>); ${ref} is not one`)
  const d = dlv.resolve(ref, origin.workspaceId)
  const n = typeof args.version === 'number' ? args.version : currentVersion(d)
  const claims = d.versions.find((v) => v.n === n)?.claims
  return `${dlv.refOf(d)} v${n} · ${d.kind} · ${d.title} · ${d.state}${d.finalVersion ? ` · final v${d.finalVersion}` : ''}\n\n${dlv.read(d.id, n)}${claims?.length ? `\n\n## Claims (set_claims)\n${claimLines(claims)}` : ''}`
}

const claimLine = (c: Claim) =>
  `- ${c.id} [${c.kind}] "${c.text}"${c.person ? ` · about ${c.person}` : ''} · refs: ${c.refs.join(', ') || 'none'}${c.query ? ` · query: ${c.query}` : ''} · check: ${c.check}${c.why ? ` (${c.why})` : ''}`
const claimLines = (claims: Claim[]) => claims.map(claimLine).join('\n')

/** The verifier's first message: what to check and how it ends; a fresh one gets the text itself and no topic. */
export function verifierBrief(ref: string, d: Deliverable, n: number, md: string, claims: Claim[], fresh: boolean): string {
  const what = `${ref} v${n}, a ${d.kind} "${d.title}"`
  const ledger = claims.length ? claimLines(claims) : '(none recorded: the author says it states nothing to check)'
  const text = fresh
    ? `\n\nYou start without the topic's context on purpose: judge only from the text, its claims and their sources. Don't read the topic's chat.\n\n## The text (v${n})\n${md}`
    : `\n\nRead its text with read("${ref}", version ${n}).`
  return `Verify ${what} before the user marks it final.${text}

## Its claims, with mag's mechanical check
${ledger}

For every claim: open its refs and check they back the span as written; re-run each recorded query (read-only) and compare the result; a failed check is a finding. Then read the text for statements a reader would check that are not recorded as claims. Change nothing.
End with set_verdict(ref "${ref}", version ${n}): publish when every claim holds, changes with one finding per problem (claimId when it is about a claim), look when the user must decide (say why).`
}

/** set_claims, verify_deliverable, set_verdict (deliverables-library-claims-review-and.2). */
export function claimsTool(
  dlv: Deliverables | undefined,
  origin: Origin,
  sessionId: string | undefined,
  startVerifier: (topicId: string, fresh: boolean, brief: (fresh: boolean) => string) => { session: AgentSession; fresh: boolean },
  name: 'set_claims' | 'verify_deliverable' | 'set_verdict',
  args: Record<string, unknown>,
): string {
  if (!dlv) throw new Error('Deliverables are not ready yet')
  const ref = text(args.ref)
  if (!ref) throw new Error('Pass ref, e.g. dlv:weekly-report')
  const d = dlv.resolve(ref, origin.workspaceId)
  const full = dlv.refOf(d)
  const n = typeof args.version === 'number' ? args.version : (d.versions.at(-1)?.n ?? 0)
  if (name === 'set_claims') {
    if (!Array.isArray(args.claims)) throw new Error('Pass claims: a list ([] when the version states nothing to check)')
    const check = dlv.setClaims(d.id, n, args.claims as ClaimInput[])
    if (!check.claims.length) return `${full} v${n}: no claims recorded. verify_deliverable when it is ready for review.`
    return check.failed.length
      ? `${full} v${n}: ${check.failed.length} of ${check.claims.length} claims fail mag's check; fix the version or the refs and call set_claims again:\n${claimLines(check.failed)}`
      : `${full} v${n}: all ${check.claims.length} claims pass mag's check. verify_deliverable when it is ready for review.`
  }
  if (name === 'verify_deliverable') {
    const claims = dlv.claimsOf(d.id, n)
    if (!d.topicId) throw new Error(`${full} has no topic to verify it in`)
    const md = dlv.read(d.id, n)
    const started = startVerifier(d.topicId, d.sensitivity === 'people', (fresh) => verifierBrief(full, d, n, md, claims, fresh))
    dlv.beginVerify(d.id, n, started.session.id, started.fresh)
    return `Verifier ${started.session.id} started for ${full} v${n} (${started.fresh ? 'a fresh session without the topic\'s context' : 'a fork of its topic'}). Its verdict shows on the document; it reports to the topic.`
  }
  if (!sessionId) throw new Error('set_verdict needs the verifier\'s session')
  if (typeof args.version !== 'number') throw new Error('Pass version: the one you verified')
  const findings = (Array.isArray(args.findings) ? args.findings : []).map((f: { claimId?: unknown; text?: unknown; level?: unknown }) => ({
    claimId: text(f.claimId) ?? null,
    text: text(f.text) ?? '',
    level: f.level as FindingLevel,
  }))
  const after = dlv.setVerdict(d.id, n, { verdict: String(args.verdict ?? ''), findings }, sessionId)
  return `Verdict ${args.verdict} on ${full} v${n} recorded (${after.state}); the user sees it on the document. Report it to the topic in a few lines.`
}

/**
 * The claim refs only the app resolves: a meeting (mtg:<id>), a time in its transcript (mtg:<id>@<hh:mm[:ss]>), a
 * topic (topic:<id>) and a file (an absolute path).
 */
export function claimRefResolver(store: Pick<Store, 'data'>, meetings: Pick<Meetings, 'read'> | undefined): RefResolver {
  return (kind, ref) => {
    if (kind === 'topic') return store.data.sessions.some((s) => s.id === ref.slice('topic:'.length)) ? null : 'no such topic'
    if (kind === 'file') return existsSync(ref) ? null : 'no such file'
    if (!meetings) return 'meetings are not ready yet'
    const [id, time] = ref.slice('mtg:'.length).split('@')
    let transcript: string
    try {
      transcript = meetings.read(id).transcript
    } catch {
      return 'no such meeting'
    }
    if (kind === 'meeting' || !time) return null
    const at = time.split(':').map((p) => p.padStart(2, '0')).join(':')
    return transcript.includes(`[${at}`) ? null : `no transcript line at ${time}`
  }
}
