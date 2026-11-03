// The fact of code changes as a change inventory (diff-iak-inventar-zmin-ai.1): a flat list of what a PR changed, written
// by the reviewer from the diff, each unit citing the blocks of changed lines it rests on. mag checks it against the
// hunks (@mag/diff checkInventory) and generates the fact's Component and Data diagrams from it; the reviewer draws only
// scenarios and method logic.
import { findNode, type ArchNode } from './arch.ts'
import type { ComponentDiagram, DataDiagram, DEntity, DField, DLine, DNode, DiagramLink, SequenceDiagram } from './diagram.ts'

export type UnitKind = 'method' | 'model' | 'field' | 'index' | 'dependency' | 'config' | 'template'
export const UNIT_KINDS: UnitKind[] = ['method', 'model', 'field', 'index', 'dependency', 'config', 'template']
export type UnitChange = 'add' | 'mod' | 'del' | 'rename'
export const UNIT_CHANGES: UnitChange[] = ['add', 'mod', 'del', 'rename']
/** nontrivial: branches, loops, error handling, external calls or data access changed; trivial: wiring, one-liners; none: only the signature. */
export type UnitLogic = 'none' | 'trivial' | 'nontrivial'
export const UNIT_LOGIC: UnitLogic[] = ['none', 'trivial', 'nontrivial']

/** One change of the inventory, at the level a reviewer designs at. */
export interface InventoryUnit {
  id: string
  kind: UnitKind
  /** The module of the hunks it rests on, as the hunk listing names it. */
  module: string
  /** method: the type, class or file it belongs to; field / index: the model it is on. */
  owner?: string
  /** method / model: its name; field: `<model>.<field>`; dependency: the module or package used; config: the constant. */
  name: string
  change: UnitChange
  visibility?: 'public' | 'private'
  /** The old signature (field type, definition), one line; none for add. */
  before?: string
  /** The new one; none for del. */
  after?: string
  /** rename: the old name. */
  from?: string
  /** method: how much of its logic changes. */
  logic?: UnitLogic
  /** model / field: persisted data (a table, collection, document, cache entry), not an argument or DTO. */
  stored?: boolean
  /** The ids of the blocks of changed lines it rests on (`H3.1`; `H3` for every block of the hunk). */
  hunks: string[]
  note?: string
}

/** Blocks of changed lines that are no change of the design, with why: formatting, comments, tests, generated code. */
export interface InventoryNoise {
  hunks: string[]
  reason: string
}

export interface ChangeInventory {
  /** 3–6 short bullets: what the change does, by meaning. */
  summary: string[]
  units: InventoryUnit[]
  noise: InventoryNoise[]
}

type Raw = Record<string, unknown>
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const ids = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(/[\s,]+/).filter(Boolean) : [])

/**
 * An inventory from what an agent passed (an object or its JSON), with what is wrong in it. Lenient where it can be:
 * `runs` reads as `hunks` (the spike's format), a missing unit id becomes `u<n>`; strict on what the check needs.
 */
export function normalizeInventory(raw: unknown): { inventory: ChangeInventory; errors: string[] } {
  const errors: string[] = []
  let o = raw
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o)
    } catch {
      return { inventory: { summary: [], units: [], noise: [] }, errors: ['inventory must be an object (or its JSON)'] }
    }
  }
  const r = (o && typeof o === 'object' ? o : {}) as Raw
  const summary = (Array.isArray(r.summary) ? r.summary : typeof r.summary === 'string' ? [r.summary] : []).map(text).filter(Boolean)
  if (!summary.length) errors.push('summary is required: 3–6 short bullets on what the change does, by meaning')
  const seen = new Set<string>()
  const units = (Array.isArray(r.units) ? (r.units as Raw[]) : []).map((u, i): InventoryUnit => {
    const id = text(u?.id) || `u${i + 1}`
    const what = `Unit ${id}`
    if (seen.has(id)) errors.push(`${what}: repeated id`)
    seen.add(id)
    const kind = text(u?.kind) as UnitKind
    const change = text(u?.change) as UnitChange
    const out: InventoryUnit = { id, kind, module: text(u?.module), name: text(u?.name), change, hunks: ids(u?.hunks ?? u?.runs) }
    if (!UNIT_KINDS.includes(kind)) errors.push(`${what}: kind must be one of ${UNIT_KINDS.join(', ')}`)
    if (!UNIT_CHANGES.includes(change)) errors.push(`${what}: change must be one of ${UNIT_CHANGES.join(', ')}`)
    if (!out.name) errors.push(`${what}: name is required, copied from the diff`)
    if (!out.module) errors.push(`${what} (${out.name}): module is required, the module of its hunks as the listing names it`)
    if (!out.hunks.length) errors.push(`${what} (${out.name}): hunks is required, the ids of the blocks of changed lines it rests on`)
    for (const k of ['owner', 'before', 'after', 'from', 'note'] as const) if (text(u?.[k])) out[k] = text(u[k])
    const visibility = text(u?.visibility)
    if (visibility === 'public' || visibility === 'private') out.visibility = visibility
    else if (visibility) errors.push(`${what}: visibility must be public or private`)
    const logic = text(u?.logic) as UnitLogic
    if (logic && !UNIT_LOGIC.includes(logic)) errors.push(`${what}: logic must be one of ${UNIT_LOGIC.join(', ')}`)
    else if (logic) out.logic = logic
    else if (kind === 'method') errors.push(`${what} (${out.name}): a method needs logic: ${UNIT_LOGIC.join(', ')}`)
    if (u?.stored !== undefined) out.stored = u.stored === true
    if (change === 'rename' && !out.from) errors.push(`${what} (${out.name}): rename needs from, the old name`)
    if (change !== 'rename' && out.from) errors.push(`${what} (${out.name}): from is only for rename`)
    return out
  })
  if (!Array.isArray(r.units)) errors.push('units must be a list')
  const noise = (Array.isArray(r.noise) ? (r.noise as Raw[]) : []).map((n, i): InventoryNoise => {
    const out = { hunks: ids(n?.hunks ?? n?.runs), reason: text(n?.reason) }
    if (!out.hunks.length) errors.push(`noise[${i}]: hunks is required`)
    if (!out.reason) errors.push(`noise[${i}]: reason is required, one line on why it is no change of the design`)
    return out
  })
  return { inventory: { summary, units, noise }, errors }
}

/** The last segment of a dotted, slashed or `#` name: `save` of `dar_jobs.Repository.save`. */
export const unitLeaf = (name: string) => name.split(/[.#/:]/).filter(Boolean).at(-1) ?? name

/** Units that land on the Data diagram: stored models and fields, and indexes. */
export const isDataUnit = (u: Pick<InventoryUnit, 'kind' | 'stored'>) => u.kind === 'index' || ((u.kind === 'model' || u.kind === 'field') && u.stored === true)

/** A method unit whose logic changes so that a flowchart may show it: the only `of` a fact flowchart may have. */
export function logicUnit(inventory: ChangeInventory, module: string, method: string): InventoryUnit | undefined {
  return inventory.units.find((u) => u.kind === 'method' && u.logic === 'nontrivial' && u.module === module && unitLeaf(u.name) === method)
}

export interface InventoryDiagramOptions {
  /** The files (paths) the blocks with these ids are in. */
  filesOf?: (hunks: string[]) => string[]
  /** The id of the generated Data diagram: the modules that own its entities link to it. */
  dataId?: string
  /** Sequence diagrams of the set: a module that takes part in one (a participant with its id) links to it. */
  scenarios?: { id: string; diagram: SequenceDiagram }[]
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The signature as a line about the unit's name: from the name on when the signature names it (`func (r *Repo)
 * Save(ctx) error` → `Save(ctx) error`), else `<name>: <signature>`; just the name without one.
 */
function lineText(u: InventoryUnit, sig: string | undefined, name = unitLeaf(u.name)): string {
  const s = norm(sig ?? '')
  if (!s) return u.kind === 'config' || u.kind === 'template' ? u.name : name
  const at = s.search(new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}\\s*[(<:]`))
  if (at >= 0) return s.slice(at + (/[\w$]/.test(s[at]) ? 0 : 1))
  return u.kind === 'config' || u.kind === 'template' ? `${u.name}: ${s}` : `${name}: ${s}`
}

/** A unit's lines in its module: a changed signature is a del and an add line, a rename one move line. */
function unitLines(u: InventoryUnit, files: string[]): DLine[] {
  const extra: Partial<DLine> = {
    ...(files.length && { files }),
    ...(u.kind === 'method' && u.logic === 'nontrivial' && { logic: true }),
    ...(u.visibility === 'private' && { private: true }),
  }
  if (u.change === 'rename') return [{ text: lineText(u, u.after ?? u.before), diff: 'move', from: `${u.module}#${unitLeaf(u.from!)}`, ...extra }]
  if (u.change === 'add') return [{ text: lineText(u, u.after), diff: 'add', ...extra }]
  if (u.change === 'del') return [{ text: lineText(u, u.before), diff: 'del', ...extra }]
  if (u.before && u.after && norm(u.before) !== norm(u.after))
    return [
      { text: lineText(u, u.before), diff: 'del', ...extra },
      { text: lineText(u, u.after), diff: 'add', ...extra },
    ]
  return [{ text: lineText(u, u.after ?? u.before), diff: 'mod', ...extra }]
}

/** A module of the fact: named as the architecture has it; an id it does not have is new (or outside the project). */
function moduleNode(id: string, architecture: ArchNode[], known: boolean): DNode {
  const arch = findNode(architecture, id)
  return {
    id,
    name: arch?.name ?? id,
    description: arch?.description ?? '',
    ...(arch?.layer && { layer: arch.layer }),
    ...(arch?.kind && { kind: arch.kind }),
    uses: [],
    ...(known && !arch && architecture.length ? { diff: 'add' as const } : {}),
  }
}

/** Links of the modules of a Component diagram to the scenarios they take part in; earlier scenario links are replaced. */
export function withScenarioLinks(d: ComponentDiagram, scenarios: { id: string; diagram: SequenceDiagram }[]): ComponentDiagram {
  const ids = new Set(scenarios.map((s) => s.id))
  return {
    ...d,
    modules: d.modules.map((n) => {
      const keep = (n.links ?? []).filter((l) => !(l.kind === 'scenario' && ids.has(l.to)))
      const add: DiagramLink[] = scenarios.filter((s) => s.diagram.participants.some((p) => p.id === n.id)).map((s) => ({ to: s.id, node: n.id, kind: 'scenario' }))
      const links = [...keep, ...add]
      const { links: _, ...rest } = n
      return links.length ? { ...rest, links } : rest
    }),
  }
}

const entityOf = (u: InventoryUnit) => (u.kind === 'model' ? u.name : (u.owner ?? (u.name.includes('.') ? u.name.slice(0, u.name.lastIndexOf('.')) : u.name)))

/**
 * The fact's Component and Data diagrams, generated from an inventory (never drawn): Component has the modules of the
 * units, each with its changed lines (signature and mark, a logic badge for nontrivial logic, private) and its
 * dependency units as marked uses; Data has the stored models, fields and indexes, each entity in the module that owns
 * it. Lines carry the files of their hunks. data is null when nothing stored changes.
 */
export function inventoryDiagrams(inventory: ChangeInventory, architecture: ArchNode[], options: InventoryDiagramOptions = {}): { component: ComponentDiagram; data: DataDiagram | null } {
  const filesOf = options.filesOf ?? (() => [])
  const modules = new Map<string, DNode>()
  const node = (id: string, own = true) => {
    let n = modules.get(id)
    if (!n) modules.set(id, (n = moduleNode(id, architecture, own)))
    return n
  }
  const entities = new Map<string, DEntity>()
  const entity = (u: InventoryUnit) => {
    const name = entityOf(u)
    const id = unitLeaf(name)
    let e = entities.get(id)
    if (!e) entities.set(id, (e = { id, name: id, kind: 'table', module: u.module, fields: [] }))
    return e
  }
  for (const u of inventory.units) {
    if (u.kind === 'dependency') continue
    const files = filesOf(u.hunks)
    if (!isDataUnit(u)) {
      const n = node(u.module)
      n.interface = [...(n.interface ?? []), ...unitLines(u, files)]
      continue
    }
    node(u.module)
    const e = entity(u)
    if (u.kind === 'model') {
      e.diff = u.change === 'rename' ? 'move' : u.change
      if (u.change === 'rename') e.from = unitLeaf(u.from!)
      if (u.note) e.note = u.note
    } else if (u.kind === 'field') {
      const name = unitLeaf(u.name)
      const field = (type: string | undefined, diff: DField['diff']): DField => ({ name, type: norm(type ?? '') || '?', ...(diff && { diff }), ...(u.note && { note: u.note }) })
      if (u.change === 'rename') e.fields.push({ ...field(u.after ?? u.before, 'move'), from: `${e.id}.${unitLeaf(u.from!)}` })
      else if (u.change === 'mod' && u.before && u.after && norm(u.before) !== norm(u.after)) e.fields.push(field(`${norm(u.before)} → ${norm(u.after)}`, 'mod'))
      else e.fields.push(field(u.change === 'del' ? u.before : (u.after ?? u.before), u.change))
    } else {
      const def = norm(u.after ?? u.before ?? '')
      // The fields an index is on: the names in its definition's brackets (`unique (key, at)`, `{ key: 1 }`), else its name.
      const inner = /[([{]([^)\]}]*)/.exec(def)?.[1]
      const fields = [...new Set(inner?.match(/[A-Za-z_][\w.]*/g) ?? [])].filter((f) => !/^(asc|desc|unique)$/i.test(f))
      const on = fields.length ? fields : [unitLeaf(u.name)]
      // Fields the index is on that do not change are context on their entity.
      for (const f of on) if (!e.fields.some((x) => x.name === f)) e.fields.push({ name: f, type: '…' })
      e.indexes = [...(e.indexes ?? []), { fields: on, ...(/unique/i.test(`${def} ${u.name} ${u.note ?? ''}`) && { unique: true }), diff: u.change === 'rename' ? 'mod' : u.change }]
    }
  }
  for (const u of inventory.units) {
    if (u.kind !== 'dependency') continue
    const from = node(u.module)
    const to = node(u.name, false)
    if (!findNode(architecture, u.name)) to.kind = to.kind ?? 'external'
    const files = filesOf(u.hunks)
    from.uses.push({ to: to.id, calls: [], diff: u.change === 'rename' ? 'mod' : u.change, ...(files.length && { files }) })
  }
  for (const n of modules.values()) {
    if (!n.diff && n.interface?.length) n.diff = 'mod'
    if (options.dataId && [...entities.values()].some((e) => e.module === n.id)) n.links = [{ to: options.dataId, kind: 'data' }]
  }
  const summary = inventory.summary.join(' ')
  let component: ComponentDiagram = { type: 'component', summary: summary || 'Fact of the change, generated from its inventory.', modules: [...modules.values()] }
  if (options.scenarios?.length) component = withScenarioLinks(component, options.scenarios)
  const data: DataDiagram | null = entities.size ? { type: 'data', entities: [...entities.values()], relations: [] } : null
  return { component, data }
}
