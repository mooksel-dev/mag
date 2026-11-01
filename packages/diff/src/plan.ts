// A plan diagram against the code at base (T-57.3): the changes it plans, and where it disagrees with base: ids the
// architecture does not have, methods, calls and dependencies base does not have, adds of what base has already.
import { findNode, methodName, useDiff, walkArch, type ArchNode, type DLine, type DNode, type Diagram } from '@mag/core'
import type { Change, Element, PlanCheck, PlanWarning, Skeleton } from './types.ts'

const IDENT = /^[A-Za-z_$][\w$]*$/

/** The names a method of a module may have among its elements: `fn`, `Class.fn`, a contract `TOOL_DEFS[fn]`. */
export function names(e: Pick<Element, 'name'>): string[] {
  const out = [e.name, e.name.split('.').at(-1)!]
  const contract = /\[([^\]]+)\]$/.exec(e.name)
  if (contract) out.push(contract[1])
  return out
}

/**
 * The changes a Component diagram plans and its warnings against `base`, over the project's `architecture` (the ids
 * diagrams take). Only modules that own parsed code at base are checked: outside runtimes and modules of languages
 * without an adapter are taken as drawn. Other diagram types plan no changes here yet.
 */
export function planChanges(diagram: Diagram, base: Skeleton | Skeleton[], architecture: ArchNode[]): PlanCheck {
  const skeletons = Array.isArray(base) ? base : [base]
  const out: PlanCheck = { base: skeletons.map((s) => ({ repo: s.repo, sha: s.sha })), changes: [], warnings: [] }
  if (diagram.type !== 'component') return out

  // Each architecture module with its inner ones: code of an inner module is the outer one's too.
  const inner = new Map<string, Set<string>>()
  walkArch(architecture, (n, ancestors) => {
    inner.set(n.id, new Set([n.id]))
    for (const a of ancestors) inner.get(a.id)!.add(n.id)
  })
  const elements = skeletons.flatMap((s) => s.elements)
  const memo = new Map<string, Element[]>()
  const elementsOf = (id: string) => {
    if (!memo.has(id)) memo.set(id, inner.has(id) ? elements.filter((e) => e.module && inner.get(id)!.has(e.module)) : [])
    return memo.get(id)!
  }
  /** A module base can speak for: one of the architecture that owns parsed code. */
  const known = (id: string) => elementsOf(id).length > 0
  const find = (id: string, method: string) => elementsOf(id).filter((e) => names(e).includes(method))
  const overlap = (a: string, b: string) => [...inner.get(a)!].some((x) => inner.get(b)!.has(x))
  /** Where base has `from` depend on `to`: imports between their code, or a use the architecture records. */
  const dependsAt = (from: string, to: string): string | null => {
    const [f, t] = [inner.get(from)!, inner.get(to)!]
    const files = skeletons.flatMap((s) => s.edges.filter((e) => f.has(e.from) && t.has(e.to)).flatMap((e) => e.files))
    if (files.length) return `imports in ${[...new Set(files)].slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`
    let used = false
    walkArch(architecture, (n) => (used ||= f.has(n.id) && n.uses.some((u) => t.has(u.to))))
    return used ? 'per the architecture' : null
  }
  const sha = out.base.map((b) => (out.base.length > 1 ? `${b.repo}@${b.sha.slice(0, 8)}` : b.sha.slice(0, 8))).join(', ')
  const warn = (w: PlanWarning) => out.warnings.push(w)

  walkArch(diagram.modules, (n: DNode, ancestors: DNode[]) => {
    const added = n.diff === 'add' || ancestors.some((a) => a.diff === 'add')
    const removed = n.diff === 'del' || ancestors.some((a) => a.diff === 'del')
    const inArch = inner.has(n.id)
    const path = n.paths?.[0] ?? n.path
    if (n.diff) out.changes.push({ key: n.id, kind: 'module', diff: n.diff, module: n.id, name: n.name, ...(path && { path }), hunks: [] })
    if (!inArch && !added) warn({ code: 'unknown-module', module: n.id, message: `${n.id} is not a module of the architecture: take its id from get_architecture, or mark it add if it is new.` })
    if (inArch && n.diff === 'add') warn({ code: 'exists', module: n.id, message: `${n.id} is a module of the architecture already: unmark it, or mark it mod.` })
    if (added && !n.paths?.length && !n.path && (ancestors.length || n.layer))
      warn({ code: 'no-path', module: n.id, message: `New module ${n.id} has no path: give the folders or files it will own, so its code maps to it.` })

    const lines = n.interface ?? []
    for (const l of lines) {
      const mark: DLine['diff'] = l.diff ?? (added ? 'add' : removed ? 'del' : undefined)
      const m = methodName(l.text)
      const hits = IDENT.test(m) && known(n.id) ? find(n.id, m) : []
      if (mark) {
        const hit = hits.length === 1 ? hits[0] : undefined
        out.changes.push({
          key: hit?.ref ?? `${n.id}#${m}`, kind: 'element', diff: mark, module: n.id, name: m,
          ...(hit && { path: hit.path, line: hit.lines[0]?.[0] }),
          ...(mark === 'del' ? { before: l.text } : { after: l.text }),
          ...(mark === 'move' && l.from && { from: l.from }),
          hunks: [],
        })
      }
      if (!IDENT.test(m) || added) continue
      if (mark === 'move') {
        if (l.from && inner.has(l.from) && known(l.from) && !find(l.from, m).length)
          warn({ code: 'not-in-base', module: n.id, item: l.text, message: `${n.id}: "${m}" moves from ${l.from}, which has no ${m} at base ${sha}.` })
        continue
      }
      if (!known(n.id)) continue
      if (mark === 'add') {
        const paired = lines.some((o) => o.diff === 'del' && methodName(o.text) === m)
        if (hits.length && !paired)
          warn({ code: 'exists', module: n.id, item: l.text, message: `${n.id}: "${m}" exists at base ${sha} (${hits[0].path}): unmark it, or pair it with a del line of the old signature.` })
      } else if (!hits.length) {
        warn({ code: 'not-in-base', module: n.id, item: l.text, message: `${n.id}: "${m}" is not in its code at base ${sha}: mark it add if it is new, or fix the name.` })
      }
    }

    for (const u of n.uses) {
      const to = findNode(diagram.modules, u.to)
      const mark = useDiff(n, u, to)
      if (mark) out.changes.push({ key: `${n.id} -> ${u.to}`, kind: 'edge', diff: mark, module: n.id, name: u.to, hunks: [] })
      if (!inner.has(n.id) || !inner.has(u.to) || overlap(n.id, u.to)) continue
      if (known(n.id) && known(u.to)) {
        const at = dependsAt(n.id, u.to)
        if (mark === 'add' && at) warn({ code: 'exists', module: n.id, item: `-> ${u.to}`, message: `${n.id} -> ${u.to} exists at base ${sha} (${at}): unmark it.` })
        if (mark !== 'add' && !at)
          warn({ code: 'not-in-base', module: n.id, item: `-> ${u.to}`, message: `${n.id} -> ${u.to} is not at base ${sha} (no import, no recorded use): mark it add if it is new.` })
      }
      if (!known(u.to)) continue
      // A call may go to a method the diagram adds to the target.
      const planned = new Set((to?.interface ?? []).filter((l) => l.diff && l.diff !== 'del').map((l) => methodName(l.text)))
      for (const c of u.calls) {
        const m = methodName(c.text)
        if (!IDENT.test(m) || find(u.to, m).length || (c.diff !== 'del' && planned.has(m))) continue
        warn({ code: 'not-in-base', module: n.id, item: `-> ${u.to}#${m}`, message: `${n.id} calls ${u.to}#${m}, which is neither in its code at base ${sha} nor added on the diagram.` })
      }
    }
  })
  return out
}

const warningKey = (w: PlanWarning) => `${w.code}|${w.module}|${w.item ?? ''}`

/** Warnings of `now` that `before` did not have: what a move of base broke in the plan. */
export function planDrift(before: PlanCheck, now: PlanCheck): PlanWarning[] {
  const had = new Set(before.warnings.map(warningKey))
  return now.warnings.filter((w) => !had.has(warningKey(w)))
}

/** The warnings as tool text; empty when there are none. */
export function formatPlanWarnings(warnings: PlanWarning[]): string {
  return warnings.map((w) => `- ${w.message}`).join('\n')
}
