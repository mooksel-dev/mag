// The plan's Component diagram painted with its comparison to the fact (plan-fact-porivniannia-na-rivni.1): modules and
// dependencies as planned, otherwise or missing, and the fact's unplanned ones added in, drawn dashed.
import { findNode, type DNode } from '@mag/core'
import type { PlanOverlay } from '@mag/diff/types'

export type Paint = 'match' | 'differs' | 'missing' | 'unplanned'

export interface Painted {
  /** The plan's modules with the unplanned ones and their dependencies added. */
  modules: DNode[]
  module: (id: string) => Paint | undefined
  edge: (from: string, to: string) => Paint | undefined
}

const copy = (n: DNode): DNode => ({ ...n, uses: [...n.uses], ...(n.children && { children: n.children.map(copy) }) })

/**
 * The plan's modules painted by `overlay`. An unplanned module goes in the innermost of its architecture ancestors the
 * diagram has, else on top; an unplanned dependency joins its caller's uses when both ends are drawn.
 */
export function paintPlan(modules: DNode[], overlay: PlanOverlay): Painted {
  const out = modules.map(copy)
  const unplanned = new Set<string>()
  for (const m of overlay.unplanned.modules) {
    if (findNode(out, m.id)) continue
    const parent = [...m.within].reverse().map((id) => findNode(out, id)).find((n) => !!n)
    const node: DNode = { id: m.id, name: m.name, description: 'Not on the plan', uses: [], diff: 'mod', ...(m.layer && { layer: m.layer }) }
    if (parent) parent.children = [...(parent.children ?? []), node]
    else out.push(node)
    unplanned.add(m.id)
  }
  const edges = new Set<string>()
  for (const e of overlay.unplanned.edges) {
    const from = findNode(out, e.from)
    if (!from || !findNode(out, e.to)) continue
    if (!from.uses.some((u) => u.to === e.to)) from.uses.push({ to: e.to, calls: [], diff: 'mod' })
    edges.add(`${e.from} -> ${e.to}`)
  }
  return {
    modules: out,
    module: (id) => (unplanned.has(id) ? 'unplanned' : overlay.modules[id]),
    edge: (from, to) => (edges.has(`${from} -> ${to}`) ? 'unplanned' : overlay.edges[`${from} -> ${to}`]),
  }
}
