// Task diagrams (T-27): typed data an agent records with show_diagram; mag renders them. Every element may carry a
// diff mark; an element without one is unchanged context.
import { methodName, useDiff, walkArch, type ArchNode, type ArchUse, type DiffMark, type Line } from './arch.ts'

export const DIFF_MARKS: DiffMark[] = ['add', 'mod', 'del']

/** The change of an interface line of a Component diagram: the diff marks plus move, a method that moved here. */
export type LineMark = DiffMark | 'move'
export const LINE_MARKS: LineMark[] = [...DIFF_MARKS, 'move']

/** An interface line of a Component diagram. A moved line sits in the module it moved to. */
export interface DLine extends Omit<Line, 'diff'> {
  diff?: LineMark
  /** With move: the id of the module it moved from. */
  from?: string
}

/** A module of a Component diagram: an ArchNode with diff marks. */
export interface DNode extends Omit<ArchNode, 'interface' | 'uses' | 'children'> {
  diff?: DiffMark
  interface?: DLine[]
  uses: DUse[]
  children?: DNode[]
}

export interface DUse extends Omit<ArchUse, 'calls'> {
  calls: Line[]
  diff?: DiffMark
  /** On a fact diagram: the PR's files the dependency rests on (T-58). */
  files?: string[]
}

export type MessageKind = 'call' | 'reply' | 'async'
export type FlowShape = 'start' | 'step' | 'decision' | 'end'

export interface ComponentDiagram {
  type: 'component'
  /** One or two sentences on what changes in substance; required on save, missing on diagrams saved before T-43. */
  summary?: string
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
  /** "<moduleId>#<method>": the method of a module on the task's Component diagram whose logic the flow shows. */
  of?: string
  /** "<moduleId>#<method>": for a new method, the one it replaces (usually removed). */
  replaces?: string
  /** What changes in the logic, short. */
  summary?: string
  /** The changes of the logic, one per item. */
  changes?: string[]
  nodes: { id: string; label: string; shape: FlowShape; diff?: DiffMark }[]
  edges: { from: string; to: string; label?: string; diff?: DiffMark }[]
}


/** A change on the Data diagram: the diff marks plus move, an entity or field that moved here from elsewhere. */
export type DataMark = DiffMark | 'move'
export const DATA_MARKS: DataMark[] = [...DIFF_MARKS, 'move']
export type EntityKind = 'collection' | 'table' | 'struct' | 'type'
export const ENTITY_KINDS: EntityKind[] = ['collection', 'table', 'struct', 'type']
export type Cardinality = '1:1' | '1:N' | 'N:1' | 'N:M' | 'ref'
export const CARDINALITIES: Cardinality[] = ['1:1', '1:N', 'N:1', 'N:M', 'ref']

/** One field, one line. A changed field is its old line del and its new line add. */
export interface DField {
  name: string
  type: string
  note?: string
  diff?: DataMark
  /** With move: the field it moved from, "<entity id>.<field name>" of another entity of the diagram. */
  from?: string
}
export interface DEntity {
  id: string
  name: string
  kind: EntityKind
  note?: string
  diff?: DataMark
  /** With move: the old id of the entity (renamed or moved), not an entity of the diagram. */
  from?: string
  fields: DField[]
}
export interface DRelation {
  from: string
  to: string
  kind: Cardinality
  /** The field of `from` that holds the link. */
  field?: string
  label?: string
  diff?: DiffMark
}
export interface DataDiagram {
  type: 'data'
  entities: DEntity[]
  relations: DRelation[]
}

export type Diagram = ComponentDiagram | SequenceDiagram | StateDiagram | FlowchartDiagram | DataDiagram
export type DiagramType = Diagram['type']
export const DIAGRAM_TYPES: DiagramType[] = ['component', 'sequence', 'state', 'flowchart', 'data']

export interface DiffCount {
  add: number
  mod: number
  del: number
  /** Moved entities, fields and interface lines. */
  move: number
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
      return { type: 'component', summary: str(d.summary).trim(), modules: arr(d.modules).map(node) }
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
    case 'flowchart': {
      const out: FlowchartDiagram = {
        type: 'flowchart',
        nodes: arr(d.nodes).map((n) => ({ ...n, id: str(n.id), label: str(n.label ?? n.id), shape: (n.shape ?? 'step') as FlowShape })),
        edges: arr(d.edges).map((e) => ({ ...e, from: str(e.from), to: str(e.to) })),
      }
      for (const k of ['of', 'replaces', 'summary'] as const) if (str(d[k]).trim()) out[k] = str(d[k]).trim()
      // A string of changes is one change per line; a non-string item is kept for validateDiagram to reject.
      if (typeof d.changes === 'string') out.changes = d.changes.split('\n').map((x) => x.trim()).filter(Boolean)
      else if (Array.isArray(d.changes)) out.changes = d.changes.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '')
      return out
    }
    case 'data':
      return {
        type: 'data',
        entities: arr(d.entities).map((e) => ({
          ...e,
          id: str(e.id),
          name: str(e.name ?? e.id),
          kind: (e.kind ?? 'collection') as EntityKind,
          // A field is always an object; a string one is kept as is for validateDiagram to reject.
          fields: (Array.isArray(e.fields) ? e.fields : []).map((f: unknown) =>
            f && typeof f === 'object' ? { ...(f as DField), name: str((f as Raw).name), type: str((f as Raw).type) } : (f as DField),
          ),
        })),
        relations: arr(d.relations).map((r) => ({ ...r, from: str(r.from), to: str(r.to), kind: (r.kind ?? 'ref') as Cardinality })),
      }
    default:
      return d as unknown as Diagram
  }
}

/** A field moved between two entities of a Data diagram. */
export interface FieldMove {
  from: { entity: string; field: string }
  to: { entity: string; field: string }
}

/**
 * Splits a "<entity id>.<field name>" reference on the entity it names; an entity id may hold dots itself
 * ("public.users.id"), the longest matching id wins. null when no entity has that field.
 */
export function fieldRef(entities: DEntity[], ref: string): { entity: string; field: string } | null {
  let best: { entity: string; field: string } | null = null
  for (const e of entities) {
    if (!ref.startsWith(`${e.id}.`) || (best && best.entity.length >= e.id.length)) continue
    const field = ref.slice(e.id.length + 1)
    if (e.fields.some((f) => f?.name === field)) best = { entity: e.id, field }
  }
  return best
}

/** The field moves of a Data diagram whose source resolves; validateDiagram reports the others. */
export function fieldMoves(d: DataDiagram): FieldMove[] {
  const out: FieldMove[] = []
  for (const e of d.entities)
    for (const f of e.fields) {
      if (f?.diff !== 'move' || !f.from) continue
      const from = fieldRef(d.entities, f.from)
      if (from && from.entity !== e.id) out.push({ from, to: { entity: e.id, field: f.name } })
    }
  return out
}

/** A field name that lists several fields ("a / b", "a, b", "old new"). */
const FIELD_GROUP = /[/,;\s]/

const OPEN = '([{<'
const CLOSE = ')]}>'
/** Where the description of a line starts: "name(args): Result - what it does". */
const DESCRIPTION = /^\s[-–—]\s/

/**
 * An interface line or a call that holds several methods ("get / ensureActive", "Get/EnsureActive/SetAgent") or prose
 * instead of a signature ("Users: DBR fields + their acquire/set methods"): its signature has names joined by "/", ","
 * or " + ". Arguments, generics, quoted text and the description after " - " may hold anything.
 */
export function looksGrouped(text: string): boolean {
  let sig = ''
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (`'"\``.includes(ch)) quote = ch
    else if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      if (DESCRIPTION.test(text.slice(i, i + 3))) break
      sig += ch
    }
  }
  // An HTTP route ("GET /users/:id") is one line, not names joined by "/".
  return /[/,]|\s\+\s/.test(sig.replace(/(^|\s)\/[\w:{.-]\S*/g, ' '))
}

const grouped = (what: string, signature: string) =>
  `one ${what} per line with its signature "${signature}", never several joined by "/", "," or "+"; a changed ${what} is a del line and an add line`

/** Problems an agent must fix before the diagram is saved; [] when it is fine. */
export function validateDiagram(d: Diagram): string[] {
  const errors: string[] = []
  if (!DIAGRAM_TYPES.includes(d?.type)) return [`type must be one of ${DIAGRAM_TYPES.join(', ')}`]
  const mark = (what: string, m: unknown) => {
    if (m !== undefined && !DIFF_MARKS.includes(m as DiffMark)) errors.push(`${what}: diff must be one of ${DIFF_MARKS.join(', ')}`)
  }
  const files = (what: string, f: unknown) => {
    if (f !== undefined && !(Array.isArray(f) && f.every((x) => typeof x === 'string' && x.trim()))) errors.push(`${what}: files must be a list of repo-relative paths`)
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
      if (!d.summary?.trim()) errors.push('summary is required: one or two sentences on what changes in substance')
      if (!d.modules.length) errors.push('modules is empty')
      const all: DNode[] = []
      walkArch(d.modules, (n) => all.push(n))
      const ids = idsOf('module', all)
      for (const n of all) {
        mark(`Module ${n.id}`, n.diff)
        for (const l of n.interface ?? []) {
          const what = `Interface line "${l.text}" of ${n.id}`
          files(what, l.files)
          if (l.diff !== undefined && !LINE_MARKS.includes(l.diff)) errors.push(`${what}: diff must be one of ${LINE_MARKS.join(', ')}`)
          if (looksGrouped(l.text)) errors.push(`${what}: ${grouped('method', 'name(args): Result - what it does')}`)
          if (l.diff === 'move') {
            if (!l.from) errors.push(`${what}: move needs from, the id of the module it moved from`)
            else if (l.from === n.id) errors.push(`${what}: moved from ${n.id} itself; a changed method is a del line and an add line`)
            else if (!ids.has(l.from)) errors.push(`${what}: moved from "${l.from}", no such module`)
          } else if (l.from) errors.push(`${what}: from is only for diff move`)
        }
        for (const u of n.uses) {
          if (u.to === n.id) errors.push(`Module ${n.id} uses itself`)
          else if (!ids.has(u.to)) errors.push(`Module ${n.id} uses "${u.to}": no such module`)
          mark(`Use ${n.id} → ${u.to}`, u.diff)
          files(`Use ${n.id} → ${u.to}`, u.files)
          for (const c of u.calls) {
            const what = `Call "${c.text}" of ${n.id} → ${u.to}`
            mark(what, c.diff)
            files(what, c.files)
            if (looksGrouped(c.text)) errors.push(`${what}: ${grouped('call', 'name(args)')}`)
          }
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
      for (const k of ['of', 'replaces'] as const)
        if (d[k] !== undefined && !parseFlowRef(d[k]!)) errors.push(`${k} must be "<moduleId>#<method>", the method name without arguments; got "${d[k]}"`)
      if (d.changes !== undefined && (!Array.isArray(d.changes) || d.changes.some((x) => typeof x !== 'string')))
        errors.push('changes must be a list of strings, one change per item')
      break
    }
    case 'data': {
      if (!d.entities.length) errors.push('entities is empty')
      const ids = idsOf('entity', d.entities)
      const dataMark = (what: string, m: unknown) => {
        if (m !== undefined && !DATA_MARKS.includes(m as DataMark)) errors.push(`${what}: diff must be one of ${DATA_MARKS.join(', ')}`)
      }
      for (const e of d.entities) {
        const what = `Entity ${e.id}`
        dataMark(what, e.diff)
        if (!ENTITY_KINDS.includes(e.kind)) errors.push(`${what}: kind must be one of ${ENTITY_KINDS.join(', ')}`)
        if (e.diff === 'move') {
          if (!e.from) errors.push(`${what}: move needs from, the old id of the entity`)
          else if (ids.has(e.from)) errors.push(`${what}: moved from "${e.from}", which is an entity of this diagram; mark its fields with move instead`)
        } else if (e.from) errors.push(`${what}: from is only for diff move`)
        const names = new Set<string>()
        for (const f of e.fields) {
          if (!f || typeof f !== 'object') {
            errors.push(`${what}: field ${JSON.stringify(f)} must be an object { name, type }; one field per line`)
            continue
          }
          const fw = `Field "${f.name}" of ${e.id}`
          if (!f.name) errors.push(`${what}: a field has no name`)
          else if (FIELD_GROUP.test(f.name.trim())) errors.push(`${fw}: one field per line; a changed field is a del line and an add line`)
          else if (names.has(f.name)) errors.push(`${what}: repeated field "${f.name}"`)
          names.add(f.name)
          if (!f.type) errors.push(`${fw} has no type`)
          dataMark(fw, f.diff)
          if (f.diff === 'move') {
            if (!f.from) {
              errors.push(`${fw}: move needs from, "<entity>.<field>" it moved from`)
              continue
            }
            const src = fieldRef(d.entities, f.from)
            if (!src) errors.push(`${fw}: moved from "${f.from}", no such field; give "<entity>.<field>" of this diagram`)
            else if (src.entity === e.id) errors.push(`${fw}: moved within ${e.id}; a renamed field is a del line and an add line`)
            else if (d.entities.find((x) => x.id === src.entity)!.fields.find((x) => x?.name === src.field)!.diff === 'add')
              errors.push(`${fw}: moved from "${f.from}", which is added; mark the source as it was`)
          } else if (f.from) errors.push(`${fw}: from is only for diff move`)
        }
      }
      for (const r of d.relations) {
        const what = `Relation ${r.from} → ${r.to}`
        link('Relation', ids, r.from, r.to)
        mark(what, r.diff)
        if (!CARDINALITIES.includes(r.kind)) errors.push(`${what}: kind must be one of ${CARDINALITIES.join(', ')}`)
        const src = d.entities.find((e) => e.id === r.from)
        if (r.field && src && !src.fields.some((f) => f?.name === r.field)) errors.push(`${what}: no field "${r.field}" in ${r.from}`)
      }
      break
    }
  }
  return errors
}

/** The module and method of a flowchart's of or replaces ("<moduleId>#<method>"); null when either part is missing. */
export function parseFlowRef(ref: string): { module: string; method: string } | null {
  const at = ref.lastIndexOf('#')
  const module = ref.slice(0, at).trim()
  const method = ref.slice(at + 1).trim()
  return at > 0 && module && method && !/[\s(]/.test(method) ? { module, method } : null
}

/** A flow of a module's method, among the task's diagrams. */
export interface MethodFlow<T> {
  method: string
  item: T
}

/** The flowcharts among `diagrams` that show a method of `moduleId` (their of), in order. */
export function methodFlows<T extends { diagram: Diagram }>(diagrams: T[], moduleId: string): MethodFlow<T>[] {
  const out: MethodFlow<T>[] = []
  for (const item of diagrams) {
    const ref = item.diagram.type === 'flowchart' && item.diagram.of ? parseFlowRef(item.diagram.of) : null
    if (ref?.module === moduleId) out.push({ method: ref.method, item })
  }
  return out
}

/**
 * The change of a method with a flow: added or removed when its interface lines are only so, else changed; a method
 * not in the interface takes an added or removed module's mark.
 */
export function flowDiff(n: DNode, method: string): DiffMark {
  const lines = (n.interface ?? []).filter((l) => methodName(l.text) === method)
  const marks = new Set(lines.map((l) => l.diff))
  if (!lines.length && (n.diff === 'add' || n.diff === 'del')) return n.diff
  return marks.has('add') && !marks.has('del') ? 'add' : marks.has('del') && !marks.has('add') ? 'del' : 'mod'
}

/** The flows of methods for the "flows" chip of a Component diff: each flow whose module is among `modules`, by flowDiff. */
export function flowsSummary(diagrams: { diagram: Diagram }[], modules: DNode[]): DiffCount {
  const c = zero()
  walkArch(modules, (n) => {
    for (const f of methodFlows(diagrams, n.id)) c[flowDiff(n, f.method)]++
  })
  return c
}

export type FlowView = 'diff' | 'before' | 'after'

/**
 * A flowchart as it was (before: without added elements) or as it becomes (after: without removed ones), both with
 * no marks; an edge goes away with its node. diff: as is.
 */
export function flowchartAs(d: FlowchartDiagram, view: FlowView): FlowchartDiagram {
  if (view === 'diff') return d
  const gone = view === 'before' ? 'add' : 'del'
  const nodes = d.nodes.filter((n) => n.diff !== gone).map(({ diff: _, ...n }) => n)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = d.edges.filter((e) => e.diff !== gone && ids.has(e.from) && ids.has(e.to)).map(({ diff: _, ...e }) => e)
  return { ...d, nodes, edges }
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

const zero = (): DiffCount => ({ add: 0, mod: 0, del: 0, move: 0 })
const count = (c: DiffCount, m: DataMark | undefined) => m && c[m]++

/** Counts changed lines of one list; a del and an add of the same method in it count once as mod. */
function countLines(c: DiffCount, list: { text: string; diff?: LineMark }[]) {
  const dels = new Map<string, number>()
  const adds = new Map<string, number>()
  for (const l of list) {
    const tally = l.diff === 'del' ? dels : l.diff === 'add' ? adds : null
    if (tally) tally.set(methodName(l.text), (tally.get(methodName(l.text)) ?? 0) + 1)
    else count(c, l.diff)
  }
  for (const [name, n] of dels) {
    const paired = Math.min(n, adds.get(name) ?? 0)
    c.mod += paired
    c.del += n - paired
    adds.set(name, (adds.get(name) ?? 0) - paired)
  }
  for (const n of adds.values()) c.add += n
}

const addCount = (c: DiffCount, d: DiffCount) => {
  for (const k of ['add', 'mod', 'del', 'move'] as const) c[k] += d[k]
}

/** The counts behind the chips of a Component diff: modules, interface methods and calls. */
export interface ComponentSummary {
  modules: DiffCount
  methods: DiffCount
  calls: DiffCount
}

/**
 * What changes on a Component diagram, by kind. A module counts its own change (nodeDiff). A del line and an add line
 * of the same method in one module (calls: in one use) count once as mod; a moved line counts once as move. Calls of
 * an added or removed use take its mark.
 */
export function componentSummary(d: ComponentDiagram): ComponentSummary {
  const out: ComponentSummary = { modules: zero(), methods: zero(), calls: zero() }
  const byId = new Map<string, DNode>()
  walkArch(d.modules, (n) => byId.set(n.id, n))
  walkArch(d.modules, (n) => {
    count(out.modules, nodeDiff(n))
    countLines(out.methods, n.interface ?? [])
    for (const u of n.uses) addCount(out.calls, callsCount({ ...u, diff: useDiff(n, u, byId.get(u.to)) }))
  })
  return out
}

/**
 * The changed calls of a use, for the count pill on its arrow. A call without a mark takes the one of the use when it
 * is added or removed, else the one of an added or removed `target` (as useDiff); a del and an add of the same method
 * count once as mod.
 */
export function callsCount(use: DUse, target?: DNode): DiffCount {
  const whole = (m?: DiffMark) => (m === 'add' || m === 'del' ? m : undefined)
  const m = whole(use.diff) ?? whole(target?.diff)
  const c = zero()
  countLines(c, use.calls.map((x) => ({ text: x.text, diff: x.diff ?? m })))
  return c
}

/** The mark a count is mostly made of, for the color of its pill; on a tie mod wins over add, add over del. */
export function dominantDiff(c: DiffCount): DiffMark | undefined {
  let best: DiffMark | undefined
  for (const k of ['mod', 'add', 'del'] as const) if (c[k] > (best ? c[best] : 0)) best = k
  return best
}

/** An interface line moved between two modules of a Component diagram. */
export interface Move {
  line: DLine
  from: string
  to: string
}

/** The moved interface lines of a Component diagram whose source is another module of it; validateDiagram reports the others. */
export function moves(d: ComponentDiagram): Move[] {
  const ids = new Set<string>()
  walkArch(d.modules, (n) => ids.add(n.id))
  const out: Move[] = []
  walkArch(d.modules, (n) => {
    for (const l of n.interface ?? []) if (l.diff === 'move' && l.from && l.from !== n.id && ids.has(l.from)) out.push({ line: l, from: l.from, to: n.id })
  })
  return out
}

/** A changed line on a box; `to` marks a line that moved out of the box to that module. */
export type BoxLine = DLine & { to?: string }

/** How many changed lines a box shows; the rest is "+N" and the details panel. */
export const BOX_LINES = 3

/**
 * The changed interface lines of a module for its box, in order: its own (add, del, mod, move in), then, given the
 * whole diagram, the lines that moved out of it. At most BOX_LINES; `more` is how many are left out.
 */
export function boxLines(n: DNode, d?: ComponentDiagram): { shown: BoxLine[]; more: number } {
  const all: BoxLine[] = (n.interface ?? []).filter((l) => l.diff)
  if (d) for (const m of moves(d)) if (m.from === n.id) all.push({ ...m.line, to: m.to })
  return { shown: all.slice(0, BOX_LINES), more: Math.max(0, all.length - BOX_LINES) }
}

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

/** Changed elements of a diagram: Component counts modules and uses, Data its entities, fields and relations, the others their nodes and links. */
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
    case 'data':
      for (const x of [...d.entities, ...d.entities.flatMap((e) => e.fields), ...d.relations]) count(c, x?.diff)
      return c
  }
  return c
}

/** Changes inside a module of a Component diagram: its inner modules and their uses, not the module itself. */
export function innerSummary(node: DNode, all: DNode[]): DiffCount {
  return countNodes(node.children ?? [], all, zero())
}

/** "+2 ~1 −0", with " ↷1" when something moved; '' when nothing changes. */
export function formatDiffCount(c: DiffCount): string {
  if (!c.add && !c.mod && !c.del && !c.move) return ''
  return `+${c.add} ~${c.mod} −${c.del}${c.move ? ` ↷${c.move}` : ''}`
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
