// What a Component diff shows on the diagram itself (T-43, T-48): which modules fold into the "Без змін" row, the call
// count pills on changed arrows, the calls of the side panel, the move arrows of one level and the flows of methods.
import { callsCount, dominantDiff, methodFlows, methodName, moves, nodeDiff, parseFlowRef, pathTo, useDiff, walkArch, type ArchEdge, type ComponentDiagram, type DiffCount, type DiffMark, type Diagram, type DLine, type DNode, type DUse, type FlowchartDiagram, type Line, type MethodFlow } from '@mag/core'

/** Ids of the modules something moved out of. */
export function movedOut(d: ComponentDiagram): Set<string> {
  return new Set(moves(d).map((m) => m.from))
}

/**
 * Whether a module changes and keeps its box in a diff: it is marked, one of its interface lines changes or moves
 * out, one of its own uses or calls is marked, one of its methods has a flow (`flowed`: ids of such modules), or the
 * same holds for one of its inner modules.
 */
export function changedModule(n: DNode, out: Set<string>, flowed: Set<string> = new Set()): boolean {
  const own = !!nodeDiff(n) || out.has(n.id) || flowed.has(n.id) || n.uses.some((u) => u.diff || u.calls.some((c) => c.diff))
  return own || !!n.children?.some((c) => changedModule(c, out, flowed))
}

/**
 * The count pill of an arrow: its changed calls by mark (callsCount over the calls of every use folded into it) and
 * the mark it is colored by. null when no call on it changes.
 */
export function edgePill(e: ArchEdge): { count: DiffCount; mark: DiffMark } | null {
  const count = callsCount({ to: e.to, calls: e.calls.map((text) => ({ text, diff: e.callDiff?.[text] })) })
  const mark = dominantDiff(count)
  return mark ? { count, mark } : null
}

/** One end of a selected module's links in the side panel: the module at the other end and every call, marked. */
export interface CallGroup {
  id: string
  diff?: DiffMark
  calls: Line[]
}

const whole = (m?: DiffMark) => (m === 'add' || m === 'del' ? m : undefined)

/** A use as a group of calls; an unmarked call takes the mark of an added or removed use (see useDiff). */
function group(all: Map<string, DNode>, from: DNode, u: DUse, id: string): CallGroup {
  const m = useDiff(from, u, all.get(u.to))
  return { id, diff: m, calls: u.calls.map((c) => ({ text: c.text, diff: c.diff ?? whole(m) })) }
}

/** What a module calls, by target, and who calls it, by caller: the full lists for the side panel of a diff. */
export function callGroups(modules: DNode[], node: DNode): { calls: CallGroup[]; callers: CallGroup[] } {
  const byId = new Map<string, DNode>()
  walkArch(modules, (n) => byId.set(n.id, n))
  const callers: CallGroup[] = []
  walkArch(modules, (n) => {
    for (const u of n.uses) if (u.to === node.id) callers.push(group(byId, n, u, n.id))
  })
  return { calls: node.uses.map((u) => group(byId, node, u, u.to)), callers }
}

/** A move arrow on one level: the modules that stand for both ends and the names of what moved. */
export interface MoveEdge {
  from: string
  to: string
  names: string[]
}

/**
 * Move arrows among the children of `parentId` (the top level when null). Lines of inner modules move between their
 * ancestors on this level; a move within one of them or from outside the level has no arrow here.
 */
export function moveEdges(d: ComponentDiagram, parentId: string | null): MoveEdge[] {
  const level = parentId ? pathTo(d.modules, parentId) : []
  if (parentId && !level.length) return []
  const anchor = (id: string) => {
    const p = pathTo(d.modules, id)
    const inside = p.length > level.length && level.every((a, i) => p[i]?.id === a.id)
    return inside ? p[level.length].id : null
  }
  const out = new Map<string, MoveEdge>()
  for (const m of moves(d)) {
    const from = anchor(m.from)
    const to = anchor(m.to)
    if (!from || !to || from === to) continue
    const k = `${from}>${to}`
    if (!out.has(k)) out.set(k, { from, to, names: [] })
    const name = methodName(m.line.text)
    if (!out.get(k)!.names.includes(name)) out.get(k)!.names.push(name)
  }
  return [...out.values()]
}

/** The modules of one level that fold into the "Без змін" row of a diff; a module with a flow of a method keeps its box. */
export function unchangedAt(d: ComponentDiagram, nodes: DNode[], flows: FlowItem[] = []): Set<string> {
  const out = movedOut(d)
  const flowed = new Set(flows.map((f) => parseFlowRef(f.diagram.of)!.module))
  const ids = new Set<string>()
  for (const n of nodes) if (!changedModule(n, out, flowed)) ids.add(n.id)
  return ids
}

/** A flowchart of the task that shows the logic of a module's method (its of). */
export interface FlowItem {
  id: string
  title: string
  diagram: FlowchartDiagram & { of: string }
}

/** The flows of methods among a task's diagrams. */
export function flowItems(diagrams: { id: string; title: string; diagram: Diagram }[]): FlowItem[] {
  return diagrams.filter((d): d is FlowItem => d.diagram.type === 'flowchart' && !!d.diagram.of && !!parseFlowRef(d.diagram.of))
}

/** The flow of `method` of `moduleId`, when the task has one. */
export function flowOf(flows: FlowItem[], moduleId: string, method: string): FlowItem | undefined {
  return methodFlows(flows, moduleId).find((f) => f.method === method)?.item
}

/**
 * Lines of a module with a flow that its changed lines leave out: an unchanged interface line, or a bare
 * "method()" for a method not in the interface. They go after the changed lines on the box and in the panel.
 */
export function flowLines(n: DNode, flows: FlowItem[]): DLine[] {
  const changed = new Set((n.interface ?? []).filter((l) => l.diff).map((l) => methodName(l.text)))
  return methodFlows(flows, n.id)
    .filter((f) => !changed.has(f.method))
    .map((f) => (n.interface ?? []).find((l) => methodName(l.text) === f.method) ?? { text: `${f.method}()` })
}

/** The callers of one method of `node`, with only their calls of it. */
export function methodCallers(modules: DNode[], node: DNode, method: string): CallGroup[] {
  return callGroups(modules, node)
    .callers.map((g) => ({ ...g, calls: g.calls.filter((c) => methodName(c.text) === method) }))
    .filter((g) => g.calls.length)
}

/** A method another flow is linked to by replaces, and its flow when the task has one. */
export interface FlowLink {
  module: string
  method: string
  flow?: FlowItem
}

/**
 * The flows around an open one: the other flows of its module, the method it replaces and the methods that replace
 * it (replaces on their flows).
 */
export function relatedFlows(flows: FlowItem[], item: FlowItem): { others: MethodFlow<FlowItem>[]; replaces?: FlowLink; replacedBy: FlowLink[] } {
  const of = parseFlowRef(item.diagram.of)!
  const same = (a: { module: string; method: string }, b: { module: string; method: string }) => a.module === b.module && a.method === b.method
  const r = item.diagram.replaces ? parseFlowRef(item.diagram.replaces) : null
  const replacedBy: FlowLink[] = []
  for (const f of flows) {
    const by = f.diagram.replaces ? parseFlowRef(f.diagram.replaces) : null
    if (f.id !== item.id && by && same(by, of)) replacedBy.push({ ...parseFlowRef(f.diagram.of)!, flow: f })
  }
  return {
    others: methodFlows(flows, of.module).filter((f) => f.item.id !== item.id),
    replaces: r ? { ...r, flow: flowOf(flows, r.module, r.method) } : undefined,
    replacedBy,
  }
}
