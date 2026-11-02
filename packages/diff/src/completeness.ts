// Completeness of a fact set by kind of change (povnyi-diff-nabir-pov-iazanykh.1, Decision 8): every changed public
// method, model, index, method logic (private methods' too, povnyi-diff-nabir-pov-iazanykh.3) and dependency mag reads
// from git (changedUnits) is on a diagram of the fact set, or the set says in a note why it is not worth one. Coverage
// by files (T-58) misses these: one line on a file covers it all.
import { findNode, moveSource, parseFlowRef, useDiff, walkArch, type ArchNode, type DNode, type DLine, type Diagram, type FactNote } from '@mag/core'
import { lineName } from './plan.ts'
import { langOf } from './units.ts'
import type { ChangedUnit, Completeness, MissingUnit } from './types.ts'

/** A diagram of a fact set, with the notes it carries. */
export interface SetDiagram {
  id?: string
  diagram: Diagram
  notes?: FactNote[]
}

/** Whether two modules are one, or one is inside the other, in the architecture or as the set draws them. */
function relation(architecture: ArchNode[], set: Diagram[]): (a: string, b: string) => boolean {
  const chain = new Map<string, Set<string>>()
  const walk = (tree: { id: string; uses: unknown[]; children?: unknown[] }[]) =>
    walkArch(tree as ArchNode[], (n, ancestors) => {
      const c = chain.get(n.id) ?? new Set<string>()
      ancestors.forEach((a) => c.add(a.id))
      chain.set(n.id, c.add(n.id))
    })
  walk(architecture)
  for (const d of set) if (d.type === 'component') walk(d.modules)
  return (a, b) => a === b || !!chain.get(a)?.has(b) || !!chain.get(b)?.has(a)
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
/** The names a model goes by: `public.users`, `users`, `user`. */
const modelNames = (s: string) => {
  const last = norm(s.split('.').at(-1)!)
  return new Set([norm(s), last, last.replace(/e?s$/, '')])
}
const sameModel = (a: string, b: string) => [...modelNames(a)].some((n) => n && modelNames(b).has(n))

/** A changed interface line of a set, with the module it is on. */
interface SetLine {
  module: string
  line: DLine
  name: string
}

const SCHEMA_FILE = new Set(['sql', 'prisma', 'proto', 'graphql', 'tf'])

/**
 * The changed units the fact set neither draws nor explains (Decision 8), sure ones (high) first:
 * - method: a changed interface line of its name on its module (or one around or inside it, or a line that gives its
 *   file), else a note kind method;
 * - logic (a public method whose body changed, not removed): that line links to a flowchart (kind logic), or a
 *   flowchart of the set has of `<module>#<method>`, or the line says trivialLogic, else a note kind logic or method;
 * - logic of a private method (no interface line): a flowchart of the set has of `<module>#<method>`, or a step of a
 *   flowchart that names it links to a flowchart (kind logic), else a note kind logic;
 * - model: a changed entity (or field) of that name on a data diagram of the set, or a changed interface line of it,
 *   else a note kind model; a schema file without a named table: any changed entity;
 * - index: a changed index of an entity of that name, of any entity when none has the name, else a note kind model;
 * - dependency: a use between those modules (or ones around or inside them) marked changed, else a note kind dependency.
 * A unit without a name (code under no declaration mag can name) is drawn when a line of the set gives its file.
 */
export function completeness(set: SetDiagram[], units: ChangedUnit[], architecture: ArchNode[]): Completeness {
  const diagrams = set.map((s) => s.diagram)
  const near = relation(architecture, diagrams)
  const notes = set.flatMap((s) => s.notes ?? [])
  const noted = (u: ChangedUnit, ...kinds: FactNote['kind'][]) =>
    notes.some((n) => kinds.includes(n.kind) && (n.name === u.name || norm(n.name) === norm(u.name)) && (!n.file || n.file === u.file || n.file === `${u.repo}:${u.file}`))

  const lines: SetLine[] = []
  const edges: { from: string; to: string }[] = []
  const flows: { module: string; method: string }[] = []
  const steps: { label: string; to: string[] }[] = []
  const entities: string[] = []
  const indexed: string[] = []
  for (const d of diagrams) {
    if (d.type === 'component')
      walkArch(d.modules, (n: DNode, ancestors: DNode[]) => {
        const whole = [n, ...ancestors].map((x) => x.diff).find((m) => m === 'add' || m === 'del')
        for (const l of n.interface ?? []) {
          if (!(l.diff ?? whole)) continue
          lines.push({ module: n.id, line: l, name: lineName(l.text) })
          // A renamed method (move from "<module>#<old name>") shows the old one gone too (Decision 12).
          const old = l.diff === 'move' && l.from ? moveSource(l.from) : null
          if (old?.method) lines.push({ module: old.module, line: l, name: old.method })
        }
        for (const u of n.uses) if (useDiff(n, u, findNode(d.modules, u.to))) edges.push({ from: n.id, to: u.to })
      })
    if (d.type === 'flowchart' && d.of) {
      const ref = parseFlowRef(d.of)
      if (ref) flows.push(ref)
    }
    if (d.type === 'flowchart') for (const n of d.nodes) if (n.links?.length) steps.push({ label: n.label, to: n.links.filter((k) => k.kind === 'logic').map((k) => k.to) })
    if (d.type === 'data')
      for (const e of d.entities) {
        if (e.diff || e.fields.some((f) => f?.diff)) entities.push(e.id, e.name)
        if (e.indexes?.some((i) => i.diff)) indexed.push(e.id, e.name)
      }
  }
  const files = new Set(lines.flatMap((l) => l.line.files ?? []).concat(diagrams.flatMap((d) => (d.type === 'component' ? useFiles(d.modules) : []))))
  const gives = (u: ChangedUnit, f?: string[]) => !!f?.some((x) => x === u.file || x === `${u.repo}:${u.file}`)
  const ids = new Set(set.map((s) => s.id).filter(Boolean))
  const linesOf = (u: ChangedUnit) =>
    lines.filter((l) => (l.name === u.name || l.name.toLowerCase() === u.name.toLowerCase()) && (!u.module || near(l.module, u.module) || gives(u, l.line.files)))

  const missing: MissingUnit[] = []
  for (const u of units) {
    if (u.kind === 'method' && !u.name) {
      if (!files.has(u.file) && !files.has(`${u.repo}:${u.file}`)) missing.push({ unit: u, rule: 'method' })
      continue
    }
    if (u.kind === 'method' && u.public === false) {
      const called = new RegExp(`(^|[^\\w$])${u.name.replace(/[$]/g, '\\$&')}([^\\w$]|$)`)
      const logic =
        flows.some((f) => f.method === u.name && (!u.module || near(f.module, u.module))) ||
        steps.some((s) => called.test(s.label) && s.to.some((to) => !ids.size || ids.has(to))) ||
        lines.some((l) => l.name === u.name && (l.line.trivialLogic?.trim() || l.line.links?.some((k) => k.kind === 'logic')))
      if (!logic && !noted(u, 'logic', 'method')) missing.push({ unit: u, rule: 'logic' })
      continue
    }
    if (u.kind === 'method') {
      const on = linesOf(u)
      if (!on.length) {
        if (!noted(u, 'method')) missing.push({ unit: u, rule: 'method' })
        continue
      }
      if (!u.bodyChanged || u.diff === 'del') continue
      const logic = on.some(
        (l) =>
          l.line.trivialLogic?.trim() ||
          l.line.links?.some((k) => k.kind === 'logic' && (!ids.size || ids.has(k.to))) ||
          flows.some((f) => f.method === u.name && near(f.module, l.module)),
      )
      if (!logic && !noted(u, 'logic', 'method')) missing.push({ unit: u, rule: 'logic' })
    } else if (u.kind === 'model') {
      const stem = SCHEMA_FILE.has(langOf(u.file)) && u.file.split('/').at(-1)!.replace(/\.[^.]+$/, '') === u.name
      const shown = entities.some((e) => sameModel(e, u.name)) || (stem && entities.length > 0) || linesOf(u).length > 0
      if (!shown && !noted(u, 'model')) missing.push({ unit: u, rule: 'model' })
    } else if (u.kind === 'index') {
      const shown = indexed.some((e) => sameModel(e, u.name)) || (indexed.length > 0 && !entities.concat(indexed).some((e) => sameModel(e, u.name)))
      if (!shown && !noted(u, 'model')) missing.push({ unit: u, rule: 'index' })
    } else {
      const shown = edges.some((e) => u.module && near(e.from, u.module) && (near(e.to, u.name) || norm(e.to) === norm(u.name)))
      if (!shown && !noted(u, 'dependency')) missing.push({ unit: u, rule: 'dependency' })
    }
  }
  missing.sort((a, b) => (a.unit.confidence === b.unit.confidence ? 0 : a.unit.confidence === 'high' ? -1 : 1))
  return { missing }
}

/** The files the uses and calls of a Component tree give. */
function useFiles(modules: DNode[]): string[] {
  const out: string[] = []
  walkArch(modules, (n) => n.uses.forEach((u) => out.push(...(u.files ?? []), ...u.calls.flatMap((c) => c.files ?? []))))
  return out
}

const WHY: Record<MissingUnit['rule'], (u: ChangedUnit) => string> = {
  method: (u) =>
    u.name
      ? `public method ${u.name} ${u.diff === 'add' ? 'is added' : u.diff === 'del' ? 'is removed' : 'changes'}: no changed interface line of ${u.module ?? 'its module'} shows it, no note (kind method) says why not`
      : 'code changes under no declaration mag can name: no line of the fact set gives this file',
  logic: (u) =>
    u.public === false
      ? `the logic of private method ${u.name} changes: no flowchart of the set has of ${u.module ?? '<module>'}#${u.name} (linked from the step of the flowchart that calls it), no note (kind logic) says it is trivial`
      : `the logic of ${u.name} changes: its line has no logic link to a flowchart, no flowchart of the set has of ${u.module ?? '<module>'}#${u.name}, no trivialLogic or note (kind logic)`,
  index: (u) => `an index of ${u.name} ${u.diff === 'add' ? 'is added' : u.diff === 'del' ? 'is removed' : 'changes'}: no entity of a data diagram of the set marks an index changed (indexes: [{ fields, unique, diff }]), no note (kind model)`,
  model: (u) => `model ${u.name} ${u.diff === 'add' ? 'is added' : u.diff === 'del' ? 'is removed' : 'changes'}: no data diagram of the set marks it changed, no note (kind model) says why not`,
  dependency: (u) =>
    `${u.module} ${u.diff === 'add' ? 'starts' : 'stops'} depending on ${u.name}: no use ${u.module} -> ${u.name} is marked ${u.diff} on the set, no note (kind dependency)`,
}

/** One missing unit in a line: where and what is missing. */
export function describeMissing(m: MissingUnit): string {
  return `${m.unit.repo}:${m.unit.file}:${m.unit.line}: ${WHY[m.rule](m.unit)}`
}

/** The missing units as the reviewer reads them: sure ones block merge, the others are warnings. */
export function formatCompleteness(c: Completeness): string {
  const high = c.missing.filter((m) => m.unit.confidence === 'high')
  const low = c.missing.filter((m) => m.unit.confidence === 'low')
  const out: string[] = []
  if (high.length) out.push(`Changed methods, models, indexes, logic and dependencies the fact set does not show (${high.length}, they block merge):`, ...high.map((m) => `  - ${describeMissing(m)}`))
  if (low.length) out.push(`Maybe missing (${low.length}, mag is not sure: warnings only):`, ...low.map((m) => `  - ${describeMissing(m)}`))
  return out.join('\n')
}
