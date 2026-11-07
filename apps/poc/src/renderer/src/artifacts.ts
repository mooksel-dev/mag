import {
  isReview,
  reportLine,
  sessionTree,
  setKey,
  setOf,
  setRoot,
  shortTitle,
  subtasksOf,
  taskDiagrams,
  workCanvases,
  type AgentSession,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'

/**
 * What a topic made (topics-a-tree-of-agent.3): the cards, docs, reviews and diagrams of the topic's tree and of the
 * works its sessions own. They show in the chat that made them and in the topic's artifacts list; each opens in the
 * screen's drawer. They replace the work screen's tabs.
 */

/** work: a work's plan, steps, PRs and agents (its card); fact: a fact set; mockup: an HTML canvas. */
export type ArtifactKind = 'work' | 'doc' | 'review' | 'fact' | 'diagram' | 'mockup'

/** The list's order of kinds. */
export const ARTIFACT_KINDS: ArtifactKind[] = ['work', 'doc', 'review', 'fact', 'diagram', 'mockup']

export const ARTIFACT_NAMES: Record<ArtifactKind, string> = { work: 'Works', doc: 'Docs', review: 'Reviews', fact: 'Facts', diagram: 'Diagrams', mockup: 'Canvases' }

/**
 * What the drawer shows: a canvas (a diagram opens with its set), or a task's card, doc or review (a teammate's PR
 * review is its work's; an agent review of a step, the step's).
 */
export type ArtifactTarget = { kind: 'canvas'; id: string; focus?: string } | { kind: 'work' | 'doc' | 'review'; taskId: string }

export interface Artifact {
  kind: ArtifactKind
  /** Unique within a list. */
  key: string
  title: string
  /** One line under the title: the work's key, the step, how many diagrams… */
  detail: string
  at: number
  open: ArtifactTarget
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

const SET_DETAIL = (root: CanvasItem, tasks: Task[]): string => {
  const step = root.stepId ? tasks.find((t) => t.id === root.stepId)?.key : undefined
  const work = root.taskId ? tasks.find((t) => t.id === root.taskId)?.key : undefined
  if (root.role === 'option' && root.option) return `${work ? `${work} · ` : ''}option ${root.option}`
  if (root.role === 'plan') return `plan${step ? ` · ${step}` : ''}`
  if (root.role === 'fact') return `fact${step ? ` · ${step}` : work ? ` · ${work}` : ''}`
  return work ?? ''
}

/**
 * The artifacts of `topic`'s tree (the topic, or a session under it, and everything below it) and of the works it owns;
 * `work`: a work shown without a topic (its owner is its groomer, or nobody), whose artifacts are listed alone or with
 * the topic's. By kind in ARTIFACT_KINDS order, newest first in each. A diagram set is one artifact (its root, else its
 * first diagram), opening with the whole set; a canvas listed by two works shows once.
 */
export function topicArtifacts(topic: AgentSession | null, state: ArtifactState, work: Task | null = null): Artifact[] {
  const projectId = topic?.projectId ?? work?.projectId
  if (!projectId) return []
  const tasks = state.tasks.filter((t) => t.projectId === projectId)
  const tree = topic ? sessionTree(topic.id, state.sessions) : []
  const works = treeWorks(tree, tasks)
  if (work && !works.some((w) => w.id === work.id)) works.push(work)
  const canvases = state.canvases.filter((c) => c.projectId === projectId)
  const out: Artifact[] = []
  const listed: CanvasItem[] = []
  const list = (cs: CanvasItem[]) => cs.forEach((c) => { if (!listed.includes(c)) listed.push(c) })
  for (const w of works) {
    if (isReview(w)) {
      out.push({ kind: 'review', key: `review:${w.id}`, title: shortTitle(w), detail: `${w.key} · PR review`, at: w.updatedAt, open: { kind: 'review', taskId: w.id } })
    } else {
      out.push({ kind: 'work', key: `work:${w.id}`, title: shortTitle(w), detail: `${w.key} · ${w.status.replace('_', ' ')}`, at: w.updatedAt, open: { kind: 'work', taskId: w.id } })
      if (state.docs[w.id]) out.push({ kind: 'doc', key: `doc:${w.id}`, title: shortTitle(w), detail: w.key, at: w.updatedAt, open: { kind: 'doc', taskId: w.id } })
      for (const step of subtasksOf(w.id, tasks)) {
        const r = step.review
        if (!r) continue
        const line = r.report ? reportLine(r.report, 'step') : `${r.verdict}${r.findings.length ? ` · ${r.findings.length} finding${r.findings.length > 1 ? 's' : ''}` : ''}`
        out.push({ kind: 'review', key: `review:${step.id}`, title: `${step.key} · ${step.title}`, detail: `Agent review: ${line}`, at: r.at, open: { kind: 'review', taskId: step.id } })
      }
    }
    list(taskDiagrams(w, state.docs[w.id], canvases))
    list(workCanvases(w, canvases))
  }
  // What the tree drew outside any work.
  const ids = new Set(tree.map((s) => s.id))
  list(canvases.filter((c) => c.taskId === null && !!c.sessionId && ids.has(c.sessionId)))
  const sets = new Set<string>()
  for (const c of listed) {
    if (c.kind !== 'diagram' || !c.diagram) {
      out.push({ kind: 'mockup', key: `canvas:${c.id}`, title: c.title, detail: `v${c.version}`, at: c.updatedAt, open: { kind: 'canvas', id: c.id } })
      continue
    }
    const key = setKey(c)
    if (key && sets.has(key)) continue
    if (key) sets.add(key)
    const set = setOf(c, canvases)
    const root = setRoot(set) ?? set[0]
    const n = set.length > 1 ? ` · ${set.length} diagrams` : ''
    out.push({
      kind: root.role === 'fact' ? 'fact' : 'diagram',
      key: `canvas:${root.id}`,
      title: root.title,
      detail: `${SET_DETAIL(root, tasks)}${n}`.replace(/^ · /, ''),
      at: Math.max(...set.map((d) => d.updatedAt)),
      open: { kind: 'canvas', id: root.id },
    })
  }
  return out.sort((a, b) => ARTIFACT_KINDS.indexOf(a.kind) - ARTIFACT_KINDS.indexOf(b.kind) || b.at - a.at)
}

/** The artifact a work opens on from the work list: a review's report, else the work's card. */
export const workTarget = (work: Task): ArtifactTarget => ({ kind: isReview(work) ? 'review' : 'work', taskId: work.id })
