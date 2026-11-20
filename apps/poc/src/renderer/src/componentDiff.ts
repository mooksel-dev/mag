// What a Component diff shows on the diagram itself (T-43, T-48): which modules fold into the "Без змін" row, the call
// count pills on changed arrows, the calls of the side panel, the move arrows of one level and the flows of methods.
import { callsCount, dominantDiff, formatDiffCount, inApp, methodFlows, methodName, moves, nodeDiff, parseFlowRef, pathTo, useDiff, walkArch, type ArchEdge, type ComponentDiagram, type DBoundary, type DiffCount, type DiffMark, type Diagram, type DLine, type DNode, type DUse, type FlowchartDiagram, type Line, type MethodFlow } from '@mag/core'

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

/**
 * The modules of one level that fold into the "Без змін" row of a diff; a module with a flow of a method keeps its box.
 * A level in boundaries folds nothing: it answers where each part runs, and a chip has no place in a frame.
 */
export function unchangedAt(d: ComponentDiagram, nodes: DNode[], flows: FlowItem[] = []): Set<string> {
  return nodes.some((n) => n.boundary) ? new Set() : unchangedModules(d, nodes, flows)
}

/** The modules of a level that change in nothing (changedModule), by id. */
export function unchangedModules(d: ComponentDiagram, nodes: DNode[], flows: FlowItem[] = []): Set<string> {
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

/** The signature of a call or interface line, without its description: "name(args): Result - what it does" → "name(args): Result". */
export const signature = (text: string) => text.split(/\s[-–—]\s/)[0]

const SIGN: Record<DiffMark, string> = { add: '+', mod: '~', del: '−' }

/**
 * The label of an arrow: its first call, a changed one first on a diff, with "+n" for the rest; the mark it is
 * colored by and, for the tooltip, the counts and every call. null when no call is recorded on it.
 */
export function edgeLabel(e: ArchEdge, diff: boolean): { text: string; more: number; mark?: DiffMark; title: string } | null {
  if (!e.calls.length) return null
  const calls = diff ? [...e.calls.filter((c) => e.callDiff?.[c]), ...e.calls.filter((c) => !e.callDiff?.[c])] : e.calls
  const pill = diff ? edgePill(e) : null
  const lines = calls.map((c) => (diff ? `${e.callDiff?.[c] ? SIGN[e.callDiff[c]] : ' '} ${c}` : c))
  return {
    text: signature(calls[0]),
    more: calls.length - 1,
    ...(pill && { mark: pill.mark }),
    title: [...(pill ? [formatDiffCount(pill.count)] : []), ...lines].join('\n'),
  }
}

/** The id of the block an unchanged boundary folds into on a diff level. */
export const zoneId = (boundary: string) => `\u0000zone:${boundary}`

/**
 * The boundaries of a diff level drawn as one block each (a zone without changes): neither it nor a boundary in it is
 * marked, and every module of the level in it changes in nothing (changedModule). Only the outermost of such
 * boundaries, by its id; a boundary with no module of the level is not one.
 */
export function quietZones(d: ComponentDiagram, nodes: DNode[], boundaries: DBoundary[], flows: FlowItem[] = []): Set<string> {
  const unchanged = unchangedModules(d, nodes, flows)
  const byId = new Map(boundaries.map((b) => [b.id, b]))
  const chain = (id: string | undefined) => {
    const ids: string[] = []
    for (let b = id ? byId.get(id) : undefined; b && !ids.includes(b.id); b = b.parent ? byId.get(b.parent) : undefined) ids.push(b.id)
    return ids
  }
  const loud = new Set<string>()
  const used = new Set<string>()
  for (const b of boundaries) if (b.diff) chain(b.id).forEach((id) => loud.add(id))
  for (const n of nodes) {
    const ids = chain(n.boundary)
    ids.forEach((id) => used.add(id))
    if (!unchanged.has(n.id)) ids.forEach((id) => loud.add(id))
  }
  const quiet = (id: string) => used.has(id) && !loud.has(id)
  return new Set(boundaries.filter((b) => quiet(b.id) && !chain(b.parent).some(quiet)).map((b) => b.id))
}

/** The modules of a level in a folded zone, by module id: the block they are drawn in (zoneId). */
export function zoneOwners(nodes: DNode[], boundaries: DBoundary[], zones: Set<string>): Map<string, string> {
  const byId = new Map(boundaries.map((b) => [b.id, b]))
  const owners = new Map<string, string>()
  for (const n of nodes) {
    const seen = new Set<string>()
    for (let b = n.boundary ? byId.get(n.boundary) : undefined; b && !seen.has(b.id); b = b.parent ? byId.get(b.parent) : undefined) {
      seen.add(b.id)
      if (zones.has(b.id)) owners.set(n.id, zoneId(b.id))
    }
  }
  return owners
}

/** The zone (a boundary of `zones`) a module of the level is folded into, if any: a #node link to it opens that zone. */
export function zoneOf(nodes: DNode[], boundaries: DBoundary[], zones: Set<string>, module: string | null): string | undefined {
  const block = module ? zoneOwners(nodes.filter((n) => n.id === module), boundaries, zones).get(module) : undefined
  return block && boundaries.find((b) => zoneId(b.id) === block)?.id
}

/**
 * The arrows of a level with the modules of folded zones drawn as their block: an end in a zone moves to its block,
 * arrows between the same two ends merge (calls, steps and changes together), one inside a block goes away.
 */
export function foldEdges(edges: ArchEdge[], owners: Map<string, string>): ArchEdge[] {
  if (!owners.size) return edges
  const merged = new Map<string, ArchEdge>()
  for (const e of edges) {
    const from = owners.get(e.from) ?? e.from
    const to = owners.get(e.to) ?? e.to
    if (from === to) continue
    const k = `${from}>${to}`
    const was = merged.get(k)
    if (!was) {
      merged.set(k, { ...e, from, to, calls: [...e.calls] })
      continue
    }
    for (const c of e.calls) if (!was.calls.includes(c)) was.calls.push(c)
    if (e.callDiff) was.callDiff = { ...e.callDiff, ...was.callDiff }
    if (e.steps) was.steps = [...(was.steps ?? []), ...e.steps]
    if (was.diff !== e.diff) was.diff = was.diff || e.diff ? 'mod' : undefined
    if (!was.diff) delete was.diff
    if (!(was.async && e.async)) delete was.async
  }
  return [...merged.values()]
}

/** The frame of the lane a layered module sits in inside an app's boundary (inApp). */
export const laneFrameId = (boundary: string, layer: string) => `${boundary}\u0000lane:${layer}`

/**
 * The lanes of the apps expanded on a level: each layered module in an app's boundary goes in a frame of its layer
 * inside its boundary, so the app reads top to bottom: app layer → services → clients → lib. By module id.
 */
export function appLanes(d: ComponentDiagram, nodes: DNode[]): Map<string, { frame: string; boundary: string; layer: string }> {
  const lanes = new Map<string, { frame: string; boundary: string; layer: string }>()
  for (const n of nodes) if (n.layer && n.boundary && inApp(d, n.boundary)) lanes.set(n.id, { frame: laneFrameId(n.boundary, n.layer), boundary: n.boundary, layer: n.layer })
  return lanes
}
