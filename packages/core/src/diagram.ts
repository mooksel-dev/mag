// Task diagrams (T-27): typed data an agent records with show_diagram; mag renders them. Every element may carry a
// diff mark; an element without one is unchanged context.
import { useDiff, walkArch, type ArchNode, type ArchUse, type DiffMark, type Line } from './arch.ts'

export const DIFF_MARKS: DiffMark[] = ['add', 'mod', 'del']

/** A module of a Component diagram: an ArchNode with diff marks. */
export interface DNode extends Omit<ArchNode, 'interface' | 'uses' | 'children'> {
  diff?: DiffMark
  interface?: Line[]
  uses: DUse[]
  children?: DNode[]
}

export interface DUse extends Omit<ArchUse, 'calls'> {
  calls: Line[]
  diff?: DiffMark
}

export type MessageKind = 'call' | 'reply' | 'async'
export type FlowShape = 'start' | 'step' | 'decision' | 'end'

export interface ComponentDiagram {
  type: 'component'
  modules: DNode[]
}
export interface SequenceDiagram {
  type: 'sequence'
  participants: { id: string; label: string; kind?: string; diff?: DiffMark }[]
  messages: { from: string; to: string; text: string; kind: MessageKind; diff?: DiffMark }[]
}
export interface StateDiagram {
  type: 'state'
  entity: string
  states: { id: string; label: string; initial?: boolean; final?: boolean; diff?: DiffMark }[]
  transitions: { from: string; to: string; event: string; guard?: string; diff?: DiffMark }[]
}
export interface FlowchartDiagram {
  type: 'flowchart'
  nodes: { id: string; label: string; shape: FlowShape; diff?: DiffMark }[]
  edges: { from: string; to: string; label?: string; diff?: DiffMark }[]
}

export type Diagram = ComponentDiagram | SequenceDiagram | StateDiagram | FlowchartDiagram
export type DiagramType = Diagram['type']
export const DIAGRAM_TYPES: DiagramType[] = ['component', 'sequence', 'state', 'flowchart']

export interface DiffCount {
  add: number
  mod: number
  del: number
}

type Raw = Record<string, unknown>
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const lines = (v: unknown): Line[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { text: x } : { ...(x as Line), text: str((x as Line)?.text) })) : [])

/**
 * Lenient shape of what an agent passed: interface lines and calls given as plain strings become lines, a use given
 * as a string becomes `{ to, calls: [] }`, missing lists become empty. Run validateDiagram on the result.
 */
export function normalizeDiagram(raw: unknown): Diagram {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Raw
  switch (d.type) {
    case 'component': {
      const node = (n: Raw): DNode => {
        const out = { ...n, id: str(n.id), name: str(n.name ?? n.id), description: str(n.description) } as DNode
        if (n.interface !== undefined) out.interface = lines(n.interface)
        out.uses = (Array.isArray(n.uses) ? n.uses : []).map((u: unknown) =>
          typeof u === 'string' ? { to: u, calls: [] } : { ...(u as DUse), to: str((u as Raw)?.to), calls: lines((u as Raw)?.calls) },
        )
        if (Array.isArray(n.children) && n.children.length) out.children = arr(n.children).map(node)
        else delete out.children
        return out
      }
      return { type: 'component', modules: arr(d.modules).map(node) }
    }
    case 'sequence':
      return {
        type: 'sequence',
        participants: arr(d.participants).map((p) => ({ ...p, id: str(p.id), label: str(p.label ?? p.id) })),
        messages: arr(d.messages).map((m) => ({ ...m, from: str(m.from), to: str(m.to), text: str(m.text), kind: (m.kind ?? 'call') as MessageKind })),
      }
    case 'state':
      return {
        type: 'state',
        entity: str(d.entity),
        states: arr(d.states).map((s) => ({ ...s, id: str(s.id), label: str(s.label ?? s.id) })),
        transitions: arr(d.transitions).map((t) => ({ ...t, from: str(t.from), to: str(t.to), event: str(t.event) })),
      }
    case 'flowchart':
      return {
        type: 'flowchart',
        nodes: arr(d.nodes).map((n) => ({ ...n, id: str(n.id), label: str(n.label ?? n.id), shape: (n.shape ?? 'step') as FlowShape })),
        edges: arr(d.edges).map((e) => ({ ...e, from: str(e.from), to: str(e.to) })),
      }
    default:
      return d as unknown as Diagram
  }
}

/** Problems an agent must fix before the diagram is saved; [] when it is fine. */
export function validateDiagram(d: Diagram): string[] {
  const errors: string[] = []
  if (!DIAGRAM_TYPES.includes(d?.type)) return [`type must be one of ${DIAGRAM_TYPES.join(', ')}`]
  const mark = (what: string, m: unknown) => {
    if (m !== undefined && !DIFF_MARKS.includes(m as DiffMark)) errors.push(`${what}: diff must be one of ${DIFF_MARKS.join(', ')}`)
  }
  /** Ids of the elements, reporting empty and repeated ones. */
  const idsOf = (what: string, list: { id: string }[]) => {
    const ids = new Set<string>()
    for (const x of list) {
      if (!x.id) errors.push(`A ${what} has no id`)
      else if (ids.has(x.id)) errors.push(`Repeated ${what} id "${x.id}"`)
      ids.add(x.id)
    }
    return ids
  }
  const link = (what: string, ids: Set<string>, from: string, to: string) => {
    for (const end of [from, to]) if (!ids.has(end)) errors.push(`${what} ${from} → ${to}: no ${end ? `"${end}"` : 'id'}`)
  }

  switch (d.type) {
    case 'component': {
      if (!d.modules.length) errors.push('modules is empty')
      const all: DNode[] = []
      walkArch(d.modules, (n) => all.push(n))
      const ids = idsOf('module', all)
      for (const n of all) {
        mark(`Module ${n.id}`, n.diff)
        for (const l of n.interface ?? []) mark(`Interface line "${l.text}" of ${n.id}`, l.diff)
        for (const u of n.uses) {
          if (u.to === n.id) errors.push(`Module ${n.id} uses itself`)
          else if (!ids.has(u.to)) errors.push(`Module ${n.id} uses "${u.to}": no such module`)
          mark(`Use ${n.id} → ${u.to}`, u.diff)
          for (const c of u.calls) mark(`Call "${c.text}" of ${n.id} → ${u.to}`, c.diff)
        }
      }
      break
    }
    case 'sequence': {
      const ids = idsOf('participant', d.participants)
      for (const p of d.participants) mark(`Participant ${p.id}`, p.diff)
      d.messages.forEach((m, i) => {
        const what = `Message ${i + 1}`
        link(what, ids, m.from, m.to)
        mark(what, m.diff)
        if (!['call', 'reply', 'async'].includes(m.kind)) errors.push(`${what}: kind must be call, reply or async`)
      })
      // Each reply answers an open call, in the scenario before the change and after it. A reply also ends the calls
      // opened after the one it answers.
      for (const [skip, when] of [['del', 'after the change'], ['add', 'before the change']] as const) {
        const open: { from: string; to: string }[] = []
        d.messages.forEach((m, i) => {
          if (m.diff === skip) return
          if (m.kind === 'call') open.push(m)
          if (m.kind !== 'reply') return
          let at = open.length - 1
          while (at >= 0 && !(open[at].from === m.to && open[at].to === m.from)) at--
          if (at < 0) errors.push(`Message ${i + 1}: reply ${m.from} → ${m.to} without an open call ${m.to} → ${m.from} (${when})`)
          else open.splice(at)
        })
      }
      break
    }
    case 'state': {
      if (!d.entity) errors.push('entity is required')
      const ids = idsOf('state', d.states)
      for (const s of d.states) mark(`State ${s.id}`, s.diff)
      for (const t of d.transitions) {
        link('Transition', ids, t.from, t.to)
        mark(`Transition ${t.from} → ${t.to}`, t.diff)
        if (!t.event) errors.push(`Transition ${t.from} → ${t.to} has no event`)
      }
      break
    }
    case 'flowchart': {
      const ids = idsOf('node', d.nodes)
      for (const n of d.nodes) {
        mark(`Node ${n.id}`, n.diff)
        if (!['start', 'step', 'decision', 'end'].includes(n.shape)) errors.push(`Node ${n.id}: shape must be start, step, decision or end`)
      }
      for (const e of d.edges) {
        link('Edge', ids, e.from, e.to)
        mark(`Edge ${e.from} → ${e.to}`, e.diff)
      }
      break
    }
  }
  return errors
}

/** An activation bar on a lifeline: from the call at row `from` to its reply at row `to` (messages.length: never answered). */
export interface Activation {
  on: string
  from: number
  to: number
  /** Nesting on the lifeline: 0 the outermost bar; a call into a busy participant stacks on top. */
  depth: number
  diff?: DiffMark
}

export interface SequenceActivations {
  bars: Activation[]
  /** Per message: the depth of the bar it leaves from and arrives at; -1 on a bare lifeline. */
  ends: { from: number; to: number }[]
}

/**
 * Activation bars of a sequence: a call opens a bar on its target, the reply closes it (and the calls opened after
 * it, as validateDiagram allows). Replies are matched in the scenario before the change and after it, so a call
 * swapped for another (del + add) ends at the shared reply; a call left open in either scenario runs to the end.
 */
export function sequenceActivations(d: SequenceDiagram): SequenceActivations {
  const n = d.messages.length
  const end = d.messages.map(() => -1)
  for (const skip of ['del', 'add'] as const) {
    const open: number[] = []
    d.messages.forEach((m, i) => {
      if (m.diff === skip) return
      if (m.kind === 'call') open.push(i)
      if (m.kind !== 'reply') return
      let at = open.length - 1
      while (at >= 0 && !(d.messages[open[at]].from === m.to && d.messages[open[at]].to === m.from)) at--
      if (at >= 0) for (const c of open.splice(at)) end[c] = Math.max(end[c], i)
    })
    for (const c of open) end[c] = n
  }

  const bars: Activation[] = []
  /** The depth of the deepest bar on `p` opened before row `i` and still open at it; `closing`: one closed at `i` counts. */
  const deepest = (p: string, i: number, closing: boolean) =>
    bars.filter((b) => b.on === p && b.from < i && (closing ? b.to >= i : b.to > i)).reduce((top, b) => Math.max(top, b.depth), -1)
  const byMessage = new Map<number, Activation>()
  d.messages.forEach((m, i) => {
    if (m.kind !== 'call') return
    const bar: Activation = { on: m.to, from: i, to: end[i], depth: deepest(m.to, i, false) + 1, diff: m.diff }
    bars.push(bar)
    byMessage.set(i, bar)
  })

  const ends = d.messages.map((m, i) => {
    const from = deepest(m.from, i, true)
    if (m.kind === 'call') return { from, to: byMessage.get(i)!.depth }
    // A reply arrives at the caller's bar, not at one it closes (a self-reply closes its inner bar).
    return { from, to: deepest(m.to, i, m.kind !== 'reply') }
  })
  return { bars, ends }
}

const zero = (): DiffCount => ({ add: 0, mod: 0, del: 0 })
const count = (c: DiffCount, m: DiffMark | undefined) => m && c[m]++

/** A module's own change: its mark, else 'mod' when one of its interface lines changes. */
export function nodeDiff(n: DNode): DiffMark | undefined {
  return n.diff ?? (n.interface?.some((l) => l.diff) ? 'mod' : undefined)
}

/** Changes among modules and their uses; `all` resolves the targets of uses (see useDiff). */
function countNodes(nodes: DNode[], all: DNode[], c: DiffCount) {
  const byId = new Map<string, DNode>()
  walkArch(all, (n) => byId.set(n.id, n))
  walkArch(nodes, (n) => {
    count(c, nodeDiff(n))
    for (const u of n.uses) count(c, useDiff(n, u, byId.get(u.to)))
  })
  return c
}

/** Changed elements of a diagram: Component counts modules and uses, the others their nodes and links. */
export function diagramSummary(d: Diagram): DiffCount {
  const c = zero()
  switch (d.type) {
    case 'component':
      return countNodes(d.modules, d.modules, c)
    case 'sequence':
      for (const x of [...d.participants, ...d.messages]) count(c, x.diff)
      return c
    case 'state':
      for (const x of [...d.states, ...d.transitions]) count(c, x.diff)
      return c
    case 'flowchart':
      for (const x of [...d.nodes, ...d.edges]) count(c, x.diff)
      return c
  }
  return c
}

/** Changes inside a module of a Component diagram: its inner modules and their uses, not the module itself. */
export function innerSummary(node: DNode, all: DNode[]): DiffCount {
  return countNodes(node.children ?? [], all, zero())
}

/** "+2 ~1 −0"; '' when nothing changes. */
export function formatDiffCount(c: DiffCount): string {
  return c.add || c.mod || c.del ? `+${c.add} ~${c.mod} −${c.del}` : ''
}

/** The project architecture as an unmarked Component tree, for the shared renderer. */
export function archToDNodes(nodes: ArchNode[]): DNode[] {
  return nodes.map((n) => {
    const { interface: iface, uses, children, ...rest } = n
    const out: DNode = { ...rest, uses: uses.map((u) => ({ to: u.to, calls: u.calls.map((text) => ({ text })) })) }
    if (iface) out.interface = iface.map((text) => ({ text }))
    if (children?.length) out.children = archToDNodes(children)
    return out
  })
}
