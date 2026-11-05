// The changes a Component diagram draws (a plan's or a fact's, T-58), and where a plan disagrees with the vocabulary:
// ids the architecture does not have, new modules without the code they will own (Decision 8).
import { findNode, methodName, useDiff, walkArch, type ArchNode, type DataDiagram, type DNode, type Diagram } from '@mag/core'
import type { Change, PlanWarning } from './types.ts'

/** Words a line may start with before the name it is about: `interface Fact`, `async review(…)`, `resource "x"`. */
const LEAD = /^(?:(?:export|default|declare|public|private|protected|internal|static|readonly|abstract|async|override|open|final|pub|func|function|def|fn|class|struct|interface|protocol|extension|enum|type|typealias|const|let|var|val|property|method|field|table|model|resource|data|module|message|service|rpc|column|index)\s+)+/

/** The name an interface line or call is about: `review` of `review(stepId): void`, `Fact` of `interface Fact {…}`. */
export function lineName(text: string): string {
  const t = text.trim().replace(LEAD, '')
  return methodName(t).replace(/^["'`]+|["'`]+$/g, '') || t
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The module a Data diagram's entity without one is in. */
export const NO_MODULE = '(no module)'

/**
 * The changes a Data diagram draws (plan-fact-porivniannia-na-rivni.1): marked entities and fields (those of an added
 * or removed entity take its mark), each in the module that owns its entity. Indexes and relations are not compared.
 */
function dataChanges(diagram: DataDiagram): Change[] {
  const out: Change[] = []
  for (const e of diagram.entities) {
    const module = e.module || NO_MODULE
    const whole = e.diff === 'add' || e.diff === 'del' ? e.diff : undefined
    if (e.diff) out.push({ key: `${module}/${e.id}`, kind: 'entity', diff: e.diff, module, name: e.name, ...(e.diff === 'move' && e.from && { from: e.from }) })
    for (const f of e.fields) {
      const diff = f.diff ?? whole
      if (!diff) continue
      const line = `${f.name}: ${f.type}`
      out.push({
        key: `${module}/${e.id}.${f.name}`, kind: 'field', diff, module, name: f.name, entity: e.id, entityName: e.name,
        ...(diff === 'del' ? { before: line } : { after: line }), ...(diff === 'move' && f.from && { from: f.from }),
      })
    }
  }
  return out
}

/**
 * The changes a Component or Data diagram draws. Component, over its module ids: marked modules, interface lines (those
 * of an added or removed module take its mark; a del and an add line of one name are one signature change),
 * dependencies and calls, each with the `files` its line gives. Data: entities and fields (dataChanges). Other diagram
 * types draw no changes here.
 */
export function diagramChanges(diagram: Diagram): Change[] {
  if (diagram.type === 'data') return dataChanges(diagram)
  const out: Change[] = []
  if (diagram.type !== 'component') return out
  walkArch(diagram.modules, (n: DNode, ancestors: DNode[]) => {
    const whole = n.diff === 'add' || n.diff === 'del' ? n.diff : ancestors.map((a) => a.diff).find((d) => d === 'add' || d === 'del')
    if (n.diff) out.push({ key: n.id, kind: 'module', diff: n.diff, module: n.id, name: n.name, ...((n.paths?.[0] ?? n.path) && { path: n.paths?.[0] ?? n.path }) })

    const lines = (n.interface ?? []).map((l) => ({ ...l, diff: l.diff ?? whole })).filter((l) => l.diff)
    const used = new Set<number>()
    lines.forEach((l, i) => {
      if (used.has(i)) return
      const name = lineName(l.text)
      const files = l.files?.length ? { files: l.files } : {}
      const base = { key: `${n.id}#${name}`, kind: 'element' as const, module: n.id, name }
      if (l.diff === 'add' || l.diff === 'del') {
        const j = lines.findIndex((o, k) => k !== i && !used.has(k) && o.diff === (l.diff === 'add' ? 'del' : 'add') && lineName(o.text) === name)
        if (j >= 0) {
          used.add(j)
          const [del, add] = l.diff === 'del' ? [l, lines[j]] : [lines[j], l]
          const both = [...new Set([...(del.files ?? []), ...(add.files ?? [])])]
          out.push({ ...base, diff: 'mod', part: 'signature', before: norm(del.text), after: norm(add.text), ...(both.length && { files: both }) })
          return
        }
      }
      out.push({
        ...base, diff: l.diff!, ...(l.diff === 'del' ? { before: norm(l.text) } : { after: norm(l.text) }),
        ...(l.diff === 'mod' && { part: 'body' }), ...(l.diff === 'move' && l.from && { from: l.from }), ...files,
      })
    })

    for (const u of n.uses) {
      const to = findNode(diagram.modules, u.to)
      const mark = useDiff(n, u, to)
      if (mark && (u.diff || mark !== 'mod')) out.push({ key: `${n.id} -> ${u.to}`, kind: 'edge', diff: mark, module: n.id, name: u.to, ...(u.files?.length && { files: u.files }) })
      for (const c of u.calls) {
        const cm = c.diff ?? (mark === 'add' || mark === 'del' ? mark : undefined)
        if (!cm) continue
        const name = lineName(c.text)
        const files = c.files?.length ? c.files : u.files
        out.push({ key: `${n.id} -> ${u.to}#${name}`, kind: 'call', diff: cm, module: n.id, name, ...(cm === 'del' ? { before: norm(c.text) } : { after: norm(c.text) }), ...(files?.length && { files }) })
      }
    }
  })
  return out
}

/** Where a plan diagram's modules disagree with the project's `architecture` (Decision 8); [] for other types. */
export function planWarnings(diagram: Diagram, architecture: ArchNode[]): PlanWarning[] {
  const out: PlanWarning[] = []
  if (diagram.type !== 'component' || !architecture.length) return out
  const known = new Set<string>()
  walkArch(architecture, (n) => known.add(n.id))
  walkArch(diagram.modules, (n: DNode, ancestors: DNode[]) => {
    const added = n.diff === 'add' || ancestors.some((a) => a.diff === 'add')
    if (!known.has(n.id) && !added)
      out.push({ code: 'unknown-module', module: n.id, message: `${n.id} is not a module of the architecture: take its id from get_architecture, or mark it add if it is new.` })
    if (known.has(n.id) && n.diff === 'add') out.push({ code: 'exists', module: n.id, message: `${n.id} is a module of the architecture already: unmark it, or mark it mod.` })
    if (!known.has(n.id) && added && !n.paths?.length && !n.path && (ancestors.length || n.layer))
      out.push({ code: 'no-path', module: n.id, message: `New module ${n.id} has no path: give the folders or files it will own, so its code maps to it.` })
  })
  return out
}

/** The warnings as tool text; empty when there are none. */
export function formatPlanWarnings(warnings: PlanWarning[]): string {
  return warnings.map((w) => `- ${w.message}`).join('\n')
}
