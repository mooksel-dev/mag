// The conversation's cards as one shape (redesign-start-screen-big-composer.4): a title, a verdict chip, 2–5 short rows
// with tags, folded details and buttons, built from data mag already has (a step's agent review, its PR health, its
// plan ↔ fact; an integration the agent asked for). No raw machine text: the threshold's phrases become tagged rows.
// Also folds runs of events in a chat (tools, mag's notices and jobs) into one thin line.
import type { AgentReview, AgentRole, ChatItem, RepoWork, ReviewFinding, StepFact, Task } from '@mag/core'
import type { CompareStatus } from '@mag/diff/types'
import type { FactView } from '../../preload/api'
import { prName } from './format.ts'

export type CardTag = 'as planned' | 'otherwise' | 'not done' | 'new' | 'check by hand'
export type Tone = 'good' | 'warn' | 'bad' | 'neutral'

export interface CardRow {
  tag?: CardTag
  /** Bold lead of the row: a module, a file:line. */
  lead?: string
  text: string
}

export type CardButton =
  | { kind: 'open_pr'; label: string; url: string; primary?: boolean }
  | { kind: 'fact'; label: string; canvasId: string }
  | { kind: 'review_window'; label: string; taskId: string }
  | { kind: 'enable'; label: string; mode: 'ask' | 'reads' | 'auto'; primary?: boolean }

export interface CardModel {
  title: string
  /** The card's frame: good (as planned, enabled), warn (look), bad (changes), neutral. */
  tone: Tone
  verdict: { label: string; tone: Tone } | null
  /** One line of short facts: "CI passes", "merges cleanly". */
  stats: string[]
  rows: CardRow[]
  /** Folded under the rows: each opens to its lines. */
  details: { summary: string; lines: string[] }[]
  buttons: CardButton[]
  /** A muted line in the footer. */
  note?: string
}

/** Rows a card shows; the rest fold into its details. */
export const MAX_ROWS = 5

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Step 4" for the key x.4, else the key. */
export function stepLabel(step: Pick<Task, 'key'>): string {
  const n = /\.(\d+)$/.exec(step.key)?.[1]
  return n ? `Step ${n}` : step.key
}

/** The tag of a plan ↔ fact status. */
export const FACT_TAG: Record<CompareStatus, CardTag> = { match: 'as planned', differs: 'otherwise', missing: 'not done', unplanned: 'new' }

const TAG_WEIGHT: Record<CardTag, number> = { 'not done': 5, otherwise: 4, 'check by hand': 4, new: 3, 'as planned': 1 }
const LEVEL_WEIGHT: Record<string, number> = { blocker: 6, should_fix: 5, question: 4 }

type Weighted = CardRow & { weight: number }

const strip = ({ weight: _, ...r }: Weighted): CardRow => r

/** The heaviest MAX_ROWS rows, in their own order; the rest to fold. */
function cut(rows: Weighted[]): { rows: CardRow[]; rest: CardRow[] } {
  if (rows.length <= MAX_ROWS) return { rows: rows.map(strip), rest: [] }
  const keep = new Set(rows.map((r, i) => ({ r, i })).sort((a, b) => b.r.weight - a.r.weight || a.i - b.i).slice(0, MAX_ROWS).map((x) => x.i))
  return { rows: rows.filter((_, i) => keep.has(i)).map(strip), rest: rows.filter((_, i) => !keep.has(i)).map(strip) }
}

const rowLine = (r: CardRow) => `${r.tag ? `${r.tag}: ` : ''}${r.lead ? `${r.lead} — ` : ''}${r.text}`

/** A PR's health in short facts: its CI and whether it merges; prefixed by the PR when there are several. */
export function prStats(prs: Pick<RepoWork, 'prUrl' | 'prState' | 'ci' | 'mergeable'>[]): string[] {
  const open = prs.filter((r) => r.prUrl && r.prState === 'open')
  return open.flatMap((r) => {
    const pre = open.length > 1 ? `${prName(r.prUrl!)}: ` : ''
    const ci = r.ci === 'pass' ? 'CI passes' : r.ci === 'fail' ? 'CI fails' : r.ci === 'pending' ? 'CI running' : r.ci === 'none' ? 'no CI checks' : null
    const merge = r.mergeable === 'clean' ? 'merges cleanly' : r.mergeable === 'conflict' ? 'conflicts with base' : null
    return [ci, merge].filter((x): x is string => !!x).map((x) => pre + x)
  })
}

/** A recorded fact's counts as tagged rows: done as planned, otherwise, not at all, off the plan; what the inventory leaves out. */
function factCountRows(c: StepFact['counts']): Weighted[] {
  const rows: Weighted[] = []
  const add = (n: number | undefined, tag: CardTag, text: string) => n && rows.push({ tag, text, weight: TAG_WEIGHT[tag] })
  add(c.missing, 'not done', `${plural(c.missing, 'plan change')} not done`)
  add(c.differs, 'otherwise', `${plural(c.differs, 'plan change')} done otherwise`)
  add(c.unplanned, 'new', `${plural(c.unplanned, 'change')} not on the plan`)
  add(c.unaccounted, 'check by hand', `${plural(c.unaccounted, 'block')} of changed code the inventory does not name`)
  add(c.ungrounded, 'check by hand', `${plural(c.ungrounded, 'unit')} of the inventory the hunks do not bear out`)
  add(c.match, 'as planned', `${plural(c.match, 'plan change')} done as planned`)
  return rows
}

const findingRow = (f: ReviewFinding): Weighted => ({ tag: 'check by hand', lead: f.where || undefined, text: f.text, weight: LEVEL_WEIGHT[f.level ?? 'question'] ?? 4 })

/**
 * The merge card of a step whose PRs wait for the user (ready_to_merge / review_look): the agent review's verdict, the
 * PRs' health, plan ↔ fact as tagged rows and the review's findings to check by hand; minor notes and the overflow fold.
 * `step`: null for a legacy work without steps; `prs`: the PRs to open.
 */
export function mergeCard({ step, review, fact, look, prs }: {
  step: Pick<Task, 'id' | 'key' | 'title'> | null
  review?: Pick<AgentReview, 'verdict' | 'findings' | 'withContext'>
  fact?: Pick<StepFact, 'counts' | 'canvasId'> | null
  look: boolean
  prs: Pick<RepoWork, 'prUrl' | 'prState' | 'ci' | 'mergeable'>[]
}): CardModel {
  const changes = review?.verdict === 'changes'
  const what = changes ? 'changes asked' : look ? 'look before merging' : 'ready to merge'
  const title = step ? `${stepLabel(step)} · ${step.title} — ${what}` : what[0].toUpperCase() + what.slice(1)
  const findings = review?.findings ?? []
  const notes = findings.filter((f) => f.level === 'nit')
  const { rows, rest } = cut([...(fact ? factCountRows(fact.counts) : []), ...findings.filter((f) => f.level !== 'nit').map(findingRow)])
  const details = [
    ...(notes.length ? [{ summary: `${plural(notes.length, 'minor note')} from the agent review`, lines: notes.map((f) => rowLine({ lead: f.where, text: f.text })) }] : []),
    ...(rest.length ? [{ summary: `${rest.length} more`, lines: rest.map(rowLine) }] : []),
  ]
  const open = prs.filter((r) => r.prUrl && r.prState === 'open').map((r) => r.prUrl!)
  const buttons: CardButton[] = [
    ...open.map((url): CardButton => ({ kind: 'open_pr', label: open.length > 1 ? `${prName(url)} ↗` : 'Open PR ↗', url, primary: true })),
    ...(fact?.canvasId ? [{ kind: 'fact' as const, label: 'Plan ↔ fact', canvasId: fact.canvasId }] : []),
    ...(step ? [{ kind: 'review_window' as const, label: 'Open review window', taskId: step.id }] : []),
  ]
  const verdict = review ? ({ label: review.verdict, tone: review.verdict === 'merge' ? 'good' : review.verdict === 'look' ? 'warn' : 'bad' } as const) : null
  return {
    title,
    tone: changes ? 'bad' : look ? 'warn' : 'good',
    verdict,
    stats: prStats(prs),
    rows: rows.length ? rows : [{ text: review ? `${review.withContext ? 'Owner' : 'Reviewer'} review found nothing to check` : 'No agent review of these PRs yet' }],
    details,
    buttons,
    note: 'Merge it yourself on GitHub; mag sees the merge and goes on. Comments on the PR go back to the developer.',
  }
}

/**
 * Plan ↔ fact of a step (or the fact of a review's PR, `review`) as a card: its deviations as tagged rows, what the
 * inventory leaves out to check by hand; additions, changes outside the plan and the matches fold. `merged`: no merge
 * left to allow, so the verdict only counts.
 */
export function factCard(
  step: Pick<Task, 'key' | 'title'> & { review?: boolean },
  view: Pick<FactView, 'items' | 'additions' | 'outsidePlan' | 'check' | 'inventory'>,
  merged = false,
): CardModel {
  const deviations = view.items.filter((i) => i.status !== 'match')
  const matches = view.items.filter((i) => i.status === 'match')
  const check = view.check
  const ungrounded = check ? check.ungrounded.length + check.unknown.length + check.otherModule.length : 0
  const hand: Weighted[] = [
    ...(check?.unaccounted.length ? [{ tag: 'check by hand' as const, text: `${plural(check.unaccounted.length, 'block')} of changed code the inventory does not name`, weight: 5 }] : []),
    ...(ungrounded ? [{ tag: 'check by hand' as const, text: `${plural(ungrounded, 'unit')} the hunks do not bear out`, weight: 5 }] : []),
    ...(!view.inventory ? [{ tag: 'check by hand' as const, text: 'No inventory of the changes yet', weight: 5 }] : []),
  ]
  const { rows, rest } = cut([
    ...deviations.map((i): Weighted => {
      const tag = FACT_TAG[i.status]
      return { tag, text: i.phrase, weight: TAG_WEIGHT[tag] }
    }),
    ...hand,
  ])
  const details = [
    ...(rest.length ? [{ summary: `${rest.length} more`, lines: rest.map(rowLine) }] : []),
    ...view.additions.map((a) => ({ summary: a.line, lines: a.changes.map((c) => `${c.diff} ${c.kind === 'call' ? c.key.split(' -> ')[1] : c.name}`) })),
    ...(view.outsidePlan.modules.length ? [{ summary: view.outsidePlan.line, lines: view.outsidePlan.modules.map((m) => `${m.module}: ${plural(m.changes.length, 'change')}`) }] : []),
    ...(matches.length && deviations.length ? [{ summary: `${matches.length} as planned`, lines: matches.map((i) => i.phrase) }] : []),
  ]
  const covered = !hand.length
  const verdict = step.review
    ? ({ label: covered ? 'covers the PR' : 'does not cover the PR yet', tone: covered ? 'good' : 'warn' } as const)
    : deviations.length
      ? ({ label: `${plural(deviations.length, 'deviation')}${merged ? '' : ': look'}`, tone: merged ? 'neutral' : 'warn' } as const)
      : ({ label: matches.length ? `${matches.length} as planned` : 'as planned', tone: 'good' } as const)
  return {
    title: step.review ? 'Fact of the PR' : `${stepLabel(step)} · Plan ↔ fact`,
    tone: verdict.tone,
    verdict,
    stats: [],
    rows: rows.length ? rows : [{ text: view.items.length || view.additions.length ? 'No deviations from the plan' : 'Neither the plan nor the fact draws a change' }],
    details,
    buttons: [],
  }
}

export type IntegrationItem = Extract<ChatItem, { kind: 'integration' }>

/**
 * The card of an agent's request_integration: "<name> is off for the <role> role" with what the agent wants it for and
 * Enable: Ask / Auto (`canAsk` false: Auto only, the run has no chat to ask in); once enabled, its mode.
 */
export function integrationCard(item: Pick<IntegrationItem, 'server' | 'role' | 'why' | 'status'>, canAsk: boolean): CardModel {
  const on = item.status !== 'off'
  return {
    title: `${item.server} is ${on ? 'on' : 'off'} for the ${item.role} role`,
    tone: on ? 'good' : 'warn',
    verdict: on ? { label: `on · ${item.status}`, tone: 'good' } : { label: 'off', tone: 'warn' },
    stats: [],
    rows: item.why ? [{ lead: 'The agent wants it to', text: item.why }] : [],
    details: [],
    buttons: on ? [] : canAsk
      ? [{ kind: 'enable', label: 'Enable: reads auto, writes ask', mode: 'reads', primary: true }, { kind: 'enable', label: 'Ask each', mode: 'ask' }, { kind: 'enable', label: 'Auto', mode: 'auto' }]
      : [{ kind: 'enable', label: 'Auto', mode: 'auto', primary: true }],
    note: on
      ? 'The agent repeats its last step with it.'
      : `${canAsk ? 'Reads auto: reads run, posts and changes wait for you. Ask each: every call waits. ' : ''}Auto: all allowed. Saved in Project → Integrations for every ${item.role} run.`,
  }
}

/** Whether the integration card of a role can offer Ask: the architect has no chat to ask in. */
export const canAskFor = (role: AgentRole) => role !== 'architect'

/** Chat items that are events, not conversation: tool calls, mag's notices and jobs, a turn's ok end. */
export type EventItem = Extract<ChatItem, { kind: 'tool' | 'notice' | 'job' | 'result' }>

const isEvent = (i: ChatItem): i is EventItem => i.kind === 'tool' || i.kind === 'notice' || i.kind === 'job' || (i.kind === 'result' && i.ok)

export type ConversationLine =
  | { kind: 'item'; n: number; item: ChatItem }
  /** A run of events as one line: "▸ x.3 started · PR ready · update_doc ×2". `mark`: a failed or running tool shows through. */
  | { kind: 'events'; n: number; items: { n: number; item: EventItem }[]; label: string; mark: '' | '✗' | '…' }

/** Parts of an event line before it says "+N more". */
const LINE_PARTS = 4

/** One label part per event, in order: a job's title, a notice, a tool's name; repeats as "×N". */
function eventLabel(items: EventItem[]): string {
  const parts = new Map<string, number>()
  for (const i of items) {
    const p = i.kind === 'tool' ? i.name.replace(/^mcp__mag__/, '') : i.kind === 'job' ? i.title : i.kind === 'notice' ? i.text : null
    if (p) parts.set(p, (parts.get(p) ?? 0) + 1)
  }
  const all = [...parts].map(([p, k]) => (k > 1 ? `${p} ×${k}` : p))
  return all.length > LINE_PARTS ? `${all.slice(0, LINE_PARTS - 1).join(' · ')} · +${all.length - LINE_PARTS + 1} more` : all.join(' · ')
}

/**
 * A chat's items as lines: runs of events (tools, notices, jobs) fold into one line each; everything else (messages,
 * replies, canvases, approvals, integration cards, errors, a failed turn) stays a line of its own. A run of only ok
 * turn ends shows nothing.
 */
export function foldEvents(items: ChatItem[]): ConversationLine[] {
  const lines: ConversationLine[] = []
  items.forEach((item, n) => {
    const last = lines[lines.length - 1]
    if (!isEvent(item)) lines.push({ kind: 'item', n, item })
    else if (last?.kind === 'events') last.items.push({ n, item })
    else lines.push({ kind: 'events', n, items: [{ n, item }], label: '', mark: '' })
  })
  return lines.flatMap((l): ConversationLine[] => {
    if (l.kind === 'item') return [l]
    const shown = l.items.map((x) => x.item)
    if (shown.every((i) => i.kind === 'result')) return []
    const tools = shown.filter((i): i is Extract<EventItem, { kind: 'tool' }> => i.kind === 'tool')
    const mark = tools.some((t) => t.ok === false) ? '✗' : tools.some((t) => t.ok === undefined) ? '…' : ''
    return [{ ...l, label: eventLabel(shown), mark }]
  })
}
