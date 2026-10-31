// What a Component diff shows on the diagram itself (T-43): which modules fold into the "Без змін" row, the call
// names on changed arrows and the move arrows of one level.
import { methodName, moves, nodeDiff, pathTo, type ArchEdge, type ComponentDiagram, type DiffMark, type DNode } from '@mag/core'

/** How many call names a changed arrow shows; the rest is "+N". */
export const EDGE_CALLS = 3

/** Ids of the modules something moved out of. */
export function movedOut(d: ComponentDiagram): Set<string> {
  return new Set(moves(d).map((m) => m.from))
}

/**
 * Whether a module changes and keeps its box in a diff: it is marked, one of its interface lines changes or moves
 * out, one of its own uses or calls is marked, or the same holds for one of its inner modules.
 */
export function changedModule(n: DNode, out: Set<string>): boolean {
  const own = !!nodeDiff(n) || out.has(n.id) || n.uses.some((u) => u.diff || u.calls.some((c) => c.diff))
  return own || !!n.children?.some((c) => changedModule(c, out))
}

/**
 * The changed calls of an arrow, for its label instead of the count: one name per method, a del and an add of the
 * same method as one mod. null for an unchanged arrow or one with no changed call of its own (it keeps the count).
 */
export function edgeCalls(e: ArchEdge): { calls: { name: string; mark: DiffMark }[]; more: number } | null {
  if (!e.diff || !e.callDiff) return null
  const marks = new Map<string, DiffMark>()
  for (const c of e.calls) {
    const m = e.callDiff[c]
    if (!m) continue
    const name = methodName(c)
    const was = marks.get(name)
    marks.set(name, was && was !== m ? 'mod' : m)
  }
  if (!marks.size) return null
  const calls = [...marks].map(([name, mark]) => ({ name, mark }))
  return { calls: calls.slice(0, EDGE_CALLS), more: Math.max(0, calls.length - EDGE_CALLS) }
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

/** The modules of one level that fold into the "Без змін" row of a diff. */
export function unchangedAt(d: ComponentDiagram, nodes: DNode[]): Set<string> {
  const out = movedOut(d)
  const ids = new Set<string>()
  for (const n of nodes) if (!changedModule(n, out)) ids.add(n.id)
  return ids
}
