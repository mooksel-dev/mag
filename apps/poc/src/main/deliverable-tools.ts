// save_deliverable, list_deliverables and read (deliverables-library-claims-review-and.1): every role saves results
// for the user and reads them back by ref.
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DESTINATION_LABELS, type Destination, type DestinationKind } from '@mag/core'
import { currentVersion, isKind, type Deliverable, type DeliverableState, type Deliverables, type Origin } from './core/services/deliverables/index.ts'

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
  return `${dlv.refOf(d)} v${n} · ${d.kind} · ${d.title} · ${d.state}${d.finalVersion ? ` · final v${d.finalVersion}` : ''}\n\n${dlv.read(d.id, n)}`
}
