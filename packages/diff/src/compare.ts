// Plan ↔ fact (T-57.4, T-58; at plan level since plan-fact-porivniannia-na-rivni.1): the changes a step's plan diagrams
// draw against those of its fact, generated from the change inventory (diff-iak-inventar-zmin-ai.1). Done by mag, not
// by an LLM.
import { walkArch, type ArchNode } from '@mag/core'
import { LEVELS, significance } from './significance.ts'
import type { Addition, Change, CompareItem, CompareStatus, Comparison, Level, OverlayStatus, PlanOverlay } from './types.ts'

const highest = (levels: (Level | undefined)[]): Level => LEVELS.find((l) => levels.includes(l)) ?? 'medium'

const ORDER: CompareStatus[] = ['differs', 'missing', 'unplanned', 'match']

/**
 * The call a line is about: its name and argument list, whitespace aside, without the description after " - " and the
 * result after the arguments (`check(project, set)` of `check(project, set): Fact - checks it`); a line without
 * arguments is its name (`DEFAULT_PLAYBOOK.fact` of `DEFAULT_PLAYBOOK.fact: string`).
 */
export function callSignature(text?: string): string {
  const t = (text ?? '').split(/\s[-–—]\s/)[0].replace(/\s+/g, '')
  const open = t.indexOf('(')
  if (open < 0) return t.split(':')[0]
  let depth = 0
  for (let i = open; i < t.length; i++) {
    if (t[i] === '(') depth++
    else if (t[i] === ')' && !--depth) return t.slice(0, i + 1)
  }
  return t
}

/** Each module of the trees (the architecture, a diagram that adds modules to it) with itself and its inner modules. */
function innerModules(...trees: { id: string; uses: unknown[]; children?: unknown[] }[][]): (id: string) => Set<string> {
  const inner = new Map<string, Set<string>>()
  for (const tree of trees)
    walkArch(tree as ArchNode[], (n, ancestors) => {
      if (!inner.has(n.id)) inner.set(n.id, new Set([n.id]))
      for (const a of ancestors) inner.get(a.id)!.add(n.id)
    })
  return (id) => inner.get(id) ?? new Set([id])
}

/**
 * An entity's name as plan and fact both write it: any case, without a "(…)" suffix, punctuation or a trailing `s`
 * (`projects (db.json)` of the plan is `Project` of the fact; `sessions` is not `AgentSession`).
 */
export const entityWord = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')

/** The words an entity (or a field's entity) goes by: its id and its name. */
const entityWords = (c: Change) => {
  const id = c.kind === 'field' ? c.entity! : c.key.slice(c.module.length + 1)
  const name = c.kind === 'field' ? (c.entityName ?? id) : c.name
  return new Set([entityWord(id), entityWord(name)])
}
/** Two changes are on one entity: by its name, whichever module plan and fact give it (an owner they draw otherwise). */
const sameEntity = (a: Change, b: Change) => [...entityWords(a)].some((w) => entityWords(b).has(w))

/** What a change is, without its module: `line`, `-> to`, `-> to#call`; entities and fields compare by sameEntity. */
function tail(c: Change): string {
  switch (c.kind) {
    case 'module':
    case 'entity':
      return ''
    case 'element':
    case 'field':
      return `#${c.name}`
    case 'edge':
      return ` -> ${c.name}`
    case 'call':
      return ` -> ${c.key.split(' -> ')[1]}`
  }
}

/** The entity a field or entity change is of: `<module>/<entity>`. */
const entityKey = (c: Change) => (c.kind === 'field' ? `${c.module}/${c.entity}` : c.key)
/** A field's entity as an entity change, for matching and folding. */
const entityOf = (c: Change): Change =>
  c.kind === 'entity' ? c : { key: entityKey(c), kind: 'entity', diff: 'mod', module: c.module, name: c.entityName ?? c.entity! }
const edgeOf = (c: Change) => (c.kind === 'edge' ? c.key : `${c.module} -> ${c.key.split(' -> ')[1].split('#')[0]}`)

/**
 * The plan's changes (diagramChanges of the step's plan diagrams) against the fact's (of its fact set), over the
 * project's `architecture`, at plan level (plan-fact-porivniannia-na-rivni.1, [logic](canvas:6fa863de)).
 *
 * Each plan change finds its fact by key; a plan change on a module also matches the same change on one of its inner
 * modules; entities and fields match by the entity's name (entityWord), whatever module each side gives it; a planned
 * del of a field matches the fact's move out of it. A planned change of an entity is done when the fact changes its
 * fields or moves one out. Found: the same mark and the same call (sameCall) is a match (other text around it a
 * note), else it differs; not found, it is missing.
 *
 * The plan's scope is the modules with a planned change (on the module, a line, a dependency or call from it) with
 * their inner modules, and the planned entities. A fact change no plan change names is, inside the scope, an addition
 * (a line, call or field); in an existing module or entity outside it that only changes inside, it is `outside`
 * (also changed, outside the plan). Neither is a deviation. A new, removed or moved module, entity or dependency the
 * plan lacks is one unplanned item, its changes folded under it; a change a project rule puts at critical (an
 * external contract) is unplanned wherever it is. Noise is left out. `calls` false: planned calls are not compared
 * (the inventory's call units are not the plan's), they only widen the scope.
 */
export function compare(plan: Change[], fact: Change[], architecture: ArchNode[], { calls = true } = {}): Comparison {
  const innerOf = innerModules(architecture)
  const used = new Set<Change>()
  const items: CompareItem[] = []
  const levelOf = (...cs: (Change | undefined)[]) => highest(cs.map((c) => c && (c.level ?? significance(c, []))))
  const item = (status: CompareStatus, p: Change | undefined, f: Change | undefined, extra: Partial<CompareItem> = {}) => {
    if (f) used.add(f)
    items.push({ status, ...(p && { plan: p }), ...(f && { fact: f }), level: levelOf(p, f), ...extra })
  }
  const same = (a?: string, b?: string) => (a ?? '').replace(/\s+/g, '') === (b ?? '').replace(/\s+/g, '')
  const words = (p: Change, f: Change) => `planned ${p.after ?? p.before}, done ${f.after ?? f.before}`
  const near = (p: Change, c: Change) =>
    c.kind === p.kind && tail(c) === tail(p) && (p.kind === 'entity' || p.kind === 'field' ? sameEntity(p, c) : innerOf(p.module).has(c.module))
  // A fact field moved out of the entity `e`: its from, "<entity>.<field>", names where it was.
  const movedFrom = (e: Change, c: Change) => c.diff === 'move' && !!c.from && entityWords(e).has(entityWord(c.from.slice(0, c.from.lastIndexOf('.'))))
  const movedOut = (p: Change) => (c: Change) => c.kind === 'field' && movedFrom(p, c) && c.from!.slice(c.from!.lastIndexOf('.') + 1) === p.name
  for (const p of plan.filter((p) => calls || p.kind !== 'call')) {
    const f = fact.find((c) => !used.has(c) && c.key === p.key) ?? fact.find((c) => !used.has(c) && near(p, c))
    if (!f) {
      // The move is also the planned move into its new entity: it stays for that one.
      const moved = p.kind === 'field' && p.diff === 'del' ? fact.find(movedOut(p)) : undefined
      const fields = p.kind === 'entity' && p.diff === 'mod' ? fact.find((c) => c.kind === 'field' && (sameEntity(p, c) || movedFrom(p, c))) : undefined
      if (moved) items.push({ status: 'match', plan: p, fact: moved, level: levelOf(p, moved), note: `planned del, done move to ${moved.entity}.${moved.name}` })
      else if (fields) items.push({ status: 'match', plan: p, fact: entityOf(fields), level: levelOf(p) })
      else item('missing', p, undefined)
    } else if (f.diff !== p.diff) item('differs', p, f, { how: 'mark', note: `planned ${mark(p)}, done ${mark(f)}` })
    // A changed line: what it is after the change decides, whether its signature or only its body changed.
    else if (!sameCall(p.after, f.after) || (p.diff !== 'mod' && !sameCall(p.before, f.before))) item('differs', p, f, { how: 'signature', note: words(p, f) })
    else if (!same(p.after, f.after) || !same(p.before, f.before) || (p.part && f.part && p.part !== f.part)) item('match', p, f, { note: words(p, f) })
    else item('match', p, f)
  }

  const modules = [...new Set(plan.filter((p) => p.kind !== 'entity' && p.kind !== 'field').map((p) => p.module))]
  const inScope = (m: string) => modules.some((p) => innerOf(p).has(m))
  const entities = plan.filter((p) => p.kind === 'entity' || p.kind === 'field')
  const entityInScope = (c: Change) => entities.some((p) => sameEntity(p, c))
  const edges = plan.filter((p) => p.kind === 'edge' || p.kind === 'call')
  const edgePlanned = (c: Change) => {
    const [from, to] = edgeOf(c).split(' -> ')
    return edges.some((p) => {
      const [pf, pt] = edgeOf(p).split(' -> ')
      return innerOf(pf).has(from) && innerOf(pt).has(to)
    })
  }

  // The fact's changes no plan change took: additions inside the scope, `outside` in existing modules and entities
  // beyond it, and deviations, with what they own folded under them.
  const additions = new Map<string, Change[]>()
  const outside = new Map<string, Change[]>()
  const owners = new Map<string, CompareItem>()
  const put = (to: Map<string, Change[]>, key: string, c: Change) => to.set(key, [...(to.get(key) ?? []), c])
  const rest = fact.filter((f) => !used.has(f) && f.level !== 'noise')
  // The changes that own others come first, so their item is the module, entity or dependency itself.
  const rank = (c: Change) => ['module', 'entity', 'edge'].indexOf(c.kind) + 1 || 4
  for (const f of [...rest].sort((a, b) => rank(a) - rank(b))) {
    if (f.level === 'critical') {
      item('unplanned', undefined, f)
      continue
    }
    const folded = (key: string) => {
      const o = owners.get(key)
      if (o) o.folded!.push(f)
      return !!o
    }
    switch (f.kind) {
      case 'module':
      case 'entity':
      case 'edge':
        // A module or entity that only changes inside, a dependency that only changes calls: where its changes are.
        if (f.diff !== 'mod' && !(f.kind === 'edge' && edgePlanned(f))) owners.set(f.key, { status: 'unplanned', fact: f, level: 'noise', folded: [] })
        break
      case 'element':
        if (!folded(f.module)) put(inScope(f.module) ? additions : outside, f.module, f)
        break
      case 'field':
        if (!folded(entityKey(f))) put(entityInScope(f) ? additions : outside, entityKey(f), f)
        break
      case 'call':
        if (!folded(edgeOf(f)) && !folded(f.module)) put(edgePlanned(f) || inScope(f.module) ? additions : outside, f.module, f)
    }
  }
  for (const o of owners.values()) items.push({ ...o, level: levelOf(o.fact, ...o.folded!), ...(o.folded!.length ? {} : { folded: undefined }) })
  for (const i of items) if (!i.folded) delete i.folded
  items.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
  const list = (m: Map<string, Change[]>) => [...m].map(([module, changes]) => ({ module, changes }))
  return { items, additions: list(additions), outside: list(outside) }
}

/** The arguments of a call signature (callSignature's), split at its top-level commas; null without an argument list. */
function args(sig: string): string[] | null {
  const open = sig.indexOf('(')
  if (open < 0) return null
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of sig.slice(open + 1, sig.lastIndexOf(')'))) {
    if ('([{<'.includes(ch)) depth++
    else if (')]}>'.includes(ch)) depth--
    if (ch === ',' && !depth) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const ELLIPSIS = /^(…|\.\.\.)$/
/** An argument callers may leave out: `x?`, `x?: T`, `x = 1`, `...rest`. */
const optional = (a: string) => /^[\w$]+\?/.test(a) || /=/.test(a.replace(/=>/g, '')) || /^\.\.\.[\w$]/.test(a)
/** An argument's name: `projectId` of `projectId: string`, `format` of `format?`. */
const argName = (a: string) => /^(?:\.\.\.)?([\w$]+)/.exec(a)?.[1] ?? a

/**
 * The plan's line `p` names the same call as the fact's `f`: the same name and the same number of required arguments;
 * argument names, types and added optional arguments aside. A line without arguments (`review_pr - …`) names any call
 * of its name; `…` among the plan's arguments (`reviewPr(…, format?)`) is the existing ones, so only the listed ones
 * count: each has to be among the fact's.
 */
export function sameCall(p?: string, f?: string): boolean {
  const x = callSignature(p)
  const y = callSignature(f)
  if (x === y) return true
  if (!x || !y || x.split('(')[0] !== y.split('(')[0]) return false
  const [pa, fa] = [args(x), args(y)]
  if (!pa || !fa) return true
  if (pa.some((a) => ELLIPSIS.test(a))) return pa.filter((a) => !ELLIPSIS.test(a)).every((a) => fa.some((b) => argName(b) === argName(a)))
  return pa.filter((a) => !optional(a)).length === fa.filter((a) => !optional(a)).length
}

/** A deviation: done otherwise, planned and not done, or off the plan. Additions and matches are none. */
export const isDeviation = (i: CompareItem) => i.status !== 'match'

/**
 * Why the review may not say merge: what the fact itself blocks on (no inventory yet, its check against the hunks:
 * diff-iak-inventar-zmin-ai.1), then every deviation from the plan in words (phrase), whatever its level. [] when
 * nothing does.
 */
export function mergeBlockers(comparison: Comparison, fact: string[]): string[] {
  return [...fact, ...comparison.items.filter(isDeviation).map(phrase)]
}

const mark = (c: Change) => (c.diff === 'mod' && c.part ? `mod (${c.part})` : c.diff === 'move' && c.from ? `move from ${c.from}` : c.diff)

const DONE: Record<Change['diff'], string> = { add: 'added', mod: 'changed', del: 'removed', move: 'moved' }

/** A change's mark in words. */
const markWord = (c: Change) => (c.diff === 'mod' && c.part === 'signature' ? 're-signed' : c.diff === 'mod' && c.part === 'body' ? 'changed inside' : DONE[c.diff])

/** What a change is about, in a few words: `orchestrator: setPrReview`, `module fact`, `dependency a → b`. */
function subject(c: Change): string {
  switch (c.kind) {
    case 'module':
      return `module ${c.module}`
    case 'element':
      return `${c.module}: ${c.name}`
    case 'edge':
      return `dependency ${c.module} → ${c.name}`
    case 'call':
      return `${c.module} → ${c.key.split(' -> ')[1].replace('#', ': ')}`
    case 'entity':
      return `entity ${c.name} (${c.module})`
    case 'field':
      return `${c.module}: ${c.entity}.${c.name}`
  }
}

/** One deviation in words, as the UI and the threshold say it: 'orchestrator: setPrReview has another signature than planned'. */
export function phrase(i: CompareItem): string {
  const c = (i.plan ?? i.fact)!
  if (i.status === 'missing') return `${subject(c)} is planned, not done`
  if (i.status === 'differs')
    return i.how === 'signature' ? `${subject(c)} has another signature than planned` : `${subject(c)} is ${markWord(i.fact!)}, planned ${markWord(c)}`
  if (i.status === 'match') return `${subject(c)} is done as planned`
  const inside = i.folded?.length ? ` (${i.folded.length} change${i.folded.length > 1 ? 's' : ''} in it)` : ''
  if (c.level === 'critical' && c.kind !== 'module' && c.kind !== 'entity' && c.kind !== 'edge') return `${subject(c)} is ${markWord(c)}, not on the plan (critical: an external contract)`
  return `${c.diff === 'add' ? 'new ' : ''}${subject(c)}${c.diff === 'add' ? '' : ` is ${markWord(c)}`}, not on the plan${inside}`
}

const NOUNS: Partial<Record<Change['kind'], [string, string]>> = { element: ['helper', 'helpers'], call: ['call', 'calls'], field: ['field', 'fields'] }

/** Additions of one module (or entity) in a line: '+12 helpers in core-pr-review', '+2 fields in store/projects'. */
export function additionLine(a: Addition): string {
  const parts = (['element', 'call', 'field'] as const).flatMap((k) => {
    const n = a.changes.filter((c) => c.kind === k).length
    return n ? [`+${n} ${NOUNS[k]![n > 1 ? 1 : 0]}`] : []
  })
  return `${parts.join(', ')} in ${a.module}`
}

/** What the fact also changes outside the plan, in one line: 'Also changed outside the plan: main-entry (7), home-view (5)'; '' when nothing. */
export function outsideLine(outside: Addition[]): string {
  if (!outside.length) return ''
  return `Also changed outside the plan: ${[...outside].sort((a, b) => b.changes.length - a.changes.length).map((a) => `${a.module} (${a.changes.length})`).join(', ')}`
}

const names = (a: Addition) => a.changes.map((c) => `${c.diff} ${c.kind === 'call' ? c.key.split(' -> ')[1] : c.name}`).join('; ')

/** How many changes the additions fold, and in how many modules or entities. */
export const additionCount = (additions: Addition[]) => ({ changes: additions.reduce((n, a) => n + a.changes.length, 0), modules: additions.length })

/** The plan changes of the items, by what the overlay paints: every match is match, every missing missing, else differs. */
function statusOf(items: CompareItem[]): OverlayStatus {
  return items.every((i) => i.status === 'match') ? 'match' : items.every((i) => i.status === 'missing') ? 'missing' : 'differs'
}

/**
 * The comparison over the plan's Component diagram: modules and dependencies by how their plan changes came out, an
 * unplanned critical line making its module differ; the fact's unplanned modules and dependencies to draw dashed, each
 * module with where the architecture has it.
 */
export function planOverlay(comparison: Comparison, architecture: ArchNode[]): PlanOverlay {
  const byModule = new Map<string, CompareItem[]>()
  const byEdge = new Map<string, CompareItem[]>()
  const push = (m: Map<string, CompareItem[]>, k: string, i: CompareItem) => m.set(k, [...(m.get(k) ?? []), i])
  const overlay: PlanOverlay = { modules: {}, edges: {}, unplanned: { modules: [], edges: [] } }
  for (const i of comparison.items) {
    const p = i.plan
    if (p && (p.kind === 'module' || p.kind === 'element')) push(byModule, p.module, i)
    if (p && (p.kind === 'edge' || p.kind === 'call')) push(byEdge, edgeOf(p), i)
  }
  for (const [k, of] of byModule) overlay.modules[k] = statusOf(of)
  for (const [k, of] of byEdge) overlay.edges[k] = statusOf(of)
  const where = new Map<string, { node: ArchNode; within: string[] }>()
  walkArch(architecture, (n, ancestors) => where.set(n.id, { node: n, within: ancestors.map((a) => a.id) }))
  for (const i of comparison.items) {
    const f = i.fact
    if (i.status !== 'unplanned' || !f) continue
    if (f.kind === 'module') {
      const at = where.get(f.module)
      overlay.unplanned.modules.push({ id: f.module, name: at?.node.name ?? f.name, ...(at?.node.layer && { layer: at.node.layer }), within: at?.within ?? [] })
    } else if (f.kind === 'edge') overlay.unplanned.edges.push({ from: f.module, to: f.name })
    else if (f.kind !== 'entity' && f.kind !== 'field' && overlay.modules[f.module]) overlay.modules[f.module] = 'differs'
  }
  return overlay
}

/** One change in a few words: what and where. */
export function describe(c: Change): string {
  if (c.kind === 'module') return `module ${c.key}`
  if (c.kind === 'edge') return `dependency ${c.module} -> ${c.name}`
  if (c.kind === 'call') return `call ${c.key}`
  if (c.kind === 'entity') return `entity ${c.key}`
  if (c.kind === 'field') return `field ${c.module}/${c.entity}.${c.after ?? c.before ?? c.name}`
  return `${c.module} ${c.after ?? c.before ?? c.name}`
}

/**
 * The comparison and the threshold as the reviewer reads them: the deviations with their levels, notes and the changes
 * folded under them, the additions by module with their names, and what was done as planned.
 */
export function formatComparison(comparison: Comparison, blockers: string[]): string {
  const lines = [
    blockers.length
      ? `Threshold: merge is NOT allowed (verdict look at most), because:\n${blockers.map((b) => `  - ${b}`).join('\n')}`
      : 'Threshold: merge is allowed (the inventory accounts for every block of changed code and rests on its hunks, the fact keeps to the plan).',
  ]
  const label: Record<CompareStatus, string> = {
    differs: 'Done otherwise than planned',
    missing: 'Planned, not on the fact',
    unplanned: 'Off the plan (a module, entity or dependency the plan lacks, or a critical change)',
    match: 'Done as planned',
  }
  for (const s of ORDER) {
    const of = comparison.items.filter((i) => i.status === s)
    if (!of.length) continue
    lines.push('', `${label[s]} (${of.length}):`)
    if (s === 'match') {
      lines.push(`  ${of.map((i) => describe(i.plan!)).join('; ')}`)
      continue
    }
    for (const i of of) {
      const c = (i.plan ?? i.fact)!
      lines.push(`  - [${i.level}] ${mark(c)} ${describe(c)}${i.note ? `; ${i.note}` : ''}`)
      for (const f of i.folded ?? []) lines.push(`      ${mark(f)} ${describe(f)}`)
    }
  }
  const { changes, modules } = additionCount(comparison.additions)
  if (changes) {
    lines.push('', `Additions inside the planned modules and entities (${changes} in ${modules}; not deviations):`)
    for (const a of comparison.additions) lines.push(`  - ${additionLine(a)}: ${names(a)}`)
  }
  if (comparison.outside.length) {
    lines.push('', `${outsideLine(comparison.outside)} (existing modules and entities changed inside; not deviations):`)
    for (const a of comparison.outside) lines.push(`  - ${a.module}: ${names(a)}`)
  }
  return lines.join('\n')
}
