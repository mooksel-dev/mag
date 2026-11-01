// Diagrams as data (T-55.3): where a diagram stands in its work. Options sketch the ways to solve the problem; the plan
// is per step and repository; the fact is what a step's PR really did (T-55.4).

import type { Canvas, Task } from './index.ts'

/** option: sketches one option; plan: the planned change of a step (in one repo); fact: what the step's PR did. */
export type CanvasRole = 'option' | 'plan' | 'fact'

export const CANVAS_ROLES: CanvasRole[] = ['option', 'plan', 'fact']

/** A diagram's place in its work; the fields of other roles are null. */
export type CanvasPlacement = Pick<Canvas, 'role' | 'option' | 'stepId' | 'repo' | 'planOf'>

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/
const CANVAS_LINK = /\[[^\]\n]*\]\(canvas:([\w-]+)(?:#[\w.:-]+)?\)/g

/** Ids of the canvases a markdown text links as [title](canvas:<id>), outside code, each once, in order. */
export function linkedCanvasIds(md: string): string[] {
  const ids: string[] = []
  md.split(CODE).forEach((part, i) => {
    if (i % 2) return
    for (const m of part.matchAll(CANVAS_LINK)) if (!ids.includes(m[1])) ids.push(m[1])
  })
  return ids
}

type DiagramLike = Pick<Canvas, 'id' | 'projectId' | 'taskId' | 'kind' | 'diagram'> & CanvasPlacement

/**
 * The diagrams of a work: its own in the order they were drawn, then the diagrams of the project that its doc links
 * and another task owns (e.g. the research it came from), in doc order. Unowned linked canvases are adopted when the
 * doc is written, so they are among its own.
 */
export function taskDiagrams<C extends DiagramLike>(task: Pick<Task, 'id' | 'projectId'>, doc: string | undefined, canvases: C[]): C[] {
  const isDiagram = (c: C) => c.kind === 'diagram' && !!c.diagram && c.projectId === task.projectId
  const own = canvases.filter((c) => isDiagram(c) && c.taskId === task.id)
  const linked = linkedCanvasIds(doc ?? '').flatMap((id) => canvases.filter((c) => c.id === id && isDiagram(c) && c.taskId !== task.id))
  return [...own, ...linked]
}

/** The diagrams of one step: its plan and its fact. */
export function stepDiagrams<C extends DiagramLike>(diagrams: C[], stepId: string): C[] {
  return diagrams.filter((d) => (d.role === 'plan' || d.role === 'fact') && d.stepId === stepId)
}

export interface DiagramGroups<C> {
  /** One group per option, in the order the options first appear. */
  options: { option: string; diagrams: C[] }[]
  /** One group per step with diagrams, in step order; inside, one per repo in project order, then the step-wide ones. */
  plan: { step: Task; repos: { repo: string | null; diagrams: C[] }[] }[]
  /** Diagrams not placed yet, or placed on a step that is gone. */
  other: C[]
}

/** Groups a work's diagrams the way Diff shows them: Options → Plan (step → repo) → the rest. */
export function diagramGroups<C extends DiagramLike>(diagrams: C[], steps: Task[], repos: string[]): DiagramGroups<C> {
  const options: DiagramGroups<C>['options'] = []
  for (const d of diagrams) {
    if (d.role !== 'option' || !d.option) continue
    const group = options.find((o) => o.option === d.option)
    if (group) group.diagrams.push(d)
    else options.push({ option: d.option, diagrams: [d] })
  }
  const repoOrder = (r: string | null) => (r === null ? repos.length : repos.indexOf(r) < 0 ? repos.length - 0.5 : repos.indexOf(r))
  const plan = steps.flatMap((step) => {
    const mine = stepDiagrams(diagrams, step.id)
    if (!mine.length) return []
    const keys = [...new Set(mine.map((d) => d.repo ?? null))].sort((a, b) => repoOrder(a) - repoOrder(b))
    return [{ step, repos: keys.map((repo) => ({ repo, diagrams: mine.filter((d) => (d.repo ?? null) === repo) })) }]
  })
  const placed = new Set([...options.flatMap((o) => o.diagrams), ...plan.flatMap((p) => p.repos.flatMap((r) => r.diagrams))])
  return { options, plan, other: diagrams.filter((d) => !placed.has(d)) }
}
