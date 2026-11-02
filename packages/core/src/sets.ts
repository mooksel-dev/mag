// Diagram sets (povnyi-diff-nabir-pov-iazanykh.1, Decisions 1–3): the diagrams of one place (an option, a step's plan,
// a step's fact, the fact of a reviewed PR) are one set, computed, not stored. One of them is its root; explicit links
// lead from modules, interface lines, uses and entities to the other diagrams of the set. A flowchart's `of` reads as a
// logic link from its method, so diagrams drawn before links still hang together.
import { methodName, walkArch } from './arch.ts'
import { LINK_KINDS, parseFlowRef, type Diagram, type DiagramLink, type DNode } from './diagram.ts'
import type { Canvas } from './index.ts'

type Member = Pick<Canvas, 'id' | 'projectId' | 'taskId' | 'kind' | 'diagram' | 'role' | 'option' | 'stepId' | 'title' | 'root'>

/** The place that makes a diagram's set; '' for a diagram not placed, a set of its own. */
export function setKey(c: Omit<Member, 'id' | 'title' | 'root' | 'projectId'>): string {
  if (c.kind !== 'diagram' || !c.diagram) return ''
  if (c.role === 'option' && c.option) return `${c.taskId}:option:${c.option}`
  if ((c.role === 'plan' || c.role === 'fact') && c.stepId) return `${c.role}:${c.stepId}`
  // The fact of a reviewed PR is its work's.
  if (c.role === 'fact' && c.taskId) return `${c.taskId}:fact`
  return ''
}

/** The diagrams of `canvas`'s set, in the order they were drawn; just itself when it is not placed. */
export function setOf<C extends Member>(canvas: C, canvases: C[]): C[] {
  const key = setKey(canvas)
  if (!key) return [canvas]
  return canvases.filter((c) => c.projectId === canvas.projectId && setKey(c) === key)
}

/** The root of a set: the diagram marked so, the only one of a set of one; null when none (or several) is. */
export function setRoot<C extends Pick<Canvas, 'root'>>(set: C[]): C | null {
  const roots = set.filter((c) => c.root)
  return roots.length === 1 ? roots[0] : set.length === 1 ? set[0] : null
}

/** A link of a diagram and what it starts at: a module id, `<module>#<method>`, `<from> -> <to>` or an entity id. */
export interface LinkFrom {
  from: string
  link: DiagramLink
}

/** The explicit links of a diagram. */
export function diagramLinks(d: Diagram): LinkFrom[] {
  const out: LinkFrom[] = []
  const add = (from: string, links?: DiagramLink[]) => links?.forEach((link) => out.push({ from, link }))
  if (d.type === 'component')
    walkArch(d.modules, (n: DNode) => {
      add(n.id, n.links)
      for (const l of n.interface ?? []) add(`${n.id}#${methodName(l.text)}`, l.links)
      for (const u of n.uses) add(`${n.id} -> ${u.to}`, u.links)
    })
  if (d.type === 'data') for (const e of d.entities) add(e.id, e.links)
  return out
}

/** The ids a link's node may name in a diagram: modules, entities, flowchart nodes, participants or states. */
export function nodeIds(d: Diagram): Set<string> {
  const ids = new Set<string>()
  switch (d.type) {
    case 'component':
      walkArch(d.modules, (n) => ids.add(n.id))
      break
    case 'data':
      d.entities.forEach((e) => ids.add(e.id))
      break
    case 'flowchart':
      d.nodes.forEach((n) => ids.add(n.id))
      break
    case 'sequence':
      d.participants.forEach((p) => ids.add(p.id))
      break
    case 'state':
      d.states.forEach((s) => ids.add(s.id))
      break
  }
  return ids
}

/** The modules a Component diagram draws. */
const modulesOf = (d: Diagram) => {
  const ids = new Set<string>()
  if (d.type === 'component') walkArch(d.modules, (n) => ids.add(n.id))
  return ids
}

/** The diagrams of a set the root reaches by links and flowcharts' of; all of them when it has no root. */
export function reached<C extends Member>(set: C[]): Set<string> {
  const root = setRoot(set)
  if (!root) return new Set(set.map((c) => c.id))
  const seen = new Set([root.id])
  const queue = [root]
  const visit = (c: C) => {
    if (seen.has(c.id)) return
    seen.add(c.id)
    queue.push(c)
  }
  while (queue.length) {
    const c = queue.shift()!
    for (const { link } of diagramLinks(c.diagram!)) {
      const to = set.find((x) => x.id === link.to)
      if (to) visit(to)
    }
    // A flowchart of a method of a module this diagram draws.
    const modules = modulesOf(c.diagram!)
    for (const x of set) {
      const ref = x.diagram!.type === 'flowchart' && x.diagram!.of ? parseFlowRef(x.diagram!.of) : null
      if (ref && modules.has(ref.module)) visit(x)
    }
  }
  return seen
}

const name = (c: Pick<Canvas, 'id' | 'title'>) => `"${c.title}" (${c.id})`

/**
 * Where a set does not hang together (Decision 3), as warnings: no root, or several; a link to a diagram outside the
 * set or to a node its diagram does not have; a diagram the root reaches by no link (an orphan), with a hint where its
 * link would go. A set of one diagram needs no root.
 */
export function validateLinks<C extends Member>(set: C[]): string[] {
  const out: string[] = []
  const roots = set.filter((c) => c.root)
  if (set.length > 1 && !roots.length) out.push(`The set has no root: mark its entry (the system level or the top component diagram) with root: true.`)
  if (roots.length > 1) out.push(`The set has ${roots.length} roots (${roots.map(name).join(', ')}): keep root on one.`)
  for (const c of set)
    for (const { from, link } of diagramLinks(c.diagram!)) {
      const to = set.find((x) => x.id === link.to)
      if (!to) out.push(`${name(c)}: ${from} links to ${link.to}, not a diagram of this set.`)
      else if (link.node && !nodeIds(to.diagram!).has(link.node)) out.push(`${name(c)}: ${from} links to node "${link.node}" of ${name(to)}, which has no such node.`)
      if (!LINK_KINDS.includes(link.kind)) out.push(`${name(c)}: ${from}: link kind "${link.kind}" is not one of ${LINK_KINDS.join(', ')}.`)
    }
  if (roots.length === 1) {
    const seen = reached(set)
    for (const c of set.filter((x) => !seen.has(x.id))) out.push(`${name(c)} is not reached from the root: ${hint(c, set)}`)
  }
  return out
}

/** Where an orphan's link would go: the module of a flowchart's method, the module that owns a data diagram's tables. */
function hint<C extends Member>(c: C, set: C[]): string {
  const d = c.diagram!
  const link = (kind: string) => `links: [{ to: "${c.id}", kind: "${kind}" }]`
  if (d.type === 'flowchart' && d.of) {
    const ref = parseFlowRef(d.of)
    const on = ref && set.find((x) => modulesOf(x.diagram!).has(ref.module))
    return on ? `its of ${d.of} is on ${name(on)}, which the root does not reach; link that diagram.` : `no diagram of the set draws ${ref?.module ?? d.of}: add the module with its method line.`
  }
  if (d.type === 'data') return `give the module that owns these tables ${link('data')}.`
  if (d.type === 'sequence') return `give the use, line or module the scenario is of ${link('scenario')}.`
  if (d.type === 'flowchart') return `give the method's interface line ${link('logic')}.`
  return `give a module of the root ${link('detail')}.`
}

/** A diagram with the ids its links lead to replaced (`ids`: old id → new), e.g. a copy of a set. */
export function remapLinks(d: Diagram, ids: Map<string, string>): Diagram {
  const copy = JSON.parse(JSON.stringify(d)) as Diagram
  const fix = (links?: DiagramLink[]) => links?.forEach((l) => (l.to = ids.get(l.to) ?? l.to))
  if (copy.type === 'component')
    walkArch(copy.modules, (n: DNode) => {
      fix(n.links)
      n.interface?.forEach((l) => fix(l.links))
      n.uses.forEach((u) => fix(u.links))
    })
  if (copy.type === 'data') copy.entities.forEach((e) => fix(e.links))
  return copy
}
