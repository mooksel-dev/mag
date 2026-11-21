import { sessionTree, type SessionHeader } from '@mag/core'
import type { AppState } from '../../preload/api'
import type { Deliverable, DeliverableState } from '../../main/core/services/deliverables/types.ts'

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
