// The review window as a view model (review-v2-part-2-v1-2.2): which blocks the page shows in which order, the diagram
// sets it draws inline, the inventory its hunks expand from and the full diff by change. Pure, so a test covers what the
// page renders without a DOM.
import { diffByChange, isIssuesReport, isReview, setOf, shownResult, type ChangeGroup, type ChangeInventory, type ReportKind, type ReviewReport, type ReviewResult, type Task } from '@mag/core'
import type { FileChange } from '@mag/diff/types'
import type { AppState, FactView } from '../../preload/api'

type StateCanvas = AppState['canvases'][number]
type DiagramCanvas = StateCanvas & { diagram: NonNullable<StateCanvas['diagram']> }

/**
 * A block of the window, in page order. An issues report's (review-v3-concise-design-first.1): intent with the verdict,
 * issues, acceptance, verified and not checked, the direction. A legacy report's: the verdict strip, the direction card,
 * the four question cards, the changes table. Then a step's plan ↔ fact; a v1 result's or an old review's own text
 * (legacy); the diagrams inline; the report's conclusion; the full diff, folded, as reference.
 */
export type WindowBlock = 'intent' | 'issues' | 'acceptance' | 'verified' | 'strip' | 'direction' | 'questions' | 'changes' | 'comparison' | 'legacy' | 'diagrams' | 'conclusion' | 'diff'

/** A set of diagrams the window draws inline, under its title. */
export interface InlineSet {
  title: string
  set: DiagramCanvas[]
  /** The diagram of the set it opens on. */
  current?: string
}

export interface ReviewWindowModel {
  kind: ReportKind
  /** The shown result of a PR's review (v1 or v2); none for a step. */
  result: ReviewResult | null
  report: ReviewReport | null
  blocks: WindowBlock[]
  sets: InlineSet[]
  /** The fact's inventory: what claims, nodes and change rows expand their hunks from. */
  inventory: ChangeInventory | null
  /** The full diff by change; empty until the fact view has loaded. */
  groups: ChangeGroup<FileChange>[]
}

const isDiagram = (c: StateCanvas): c is DiagramCanvas => c.kind === 'diagram' && !!c.diagram

/** Diagrams split into their sets, in the order they were drawn. */
export function setsOf(diagrams: DiagramCanvas[]): DiagramCanvas[][] {
  const out: DiagramCanvas[][] = []
  for (const d of diagrams) if (!out.some((s) => s.includes(d))) out.push(setOf(d, diagrams))
  return out
}

/**
 * The window of a task: a PR's review (its shown result: a v2 report, else the legacy layout) or a step (its agent
 * review's report, plan ↔ fact, its plan diagrams). The fact diagrams: an issues report's one diagram (its set, opened on
 * it), never the rest of the fact; a legacy report's whole fact set. `view` is the fact of its PRs, once loaded.
 */
export function reviewWindowModel(task: Task, canvases: AppState['canvases'], view: FactView | null | undefined): ReviewWindowModel {
  const pr = isReview(task)
  const result = pr ? shownResult(task.prReview) : null
  const report = (pr ? result?.report : task.review?.report) ?? null
  const diagrams = canvases.filter(isDiagram)
  const factOf = (c: DiagramCanvas) => c.role === 'fact' && (c.stepId ?? c.taskId) === task.id
  const fact = diagrams.filter(factOf)
  const plan = pr ? [] : diagrams.filter((c) => c.role === 'plan' && c.stepId === task.id)
  // A review's other diagrams (an older review's intent) show as their own sets.
  const rest = pr ? diagrams.filter((c) => c.taskId === task.id && !factOf(c)) : []
  const issues = isIssuesReport(report)
  const essence = issues && report.diagram ? diagrams.find((c) => c.id === report.diagram) : undefined
  const sets: InlineSet[] = [
    ...setsOf(plan).map((set) => ({ title: 'Plan', set })),
    ...(issues ? (essence ? [{ title: 'Diagram', set: setOf(essence, diagrams), current: essence.id }] : []) : [...setsOf(fact).map((set) => ({ title: 'Fact', set })), ...setsOf(rest).map((set) => ({ title: 'Other diagrams', set }))]),
  ]
  // The inventory of the fact the view was computed with, else of the fact set's root.
  const root = (view?.fact && fact.find((c) => c.id === view.fact!.id)) || fact.find((c) => c.root) || fact.find((c) => c.inventory)
  const inventory = root?.inventory ?? null
  const blocks: WindowBlock[] = [
    ...(issues ? (['intent', 'issues', 'acceptance', 'verified', 'direction'] as const) : report ? (['strip', 'direction', 'questions', 'changes'] as const) : []),
    ...(!pr ? (['comparison'] as const) : []),
    ...(pr && !report ? (['legacy'] as const) : []),
    ...(sets.length ? (['diagrams'] as const) : []),
    ...(report ? (['conclusion'] as const) : []),
    'diff',
  ]
  return { kind: pr ? 'pr' : 'step', result, report, blocks, sets, inventory, groups: view ? diffByChange(report, inventory, view.files) : [] }
}

/** A loaded hunk: its lines, null while loading, an error message. */
export type HunkLines = string[] | string | null

/** The hunk lines the window loaded for one fact view: a new view starts empty, so nothing waits on an old one. */
export interface HunkCache<V> {
  view: V
  lines: Map<string, HunkLines>
}

/** The cache for `view`: `prev` while the view is the same, else a fresh one. Called in render, so effects see it. */
export function hunkCacheFor<V>(prev: HunkCache<V> | null, view: V): HunkCache<V> {
  return prev && prev.view === view ? prev : { view, lines: new Map() }
}

/** Whether a hunk is to be fetched now: not asked for this view yet. It is then marked loading. */
export function askHunk(cache: HunkCache<unknown>, key: string): boolean {
  if (cache.lines.has(key)) return false
  cache.lines.set(key, null)
  return true
}

/** The hunks of a file of the full diff to render, and so to load: none while the file is folded. */
export const shownHunks = <T>(hunks: T[], open: boolean): T[] => (open ? hunks : [])
