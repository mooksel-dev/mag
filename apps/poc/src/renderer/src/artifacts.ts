import {
  isReview,
  isSubtopic,
  sessionActivity,
  sessionRole,
  sessionState,
  sessionTree,
  setKey,
  setOf,
  setRoot,
  shortTitle,
  subtasksOf,
  taskDiagrams,
  workCanvases,
  type AgentSession,
  type SessionState,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'

/**
 * What a topic made (topics-a-tree-of-agent.3): the cards, docs, reviews and diagrams of the topic's tree and of the
 * works its sessions own. They show in the chat that made them and in the topic's Documents and diagrams; each opens in
 * the screen's drawer. Plain titles (topic-screen-one-new-compact.2): a work's doc is its title, a step's plan, fact and
 * review are "Plan: <step>", "What was built: <step>" and "Review: <step>"; what the tree drew outside any work is last.
 * The agents working within a topic are topicAgents.
 */

/**
 * What the drawer shows: a canvas (a diagram opens with its set), a task's card, doc or review (a teammate's PR
 * review is its work's; an agent review of a step, the step's), or the chat of an agent of a work (read only).
 */
export type ArtifactTarget =
  | { kind: 'canvas'; id: string; focus?: string }
  | { kind: 'work' | 'doc' | 'review'; taskId: string }
  | { kind: 'agent'; sessionId: string }

/** One line of Documents and diagrams. */
export interface ArtifactChip {
  /** Unique within the list. */
  key: string
  /** Its plain title: the work's title for its doc, "Plan: <step title>"… */
  label: string
  /** The tooltip: the artifact's own title and its key. */
  title: string
  /** A review's verdict: merge green, look amber, changes red. */
  tone?: 'green' | 'amber' | 'red'
  open: ArtifactTarget
}

/** A work (or a teammate's PR review) with its lines: its doc (else its card) and options, then its steps' in order. */
export interface WorkArtifacts {
  work: Task
  lines: ArtifactChip[]
}

export interface TopicArtifacts {
  works: WorkArtifacts[]
  /** Canvases the tree made outside any work. */
  loose: ArtifactChip[]
  /** How many lines: the works' and the loose ones. */
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

const TONES = { merge: 'green', look: 'amber', changes: 'red' } as const

/** Lines of one work or step in this order: doc, options, plan, fact, other canvases, review; the order listed within a kind. */
const CHIP_ORDER = ['doc', 'option', 'plan', 'fact', 'canvas', 'review'] as const
type ChipKind = (typeof CHIP_ORDER)[number]

/** The line of a canvas (a diagram set by its root) on the line of `name` (a step's or a work's title): by its role, else its title. */
function canvasChip(c: CanvasItem, count: number, name: string | null): { kind: ChipKind; chip: ArtifactChip } {
  const n = count > 1 ? ` · ${count} diagrams` : ''
  const title = `${c.title}${n}`
  const chip = (kind: ChipKind, label: string) => ({ kind, chip: { key: `canvas:${c.id}`, label, title, open: { kind: 'canvas', id: c.id } as ArtifactTarget } })
  const of = (what: string) => (name ? `${what}: ${name}` : what)
  if (c.kind === 'diagram' && c.role === 'option' && c.option) return chip('option', of(`Option ${c.option}`))
  if (c.kind === 'diagram' && c.role === 'plan') return chip('plan', of('Plan'))
  if (c.kind === 'diagram' && c.role === 'fact') return chip('fact', of('What was built'))
  return chip('canvas', c.title)
}

/** By CHIP_ORDER; options by their letter. */
const byOrder = (a: { kind: ChipKind; chip: ArtifactChip }, b: { kind: ChipKind; chip: ArtifactChip }) =>
  CHIP_ORDER.indexOf(a.kind) - CHIP_ORDER.indexOf(b.kind) || (a.kind === 'option' && b.kind === 'option' ? a.chip.label.localeCompare(b.chip.label) : 0)

/**
 * The artifacts of `topic`'s tree (the topic, or a session under it, and everything below it) and of the works it owns,
 * by work (open ones first, then the newest) and then by step in order; `work`: a work shown without a topic (its owner
 * is its groomer, or nobody), listed alone or with the topic's. A work's first line is its doc, titled as the work (no
 * doc: its card; a teammate's PR review: its report). A diagram set is one line (its root, else its first diagram), with
 * its step when it has a step of a listed work, else with its work (the work it belongs to, or the one whose doc links
 * it); a canvas listed by two works shows once.
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
  // The title of each listed work and step, by id: what its lines are named after.
  const names = new Map<string, string>()
  const stepsOf = new Map<string, Task[]>()
  // Each canvas once, with the work that listed it first.
  const listed = new Map<CanvasItem, Task | null>()
  const list = (cs: CanvasItem[], by: Task | null) => cs.forEach((c) => { if (!listed.has(c)) listed.set(c, by) })
  for (const w of works) {
    const title = shortTitle(w)
    names.set(w.id, title)
    const steps = isReview(w) ? [] : subtasksOf(w.id, tasks)
    stepsOf.set(w.id, steps)
    const head: ArtifactChip = isReview(w)
      ? { key: `review:${w.id}`, label: `Review: ${title}`, title: `Review · ${w.key}`, open: { kind: 'review', taskId: w.id } }
      : state.docs[w.id]
        ? { key: `doc:${w.id}`, label: title, title: `Doc · ${w.key}`, open: { kind: 'doc', taskId: w.id } }
        : { key: `work:${w.id}`, label: title, title: `${w.key} · no doc yet`, open: { kind: 'work', taskId: w.id } }
    add(w.id, { kind: 'doc', chip: head })
    for (const step of steps) {
      names.set(step.id, step.title)
      const r = step.review
      if (r) add(step.id, { kind: 'review', chip: { key: `review:${step.id}`, label: `Review: ${step.title}`, title: `Agent review of ${step.key} · ${r.verdict} · round ${r.round}`, tone: TONES[r.verdict], open: { kind: 'review', taskId: step.id } } })
    }
    list(taskDiagrams(w, state.docs[w.id], canvases), w)
    list(workCanvases(w, canvases), w)
  }
  // What the tree drew outside any work.
  const ids = new Set(tree.map((s) => s.id))
  list(canvases.filter((c) => c.taskId === null && !!c.sessionId && ids.has(c.sessionId)), null)
  const loose: ArtifactChip[] = []
  const sets = new Set<string>()
  const lineOf = (c: CanvasItem, by: Task | null): string | null => {
    if (c.stepId && [...stepsOf.values()].some((ss) => ss.some((s) => s.id === c.stepId))) return c.stepId
    if (c.taskId && works.some((w) => w.id === c.taskId)) return c.taskId
    return by?.id ?? null
  }
  for (const [c, by] of listed) {
    const key = setKey(c)
    if (key && sets.has(key)) continue
    if (key) sets.add(key)
    const set = c.kind === 'diagram' && c.diagram ? setOf(c, canvases) : [c]
    const root = setRoot(set) ?? set[0]
    // A canvas the topic drew before its work existed is that work's (workCanvases); outside any work, loose.
    const at = lineOf(root, by)
    const chip = canvasChip(root, set.length, at ? names.get(at) ?? null : null)
    if (at) add(at, chip)
    else loose.push(chip.chip)
  }
  const chipsOf = (id: string) => (lines.get(id) ?? []).sort(byOrder).map((c) => c.chip)
  const out = works.map((w) => ({ work: w, lines: [...chipsOf(w.id), ...stepsOf.get(w.id)!.flatMap((s) => chipsOf(s.id))] }))
  const count = out.reduce((n, w) => n + w.lines.length, loose.length)
  return { works: out, loose, count }
}

/** Where an agent stands, as its line says: working, waits on you (an approval), failed, or done (stopped, idle). */
export type AgentLineState = 'working' | 'waiting' | 'failed' | 'done'

/** One agent on a topic's Agents list. */
export interface AgentLine {
  session: AgentSession
  /** developer, reviewer, subagent, groomer… */
  role: string
  /** What it works on: its step's title, else its work's, else its own title (its brief). */
  on: string
  state: AgentLineState
  /** The PR it works on, if any: its step's (the first open one, else the first), a teammate's PR under review. */
  prUrl: string | null
  /** A tree's agent opens as its own page; a work's agent in the drawer, as a log. */
  open: { kind: 'select'; id: string } | Extract<ArtifactTarget, { kind: 'agent' }>
}

export interface TopicAgents {
  /** Waiting on you, then working, then failed; the earliest started first within a state. */
  active: AgentLine[]
  /** The rest (stopped or idle): the newest first. */
  done: AgentLine[]
  /** How many work now (not waiting on you). */
  working: number
}

const AGENT_STATES: Record<SessionState, AgentLineState> = { running: 'working', waiting: 'waiting', error: 'failed', idle: 'done', closed: 'done' }
const AGENT_ORDER: AgentLineState[] = ['waiting', 'working', 'failed', 'done']

/**
 * The agents working within `topic` (a topic or a subtopic, and everything under it), topic-screen-one-new-compact.2:
 * the role presets and Claude Code subagents of its tree (not its subtopics: those are on the left), and the agents of
 * the works the tree owns (groomer, developers, reviewers); `work`, a work shown without a topic, adds its own.
 */
export function topicAgents(topic: AgentSession | null, state: Pick<AppState, 'tasks' | 'sessions'>, work: Task | null = null): TopicAgents {
  const projectId = topic?.projectId ?? work?.projectId
  const tasks = state.tasks.filter((t) => t.projectId === projectId)
  const tree = topic ? sessionTree(topic.id, state.sessions) : []
  const works = treeWorks(tree, tasks)
  if (work && !works.some((w) => w.id === work.id)) works.push(work)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const line = (s: AgentSession, w: Task | null): AgentLine => {
    const step = s.stepId ? byId.get(s.stepId) : undefined
    const repos = (step ?? w)?.work?.repos.filter((r) => r.prUrl) ?? []
    const pr = repos.find((r) => r.prState === 'open') ?? repos[0]
    return {
      session: s,
      role: w ? (s.role ?? 'agent') : sessionRole(s),
      // An agent has no generated title to wait for: its title is its brief.
      on: step?.title ?? (w ? shortTitle(w) : s.title?.trim() || sessionRole(s)),
      state: AGENT_STATES[sessionState(s)],
      prUrl: pr?.prUrl ?? w?.prReview?.pr.url ?? null,
      open: w ? { kind: 'agent', sessionId: s.id } : { kind: 'select', id: s.id },
    }
  }
  const lines = [
    ...tree.filter((s) => s.id !== topic!.id && !isSubtopic(s)).map((s) => line(s, null)),
    ...works.flatMap((w) => state.sessions.filter((s) => s.taskId === w.id && s.role !== 'chat').map((s) => line(s, w))),
  ]
  const rank = (l: AgentLine) => AGENT_ORDER.indexOf(l.state)
  return {
    active: lines.filter((l) => l.state !== 'done').sort((a, b) => rank(a) - rank(b) || a.session.createdAt - b.session.createdAt),
    done: lines.filter((l) => l.state === 'done').sort((a, b) => sessionActivity(b.session) - sessionActivity(a.session)),
    working: lines.filter((l) => l.state === 'working').length,
  }
}

/** The artifact a work opens on from the work list: a review's report, else the work's card. */
export const workTarget = (work: Task): ArtifactTarget => ({ kind: isReview(work) ? 'review' : 'work', taskId: work.id })
