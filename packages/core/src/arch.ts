// Project architecture: a tree of modules with the calls between them (T-27).

export type ArchLayer = 'app' | 'service' | 'client' | 'lib'

/** 'system': an app, an outside runtime or a 3rd-party service; 'module': a part of one (T-57.2). */
export type ArchLevel = 'system' | 'module'

/** How an element of a task diagram changes; no mark = unchanged context. */
export type DiffMark = 'add' | 'mod' | 'del'

/** A line of text with its change, e.g. an interface method. A changed line is the old one `del` and the new one `add`. */
export interface Line {
  text: string
  diff?: DiffMark
}

/** What the tree helpers need of a module: the architecture's ArchNode and a Component diagram's DNode alike. */
export interface TreeNode<N> {
  id: string
  uses: { to: string; calls: (string | Line)[]; diff?: DiffMark }[]
  children?: N[]
  diff?: DiffMark
}

const callText = (c: string | Line) => (typeof c === 'string' ? c : c.text)

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
  /** System or a module of one; recorded architectures have it on every module (T-57.2). */
  level?: ArchLevel
  /** Folders, files or globs relative to the repo: the code it owns. A file belongs to the most specific match (T-57.2). */
  paths?: string[]
  /** Before T-57.2: one folder or file, relative to the repo. Diagrams still use it. */
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

/** Gives modules new ids (`from` → `to`), in the uses pointing at them too. */
export function renameIds<N extends { id: string; uses: { to: string }[]; children?: N[] }>(nodes: N[], ids: Map<string, string>): N[] {
  if (!ids.size) return nodes
  return nodes.map((n) => ({
    ...n,
    id: ids.get(n.id) ?? n.id,
    uses: n.uses.map((u) => (ids.has(u.to) ? { ...u, to: ids.get(u.to)! } : u)),
    ...(n.children && { children: renameIds(n.children, ids) }),
  }))
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
export function walkArch<N extends { children?: N[] }>(nodes: N[], visit: (node: N, ancestors: N[]) => void, ancestors: N[] = []) {
  for (const n of nodes) {
    visit(n, ancestors)
    if (n.children?.length) walkArch(n.children, visit, [...ancestors, n])
  }
}

export function findNode<N extends { id: string; children?: N[] }>(nodes: N[], id: string): N | undefined {
  return pathTo(nodes, id).at(-1)
}

/** The module and its ancestors, top level first (for breadcrumbs); [] when there is no such id. */
export function pathTo<N extends { id: string; children?: N[] }>(nodes: N[], id: string): N[] {
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
  /** Diagrams only: the change of the uses behind the arrow; mixed changes make it 'mod'. */
  diff?: DiffMark
  /** Diagrams only: the change of each call that has one, by its text. */
  callDiff?: Record<string, DiffMark>
}

/**
 * The change of a use: its own mark, else the one of a module at either end that is added or removed, else 'mod'
 * when one of its calls changes.
 */
export function useDiff<N extends TreeNode<N>>(from: N, use: N['uses'][number], to: N | undefined): DiffMark | undefined {
  const whole = (m?: DiffMark) => (m === 'add' || m === 'del' ? m : undefined)
  return use.diff ?? whole(from.diff) ?? whole(to?.diff) ?? (use.calls.some((c) => typeof c !== 'string' && c.diff) ? 'mod' : undefined)
}

/** One mark for several: the common one, 'mod' when they differ and any is marked. */
function combine(marks: (DiffMark | undefined)[]): DiffMark | undefined {
  if (!marks.some(Boolean)) return undefined
  return marks.every((m) => m === marks[0]) ? marks[0] : 'mod'
}

/**
 * Arrows among the children of `parentId` (the top level when null). Uses of inner modules fold into their ancestor
 * on this level. An end outside the level becomes a port: the outermost module on its path that is not an ancestor
 * of the level, so a call from inside an app to another app's service shows as a call to that app. Uses inside one
 * module of the level are not arrows here.
 */
export function edgesAt<N extends TreeNode<N>>(nodes: N[], parentId: string | null): ArchEdge[] {
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
  const byId = new Map<string, N>()
  walkArch(nodes, (n) => byId.set(n.id, n))
  const edges = new Map<string, ArchEdge>()
  const marks = new Map<string, (DiffMark | undefined)[]>()
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
        marks.set(k, [])
      }
      const m = useDiff(n, u, byId.get(u.to))
      marks.get(k)!.push(m)
      for (const c of u.calls) {
        const text = callText(c)
        if (!e.calls.includes(text)) e.calls.push(text)
        const cm = (typeof c !== 'string' && c.diff) || (m === 'add' || m === 'del' ? m : undefined)
        if (cm && !e.callDiff?.[text]) e.callDiff = { ...e.callDiff, [text]: cm }
      }
    }
  })
  for (const [k, e] of edges) {
    const m = combine(marks.get(k)!)
    if (m) e.diff = m
  }
  return [...edges.values()]
}

/** The method name of an interface line or a call: "groom(taskId): void - …" → "groom". */
export function methodName(line: string): string {
  return line.trim().split(/[\s(:]/)[0]
}

/** Modules that use `id`, with what they call on it. */
export function callersOf<N extends TreeNode<N>>(nodes: N[], id: string): { node: N; calls: string[] }[] {
  const out: { node: N; calls: string[] }[] = []
  walkArch(nodes, (n) => {
    const calls = n.uses.filter((u) => u.to === id).flatMap((u) => u.calls.map(callText))
    if (n.uses.some((u) => u.to === id)) out.push({ node: n, calls })
  })
  return out
}
