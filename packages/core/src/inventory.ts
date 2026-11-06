// The fact of code changes as a change inventory (diff-iak-inventar-zmin-ai.1): a flat list of what a PR changed, written
// by the reviewer from the diff, each unit citing the blocks of changed lines it rests on. mag checks it against the
// hunks (@mag/diff checkInventory) and generates the fact's Component and Data diagrams from it; the reviewer draws only
// scenarios and method logic.
import { findNode, type ArchLayer, type ArchNode, type Line } from './arch.ts'
import { looksGrouped, type ComponentDiagram, type DataDiagram, type DEntity, type DField, type DLine, type DNode, type DUse, type DiagramLink, type SequenceDiagram } from './diagram.ts'

export type UnitKind = 'method' | 'model' | 'field' | 'index' | 'dependency' | 'call' | 'config' | 'template'
export const UNIT_KINDS: UnitKind[] = ['method', 'model', 'field', 'index', 'dependency', 'call', 'config', 'template']
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
  /**
   * method / model: its name; field: `<model>.<field>`; dependency: the module or package used; call: `<target
   * module>#<method>` (`<package>#<func>` outside the project); config: the constant.
   */
  name: string
  change: UnitChange
  visibility?: 'public' | 'private'
  /** The old signature (field type, definition; a call as the code makes it), one line; none for add. */
  before?: string
  /** The new one; none for del. */
  after?: string
  /** rename: the old name. */
  from?: string
  /** method: how much of its logic changes. */
  logic?: UnitLogic
  /** model / field: persisted data (a table, collection, document, cache entry), not an argument or DTO. */
  stored?: boolean
  /** call: its target is outside the project (a package, an outside system), no module of the architecture. */
  external?: boolean
  /** The ids of the blocks of changed lines it rests on (`H3.1`; `H3` for every block of the hunk). */
  hunks: string[]
  note?: string
  /**
   * Set by mag only (mergeDraft): the unit is as mag's parser drafted it (its name, module and blocks), so the parse,
   * not the hunks' text, bears its name out. Never read from what an agent passes.
   */
  parsed?: boolean
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
    if (u?.external !== undefined) out.external = u.external === true
    if (out.name && groupedName(out)) errors.push(`${what} (${out.name}): one name per unit; give each its own unit`)
    if (kind === 'call') {
      const call = parseCall(out.name)
      if (out.name && !call) errors.push(`${what} (${out.name}): a call is named "<target module>#<method>" ("<package>#<func>" outside the project)`)
      if (change === 'rename') errors.push(`${what} (${out.name}): a call changes by add, del or mod (its arguments)`)
    }
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

/**
 * The mechanical part of an inventory, which mag's parser fills (prompts-use-the-models-to.6): a unit per changed
 * function, method and type of the TS/JS files (id d1…, kind, module, owner, name, change, visibility, signatures,
 * blocks) and the blocks that change only comments. The reviewer adds the meaning: logic, note, stored, the units no
 * parser sees (dependencies, calls, fields, config, renames), and fixes what is wrong.
 */
export interface InventoryDraft {
  units: InventoryUnit[]
  noise: InventoryNoise[]
}

export const EMPTY_DRAFT: InventoryDraft = { units: [], noise: [] }

/**
 * The reviewer's inventory over mag's draft. A unit whose id is a draft unit's builds on it: the fields it gives win,
 * the rest are the draft's; `drop: true` leaves it out (it is not a change, or a rename unit takes its place). A unit
 * of its own (an id no draft unit has: a whole unit, as without a draft) takes the place of the draft units of its
 * module and kind it names, by its name or a rename's from: a reviewer who writes every unit itself gets no doubles.
 * The other draft units stay as drafted, so each still asks for its meaning (a method its logic). The draft's noise joins the reviewer's. Units left as drafted (name, module, change, blocks
 * among the draft's) are `parsed`: a rename's old name is the reviewer's, so its hunks still bear it out.
 */
export function mergeDraft(draft: InventoryDraft, raw: unknown): { inventory: ChangeInventory; errors: string[] } {
  let o = raw
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o)
    } catch {
      return normalizeInventory(o)
    }
  }
  const r = (o && typeof o === 'object' ? o : {}) as Raw
  const given = Array.isArray(r.units) ? (r.units as Raw[]) : null
  const byId = new Map(draft.units.map((u) => [u.id, u]))
  const named = new Map((given ?? []).filter((u) => byId.has(text(u?.id))).map((u) => [text(u.id), u]))
  const defined = (u: Raw) => Object.fromEntries(Object.entries(u).filter(([k, v]) => v !== undefined && v !== null && k !== 'drop' && k !== 'parsed'))
  const own = (given ?? []).filter((u) => !byId.has(text(u?.id)))
  const names = (u: Raw) => [text(u?.name), text(u?.from)].filter(Boolean).map(unitLeaf)
  const covered = (d: InventoryUnit) => own.some((u) => text(u?.module) === d.module && text(u?.kind) === d.kind && names(u).includes(unitLeaf(d.name)))
  const units = [
    ...draft.units.flatMap((d) => {
      const u = named.get(d.id)
      if (u?.drop === true || (!u && covered(d))) return []
      const { parsed: _, ...base } = d
      return [u ? { ...base, ...defined(u) } : base]
    }),
    ...own.map(defined),
  ]
  const noise = [...draft.noise, ...(Array.isArray(r.noise) ? r.noise : [])]
  const out = normalizeInventory({ ...r, units: given || draft.units.length ? units : r.units, noise })
  for (const u of out.inventory.units) {
    const d = byId.get(u.id)
    if (d && d.name === u.name && d.module === u.module && d.change === u.change && u.hunks.every((h) => d.hunks.includes(h))) u.parsed = true
  }
  return out
}

/** A draft as the reviewer reads it: a line per unit, with what it still needs; '' without one. */
export function formatDraft(draft: InventoryDraft): string {
  if (!draft.units.length && !draft.noise.length) return ''
  const sig = (s: string | undefined) => (s ? JSON.stringify(s) : '-')
  const lines = draft.units.map((u) => {
    const sigs = u.change === 'add' ? `after ${sig(u.after)}` : u.change === 'del' ? `before ${sig(u.before)}` : `before ${sig(u.before)} after ${sig(u.after)}`
    const needs = u.kind === 'method' ? (u.change === 'mod' ? 'logic, note' : 'logic') : u.kind === 'model' ? 'stored when persisted' : ''
    return `- ${u.id} ${u.kind} ${u.change} ${u.name} [${u.module}${u.owner ? `, owner ${u.owner}` : ''}${u.visibility ? `, ${u.visibility}` : ''}] ${sigs} hunks ${u.hunks.join(',')}${needs ? ` — needs ${needs}` : ''}`
  })
  const noise = draft.noise.length ? [`Noise mag drafted (comments and blank lines only): ${draft.noise.flatMap((n) => n.hunks).join(', ')}.`] : []
  return [
    `### Draft units (mag parsed the TS/JS files: ${draft.units.length} unit(s); the meaning is yours to add)`,
    'Pass a draft unit to set_inventory by its id with only what you add or change, e.g. {"id": "d2", "logic": "nontrivial", "note": "…"}; drop: true leaves out one that is no change; the others stay as drafted. Add the units no parser sees as new units.',
    ...lines,
    ...noise,
  ].join('\n')
}

/** The last segment of a dotted, slashed or `#` name: `save` of `dar_jobs.Repository.save`. */
export const unitLeaf = (name: string) => name.split(/[.#/:]/).filter(Boolean).at(-1) ?? name

/** The target module and method of a call unit's name (`dar_jobs#Ensure`); null when it is not one. */
export function parseCall(name: string): { target: string; method: string } | null {
  const at = name.lastIndexOf('#')
  const target = name.slice(0, at).trim()
  const method = name.slice(at + 1).trim()
  return at > 0 && target && method ? { target, method } : null
}

/** Kinds whose name may be a path (a package, a module folder, a template file): a "/" there joins no names. */
const PATH_NAMES: UnitKind[] = ['dependency', 'config', 'template']

/**
 * A unit's name that holds several (`ErrA, ErrB`, `get / set`, `Get/Set`; looksGrouped). The target of a call and a
 * name that may be a path are no group by their "/".
 */
export function groupedName(u: Pick<InventoryUnit, 'kind' | 'name'>): boolean {
  if (u.kind === 'call') return looksGrouped(parseCall(u.name)?.method ?? u.name)
  if (PATH_NAMES.includes(u.kind)) return /,|\s[+/]\s/.test(u.name)
  return looksGrouped(u.name)
}

/**
 * What a unit lacks that the inventory's rules ask of it (diff-iak-inventar-zmin-ai.2): a changed method says what it
 * was and is (before and after) and what changed in it (note); one name per unit.
 */
export function unitRuleProblems(u: InventoryUnit): string[] {
  const out: string[] = []
  if (groupedName(u)) out.push('one name per unit: give each its own unit')
  if (u.kind === 'method' && u.change === 'mod') {
    const lacks = [!u.before && 'before', !u.after && 'after', !u.note && 'note'].filter(Boolean)
    if (lacks.length) out.push(`a changed method needs ${lacks.join(', ')}: its old and new signature and what changes in it`)
  }
  return out
}

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

/**
 * A unit's lines in its module: a changed signature is a del and an add line, a rename one move line. A signature that
 * reads the same from its name on (only the receiver or whitespace differs, `func (Client) Get(id)` → `func (c *client)
 * Get(id)`) is no change of it: one mod line, as for a body that alone changes.
 */
function unitLines(u: InventoryUnit, files: string[]): DLine[] {
  const extra: Partial<DLine> = {
    ...(files.length && { files }),
    ...(u.kind === 'method' && u.logic === 'nontrivial' && { logic: true }),
    ...(u.visibility === 'private' && { private: true }),
  }
  // The line says what the unit does as the renderer reads it: "name(args): Result - what it does".
  const noted = (sig: string | undefined) => (u.note ? `${lineText(u, sig)} - ${norm(u.note)}` : lineText(u, sig))
  if (u.change === 'rename') return [{ text: noted(u.after ?? u.before), diff: 'move', from: `${u.module}#${unitLeaf(u.from!)}`, ...extra }]
  if (u.change === 'add') return [{ text: noted(u.after), diff: 'add', ...extra }]
  if (u.change === 'del') return [{ text: noted(u.before), diff: 'del', ...extra }]
  if (u.before && u.after && !sameSignature(u, u.before, u.after))
    return [
      { text: lineText(u, u.before), diff: 'del', ...extra },
      { text: noted(u.after), diff: 'add', ...extra },
    ]
  return [{ text: noted(u.after ?? u.before), diff: 'mod', ...extra }]
}

/** Two signatures of a unit that read the same from its name on, whitespace aside. */
const sameSignature = (u: InventoryUnit, x: string, y: string, name?: string) => lineText(u, x, name).replace(/\s+/g, '') === lineText(u, y, name).replace(/\s+/g, '')

/**
 * A call unit's lines on its use: the call from the method's name on (`s.jobs.Ensure(ctx, key)` → `Ensure(ctx, key)`),
 * a call whose arguments change a del and an add line.
 */
function callLines(u: InventoryUnit, method: string, files: string[]): Line[] {
  const at = (sig: string | undefined) => lineText(u, sig, method)
  const extra = files.length ? { files } : {}
  if (u.change === 'add') return [{ text: at(u.after), diff: 'add', ...extra }]
  if (u.change === 'del') return [{ text: at(u.before), diff: 'del', ...extra }]
  if (u.before && u.after && !sameSignature(u, u.before, u.after, method))
    return [
      { text: at(u.before), diff: 'del', ...extra },
      { text: at(u.after), diff: 'add', ...extra },
    ]
  return [{ text: at(u.after ?? u.before), diff: 'mod', ...extra }]
}

/** Folder names that say a module's layer, for modules no architecture describes (a teammate's PR outside the project). */
const FOLDER_LAYERS: Record<string, ArchLayer> = { handlers: 'app', cmd: 'app', services: 'service', clients: 'client', repositories: 'client' }

/** The layer a module's folders say (`internal/services/billing` → service), the innermost first; none when no folder says one. */
export function folderLayer(id: string): ArchLayer | undefined {
  return id.split(/[/-]/).reverse().map((f) => FOLDER_LAYERS[f.toLowerCase()]).find(Boolean)
}

/**
 * A module of the fact: named as the architecture has it, with its layer; an id it does not have is new (or, with no
 * architecture, a folder: its layer from the folder's name).
 */
function moduleNode(id: string, architecture: ArchNode[], known: boolean): DNode {
  const arch = findNode(architecture, id)
  const layer = arch ? arch.layer : folderLayer(id)
  return {
    id,
    name: arch?.name ?? id,
    description: arch?.description ?? '',
    ...(layer && { layer }),
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

/** The id of the Data diagram's entity a data unit lands on (isDataUnit): its model's last segment. */
export const unitEntity = (u: InventoryUnit) => unitLeaf(entityOf(u))

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
    const id = unitEntity(u)
    let e = entities.get(id)
    if (!e) entities.set(id, (e = { id, name: id, kind: 'table', module: u.module, fields: [] }))
    return e
  }
  for (const u of inventory.units) {
    if (u.kind === 'dependency' || u.kind === 'call') continue
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
  // The PR's own modules: a dependency on one of them is inside the change, never outside it.
  const own = new Set(inventory.units.map((u) => u.module))
  const target = (id: string, external = false) => {
    const to = node(id, false)
    if (external || (!own.has(id) && !findNode(architecture, id))) to.kind = to.kind ?? 'external'
    return to
  }
  for (const u of inventory.units) {
    if (u.kind !== 'dependency') continue
    const from = node(u.module)
    const to = target(u.name)
    const files = filesOf(u.hunks)
    from.uses.push({ to: to.id, calls: [], diff: u.change === 'rename' ? 'mod' : u.change, ...(files.length && { files }) })
  }
  // Calls go on the use of their caller's module to their target; a call no dependency unit has a use for makes it, a
  // use that changes only by its calls.
  for (const u of inventory.units) {
    const call = u.kind === 'call' ? parseCall(u.name) : null
    if (!call) continue
    const from = node(u.module)
    const to = target(call.target, u.external)
    const files = filesOf(u.hunks)
    let use: DUse | undefined = from.uses.find((x) => x.to === to.id)
    if (!use) from.uses.push((use = { to: to.id, calls: [], diff: 'mod' }))
    use.calls.push(...callLines(u, call.method, files))
    if (files.length) use.files = [...new Set([...(use.files ?? []), ...files])]
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
