// Project architecture: a tree of modules with the calls between them (T-27).

export type ArchLayer = 'app' | 'service' | 'client' | 'lib'

/** A dependency of a module: the module it uses and which of its methods it calls. */
export interface ArchUse {
  /** Id of any module in the tree. */
  to: string
  /** Methods of `to` it calls, e.g. "groom(taskId)". May be empty. */
  calls: string[]
}

export interface ArchNode {
  /** Stable id, unique in the whole tree (kebab-case). */
  id: string
  name: string
  /** Mostly on the top level: "Electron app", "database", "3rd-party API"… */
  kind?: string
  /** Modules inside an app. */
  layer?: ArchLayer
  /** Folder or file, relative to the repo. */
  path?: string
  /** One or two sentences: what it is responsible for. */
  description: string
  /** Public interface lines, e.g. "chargePlan(userId, plan): Charge  - charges and records the plan". */
  interface?: string[]
  uses: ArchUse[]
  /** Anything that breaks the layering or smells, in one line. */
  concern?: string
  /** Inner modules, any depth. */
  children?: ArchNode[]
}

/** Apps and outside runtimes (GitHub, a database, agent CLIs) are its top-level modules. */
export interface ArchDiagram {
  summary: string
  modules: ArchNode[]
  updatedAt: number
}

/** Layering rules of the mag pattern. null = allowed. */
export function layerRule(from: ArchLayer, to: ArchLayer): { severity: 'error' | 'warning'; rule: string } | null {
  if (from === 'service' && to === 'service') return { severity: 'error', rule: 'Services must not use other services' }
  if (from === 'client' && (to === 'client' || to === 'service')) return { severity: 'error', rule: `Clients must not use ${to}s` }
  if (from === 'lib' && (to === 'client' || to === 'service')) return { severity: 'error', rule: `Lib must not use ${to}s` }
  if (from !== 'app' && to === 'app') return { severity: 'error', rule: 'Core layers must not depend on the app layer' }
  if (from === 'app' && to === 'client') return { severity: 'warning', rule: 'App layer uses a client directly; go through a service' }
  return null
}

/** Visits every module depth-first; `ancestors` runs from the top level down to the module's parent. */
export function walkArch(nodes: ArchNode[], visit: (node: ArchNode, ancestors: ArchNode[]) => void, ancestors: ArchNode[] = []) {
  for (const n of nodes) {
    visit(n, ancestors)
    if (n.children?.length) walkArch(n.children, visit, [...ancestors, n])
  }
}

export function findNode(nodes: ArchNode[], id: string): ArchNode | undefined {
  return pathTo(nodes, id).at(-1)
}

/** The module and its ancestors, top level first (for breadcrumbs); [] when there is no such id. */
export function pathTo(nodes: ArchNode[], id: string): ArchNode[] {
  for (const n of nodes) {
    if (n.id === id) return [n]
    const inner = n.children ? pathTo(n.children, id) : []
    if (inner.length) return [n, ...inner]
  }
  return []
}

/** One arrow on a level of the tree. */
export interface ArchEdge {
  from: string
  to: string
  /** Methods called along this arrow, unique, in order of appearance. */
  calls: string[]
  /** 'out': `to` is outside the level, 'in': `from` is; such an end is drawn as a port. */
  port?: 'in' | 'out'
}

/**
 * Arrows among the children of `parentId` (the top level when null). Uses of inner modules fold into their ancestor
 * on this level. An end outside the level becomes a port: the outermost module on its path that is not an ancestor
 * of the level, so a call from inside an app to another app's service shows as a call to that app. Uses inside one
 * module of the level are not arrows here.
 */
export function edgesAt(nodes: ArchNode[], parentId: string | null): ArchEdge[] {
  const level = parentId ? pathTo(nodes, parentId) : []
  if (parentId && !level.length) return []
  const depth = level.length
  // The module that stands for `id` on this level, and whether it is a port.
  const anchor = (id: string): { id: string; port: boolean } | null => {
    const p = pathTo(nodes, id)
    if (!p.length) return null
    const inside = level.every((a, i) => p[i]?.id === a.id)
    if (inside) return p.length > depth ? { id: p[depth].id, port: false } : null // null: the level's own parent
    const split = p.findIndex((n, i) => n.id !== level[i]?.id)
    return split < 0 ? null : { id: p[split].id, port: true } // split < 0: an ancestor of the level
  }
  const edges = new Map<string, ArchEdge>()
  walkArch(nodes, (n) => {
    for (const u of n.uses) {
      const a = anchor(n.id)
      const b = anchor(u.to)
      if (!a || !b || a.id === b.id || (a.port && b.port)) continue
      const k = `${a.id}>${b.id}`
      let e = edges.get(k)
      if (!e) {
        e = { from: a.id, to: b.id, calls: [] }
        if (a.port) e.port = 'in'
        if (b.port) e.port = 'out'
        edges.set(k, e)
      }
      for (const c of u.calls) if (!e.calls.includes(c)) e.calls.push(c)
    }
  })
  return [...edges.values()]
}

/** The method name of an interface line or a call: "groom(taskId): void - …" → "groom". */
export function methodName(line: string): string {
  return line.trim().split(/[\s(:]/)[0]
}

/** Modules that use `id`, with what they call on it. */
export function callersOf(nodes: ArchNode[], id: string): { node: ArchNode; calls: string[] }[] {
  const out: { node: ArchNode; calls: string[] }[] = []
  walkArch(nodes, (n) => {
    const calls = n.uses.filter((u) => u.to === id).flatMap((u) => u.calls)
    if (n.uses.some((u) => u.to === id)) out.push({ node: n, calls })
  })
  return out
}
