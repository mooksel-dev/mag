import {
  isReview,
  sessionTree,
  setKey,
  setOf,
  setRoot,
  shortTitle,
  stepsLine,
  subtasksOf,
  taskDiagrams,
  workCanvases,
  type AgentSession,
  type StepLine,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'

/**
 * What a topic made (topics-a-tree-of-agent.3): the cards, docs, reviews and diagrams of the topic's tree and of the
 * works its sessions own. They show in the chat that made them and in the topic's artifacts list; each opens in the
 * screen's drawer. The list is by work, then by step (topic-screen-one-new-compact.1): a step is one line, its plan,
 * fact and review are chips on it; what the tree drew outside any work is "This chat".
 */

/**
 * What the drawer shows: a canvas (a diagram opens with its set), or a task's card, doc or review (a teammate's PR
 * review is its work's; an agent review of a step, the step's).
 */
export type ArtifactTarget = { kind: 'canvas'; id: string; focus?: string } | { kind: 'work' | 'doc' | 'review'; taskId: string }

/** One artifact on a work's or a step's line: doc, option A, plan, fact, review: look… */
export interface ArtifactChip {
  /** Unique within the list. */
  key: string
  label: string
  /** The tooltip: the artifact's title and its key. */
  title: string
  /** A review's verdict: merge green, look amber, changes red. */
  tone?: 'green' | 'amber' | 'red'
  open: ArtifactTarget
}

/** Where a step stands, as its line says. */
export type StepPhase = 'todo' | 'working' | 'in review' | 'merged' | 'done'

export interface StepArtifacts {
  step: Task
  /** 1-based. */
  no: number
  phase: StepPhase
  chips: ArtifactChip[]
}

/** A work (or a teammate's PR review) with the chips of its own line and its steps. */
export interface WorkArtifacts {
  work: Task
  /** Its card (a review's report). */
  open: ArtifactTarget
  chips: ArtifactChip[]
  steps: StepArtifacts[]
}

export interface TopicArtifacts {
  works: WorkArtifacts[]
  /** "This chat": canvases the tree made outside any work. */
  loose: ArtifactChip[]
  /** How many things open from the list: works, chips and loose canvases. */
  count: number
}

type ArtifactState = Pick<AppState, 'tasks' | 'sessions' | 'canvases' | 'docs'>
type CanvasItem = AppState['canvases'][number]

/**
 * The works a topic's tree owns, open ones first, then the newest: those a session of the tree owns, and the reviews
 * a session of it was made for (`reviewOf`).
 */
export function treeWorks(tree: AgentSession[], tasks: Task[]): Task[] {
  const ids = new Set(tree.map((s) => s.id))
  const done = (t: Task) => Number(t.status === 'done' || t.status === 'canceled')
  return tasks
    .filter((t) => !t.parentId && ((!!t.ownerSessionId && ids.has(t.ownerSessionId)) || tree.some((s) => s.reviewOf === t.id)))
    .sort((a, b) => done(a) - done(b) || b.createdAt - a.createdAt)
}

const PHASES: Record<StepLine['state'], StepPhase> = { done: 'done', merge: 'in review', build: 'working', waiting: 'todo', manual: 'todo', todo: 'todo' }

/** A step's phase: a done step with a merged PR is merged; one without code is done. */
function stepPhase(line: StepLine, step: Task): StepPhase {
  if (line.state === 'done') return step.work?.repos.some((r) => r.prState === 'merged') ? 'merged' : 'done'
  return PHASES[line.state]
}

const TONES = { merge: 'green', look: 'amber', changes: 'red' } as const

/** Chips of one line in this order: doc, options, plan, fact, other canvases, review; the order listed within a kind. */
const CHIP_ORDER = ['doc', 'option', 'plan', 'fact', 'canvas', 'review'] as const
type ChipKind = (typeof CHIP_ORDER)[number]

/** The chip of a canvas (a diagram set by its root): its role, else its title. */
function canvasChip(c: CanvasItem, count: number): { kind: ChipKind; chip: ArtifactChip } {
  const n = count > 1 ? ` · ${count} diagrams` : ''
  const title = `${c.title}${n}`
  const chip = (kind: ChipKind, label: string) => ({ kind, chip: { key: `canvas:${c.id}`, label, title, open: { kind: 'canvas', id: c.id } as ArtifactTarget } })
  if (c.kind === 'diagram' && c.role === 'option' && c.option) return chip('option', `option ${c.option}`)
  if (c.kind === 'diagram' && c.role === 'plan') return chip('plan', 'plan')
  if (c.kind === 'diagram' && c.role === 'fact') return chip('fact', 'fact')
  return chip('canvas', c.title)
}

/** By CHIP_ORDER; options by their letter. */
const byOrder = (a: { kind: ChipKind; chip: ArtifactChip }, b: { kind: ChipKind; chip: ArtifactChip }) =>
  CHIP_ORDER.indexOf(a.kind) - CHIP_ORDER.indexOf(b.kind) || (a.kind === 'option' && b.kind === 'option' ? a.chip.label.localeCompare(b.chip.label) : 0)

/**
 * The artifacts of `topic`'s tree (the topic, or a session under it, and everything below it) and of the works it owns,
 * by work (open ones first, then the newest) and then by step in order; `work`: a work shown without a topic (its owner
 * is its groomer, or nobody), listed alone or with the topic's. A diagram set is one chip (its root, else its first
 * diagram), on its step's line when it has a step of a listed work, else on its work's line (the work it belongs to, or
 * the one whose doc links it); a canvas listed by two works shows once.
 */
export function topicArtifacts(topic: AgentSession | null, state: ArtifactState, work: Task | null = null): TopicArtifacts {
  const empty: TopicArtifacts = { works: [], loose: [], count: 0 }
  const projectId = topic?.projectId ?? work?.projectId
  if (!projectId) return empty
  const tasks = state.tasks.filter((t) => t.projectId === projectId)
  const tree = topic ? sessionTree(topic.id, state.sessions) : []
  const works = treeWorks(tree, tasks)
  if (work && !works.some((w) => w.id === work.id)) works.push(work)
  const canvases = state.canvases.filter((c) => c.projectId === projectId)
  type Chips = { kind: ChipKind; chip: ArtifactChip }[]
  const lines = new Map<string, Chips>()
  const add = (id: string, c: Chips[number]) => lines.set(id, [...(lines.get(id) ?? []), c])
  const out: WorkArtifacts[] = []
  // Each canvas once, with the work that listed it first.
  const listed = new Map<CanvasItem, Task | null>()
  const list = (cs: CanvasItem[], by: Task | null) => cs.forEach((c) => { if (!listed.has(c)) listed.set(c, by) })
  for (const w of works) {
    const steps = isReview(w) ? [] : subtasksOf(w.id, tasks)
    const line = isReview(w) ? [] : stepsLine(w, tasks)
    if (!isReview(w) && state.docs[w.id]) add(w.id, { kind: 'doc', chip: { key: `doc:${w.id}`, label: 'doc', title: `Doc · ${w.key}`, open: { kind: 'doc', taskId: w.id } } })
    for (const step of steps) {
      const r = step.review
      if (r) add(step.id, { kind: 'review', chip: { key: `review:${step.id}`, label: `review: ${r.verdict}`, title: `Agent review of ${step.key} · round ${r.round}`, tone: TONES[r.verdict], open: { kind: 'review', taskId: step.id } } })
    }
    out.push({
      work: w,
      open: { kind: isReview(w) ? 'review' : 'work', taskId: w.id },
      chips: [],
      steps: steps.map((step, i) => ({ step, no: i + 1, phase: stepPhase(line[i], step), chips: [] })),
    })
    list(taskDiagrams(w, state.docs[w.id], canvases), w)
    list(workCanvases(w, canvases), w)
  }
  // What the tree drew outside any work.
  const ids = new Set(tree.map((s) => s.id))
  list(canvases.filter((c) => c.taskId === null && !!c.sessionId && ids.has(c.sessionId)), null)
  const loose: ArtifactChip[] = []
  const sets = new Set<string>()
  const lineOf = (c: CanvasItem, by: Task | null): string | null => {
    const step = c.stepId ? out.flatMap((w) => w.steps).find((s) => s.step.id === c.stepId) : undefined
    if (step) return step.step.id
    if (c.taskId && out.some((w) => w.work.id === c.taskId)) return c.taskId
    return by?.id ?? null
  }
  for (const [c, by] of listed) {
    const key = setKey(c)
    if (key && sets.has(key)) continue
    if (key) sets.add(key)
    const set = c.kind === 'diagram' && c.diagram ? setOf(c, canvases) : [c]
    const root = setRoot(set) ?? set[0]
    const chip = canvasChip(root, set.length)
    // A canvas the topic drew before its work existed is that work's (workCanvases); outside any work, This chat's.
    const at = lineOf(root, by)
    if (at) add(at, chip)
    else loose.push(chip.chip)
  }
  const chipsOf = (id: string) => (lines.get(id) ?? []).sort(byOrder).map((c) => c.chip)
  for (const w of out) {
    w.chips = chipsOf(w.work.id)
    for (const s of w.steps) s.chips = chipsOf(s.step.id)
  }
  const count = out.reduce((n, w) => n + 1 + w.chips.length + w.steps.reduce((m, s) => m + s.chips.length, 0), loose.length)
  return { works: out, loose, count }
}

/** The artifact a work opens on from the work list: a review's report, else the work's card. */
export const workTarget = (work: Task): ArtifactTarget => ({ kind: isReview(work) ? 'review' : 'work', taskId: work.id })
