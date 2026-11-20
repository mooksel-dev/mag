// The rules of a diff diagram that are not errors (povnyi-diff-nabir-pov-iazanykh.3, Decisions 11–12): the diagram
// saves, and show_diagram answers with these warnings for the agent to fix. A data diagram shows stored data only, each
// entity in its owner module and with a relation for each of its reference fields; no diagram shows mocks or test-only
// types; a rename is one move line, not a del and an add.
import { methodName, walkArch } from './arch.ts'
import type { ComponentDiagram, DataDiagram, DEntity, Diagram, DNode } from './diagram.ts'

/** A mock, fake, stub or test harness, by its name: `MockClient`, `fakeStore`, `testify`, `a mock`. */
const NOISE_NAME = /(^|[^A-Za-z])(Mock|Fake|Stub)(?=[A-Z_]|$)|[a-z](Mock|Fake|Stub)s?\b/
const NOISE_WORD = /\b(mocks?|mocked|testify|gomock|jest\.fn|test (double|helper|harness|fixture)s?)\b/i
const NOISE = { test: (s: string) => NOISE_NAME.test(s) || NOISE_WORD.test(s) }
/** A file only tests use: a test, a mock, a fixture. */
const TEST_FILE = /(^|\/)(__tests__|__mocks__|mocks?|testdata|testutils?|fixtures)\/|(_test|_mock|\.test|\.spec|\.mock)\.[^./]+$|(^|\/)mock[^/]*\.go$|(^|\/)test_[^/]+\.py$/i
/** What is not stored data: a dependency, an interface or the arguments of a call. */
const NOT_DATA = /(Client|Clients|Repository|Service|Interface|Provider|Params|Args|Input|Options|Config)$/
/** A field that holds the key of another entity: `user_id`, `userId`, `signingCeremonyID`. */
const REFERENCE = /^(?!id$)\w*(_id|Id|ID)$/

/** The signature of an interface line, without the description after " - ". */
const signature = (text: string) => text.split(/\s[-–—]\s/)[0]

function noise(d: Diagram): string[] {
  const out: string[] = []
  const say = (what: string) => out.push(`${what}: mocks, fakes and test-only types are never on a diagram; drop it (a test is no change of the design).`)
  if (d.type === 'component')
    walkArch(d.modules, (n: DNode) => {
      if (NOISE.test(n.id) || NOISE.test(n.name)) say(`Module ${n.id}`)
      for (const l of n.interface ?? []) {
        if (NOISE.test(signature(l.text))) say(`Interface line "${l.text}" of ${n.id}`)
        else if (l.files?.length && l.files.every((f) => TEST_FILE.test(f))) say(`Interface line "${l.text}" of ${n.id} rests on test files only (${l.files.join(', ')})`)
      }
      for (const u of n.uses) for (const c of u.calls) if (NOISE.test(signature(c.text))) say(`Call "${c.text}" of ${n.id} → ${u.to}`)
    })
  if (d.type === 'data')
    for (const e of d.entities) {
      if (NOISE.test(e.id) || NOISE.test(e.name)) say(`Entity ${e.id}`)
      for (const f of e.fields) if (f && NOISE.test(f.name)) say(`Field "${f.name}" of ${e.id}`)
    }
  return out
}

/** Whether an entity or one of its fields or indexes changes. */
const changes = (e: DEntity) => !!e.diff || e.fields.some((f) => f?.diff) || !!e.indexes?.some((i) => i.diff)
const stored = (e: DEntity) => e.kind === 'collection' || e.kind === 'table'

function data(d: DataDiagram): string[] {
  const out: string[] = []
  const byId = new Map(d.entities.map((e) => [e.id, e]))
  for (const e of d.entities) {
    if (!e.module?.trim()) out.push(`Entity ${e.id} has no module: give module, the id of the module that owns it (or of the outside system whose data it is).`)
    // Stored data only: an entity a stored one does not hold (an embedded document) is the argument of a call or a dependency.
    const held = d.relations.some((r) => (r.from === e.id && stored(byId.get(r.to) ?? e)) || (r.to === e.id && stored(byId.get(r.from) ?? e)))
    if (NOT_DATA.test(e.name) || NOT_DATA.test(e.id) || (!stored(e) && !held))
      out.push(
        `Entity ${e.id} (${e.kind}): not stored data? A data diagram shows only collections and tables, their fields, indexes and uniqueness (and documents they embed, with a relation); arguments of calls, interfaces and clients go in the signature of an interface line on the component diagram.`,
      )
    if (!changes(e)) continue
    for (const f of e.fields) {
      if (!f || !REFERENCE.test(f.name) || f.diff === 'del') continue
      if (!d.relations.some((r) => r.from === e.id && r.field === f.name))
        out.push(`Field "${f.name}" of ${e.id} refers to another entity: add a relation from ${e.id} with field "${f.name}" to it (an unchanged entity is context without marks; one of another module or system: cross: true).`)
    }
  }
  for (const r of d.relations) {
    const a = byId.get(r.from)?.module
    const b = byId.get(r.to)?.module
    if (a && b && a !== b && !r.cross) out.push(`Relation ${r.from} → ${r.to} is between modules ${a} and ${b}: mark it cross: true (no foreign key, by value only).`)
  }
  // A rename is one entity, diff move with from its old id, not a removed entity and an added one with the same fields.
  const dels = d.entities.filter((e) => e.diff === 'del')
  for (const add of d.entities.filter((e) => e.diff === 'add'))
    for (const del of dels) {
      const names = new Set(del.fields.map((f) => f?.name))
      const shared = add.fields.filter((f) => f && names.has(f.name)).length
      if (shared >= 2 && shared * 2 >= Math.min(add.fields.length, del.fields.length))
        out.push(`Entity ${add.id} is added and ${del.id} removed with the same fields: if it is renamed, draw ${add.id} once with diff move and from "${del.id}".`)
    }
  return out
}

/** A method renamed is likely when a removed line and an added one differ by name only, with two arguments or more. */
function renames(d: ComponentDiagram): string[] {
  const out: string[] = []
  const rest = (text: string) => {
    const sig = signature(text).replace(/\s+/g, '')
    const at = sig.indexOf('(')
    return at > 0 && sig.slice(at).split(',').length >= 2 ? sig.slice(at) : null
  }
  walkArch(d.modules, (n: DNode) => {
    const lines = n.interface ?? []
    for (const add of lines.filter((l) => l.diff === 'add')) {
      const a = rest(add.text)
      if (!a) continue
      const del = lines.find((l) => l.diff === 'del' && rest(l.text) === a && methodName(l.text) !== methodName(add.text))
      if (del) out.push(`Interface lines "${del.text}" (del) and "${add.text}" (add) of ${n.id} differ by name only: if the method is renamed, keep one line with diff move and from "${n.id}#${methodName(del.text)}".`)
    }
  })
  return out
}

/** The kind of boundary that is one app drawn expanded on the system level: its modules keep their layers there. */
export const APP_BOUNDARY = 'app'

/** Whether a boundary is an app's (kind APP_BOUNDARY) or sits in one. */
export function inApp(d: ComponentDiagram, boundary: string | undefined): boolean {
  const seen = new Set<string>()
  for (let b = d.boundaries?.find((x) => x.id === boundary); b && !seen.has(b.id); b = d.boundaries?.find((x) => x.id === b!.parent)) {
    if (b.kind?.trim().toLowerCase() === APP_BOUNDARY) return true
    seen.add(b.id)
  }
  return false
}

/** Top-level modules that read better framed: several outside runtimes or apps, none placed in a boundary. */
const FRAME_AT = 5

/**
 * The layout of a component diagram: one level per view (the system, then the inside of one app through children),
 * boundaries where several systems sit side by side, and flows that have steps.
 */
function levels(d: ComponentDiagram): string[] {
  const out: string[] = []
  const layered = d.modules.filter((n) => n.layer)
  const loose = layered.filter((n) => !inApp(d, n.boundary))
  if (loose.length && layered.length < d.modules.length)
    out.push(
      `Top-level modules ${loose.map((n) => n.id).join(', ')} have a layer next to systems without one: the top level is the system view (apps and outside runtimes); put an app's modules in its children, so the user clicks into it, or, for the app that changes, in a boundary of kind "app", so it is drawn expanded on the system level.`,
    )
  if (d.modules.length >= FRAME_AT && !layered.length && !d.modules.some((n) => n.boundary))
    out.push(
      `The top level has ${d.modules.length} systems and no boundary: give boundaries (cloud accounts, VPCs, runtimes, the device, outside) and each module its boundary, so the user sees where each one runs; number the main scenarios with flows.`,
    )
  const used = new Set<string>()
  walkArch(d.modules, (n: DNode) => n.uses.forEach((u) => u.flow && used.add(u.flow)))
  for (const f of d.flows ?? []) if (!used.has(f.id)) out.push(`Flow ${f.id} has no step: give its uses flow "${f.id}" and step, or drop it.`)
  return out
}

/** The warnings of one diagram: noise, renames drawn as a del and an add, the data rules and the component layout; [] when there are none. */
export function diagramWarnings(d: Diagram): string[] {
  return [...noise(d), ...(d.type === 'data' ? data(d) : []), ...(d.type === 'component' ? [...renames(d), ...levels(d)] : [])]
}
