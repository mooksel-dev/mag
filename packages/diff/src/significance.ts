// How much a change matters to a review (T-57.4): mag's defaults by kind, under the project's own rules (playbook).
import { adapterOf, isCode } from './engine.ts'
import { matcher } from './vocabulary.ts'
import type { Change, ChangeSet, Level } from './types.ts'

export const LEVELS: Level[] = ['critical', 'high', 'medium', 'low', 'noise']

/** The levels a review must account for: unshown ones keep the verdict at look (Decision 6). */
export const SIGNIFICANT: Level[] = ['critical', 'high']
export const isSignificant = (c: Pick<Change, 'level'>) => !!c.level && SIGNIFICANT.includes(c.level)

/** A project's rule: changes in files matching `path` (any when null) whose name matches `name` (any when null). */
export interface SignificanceRule {
  level: Level
  path: string | null
  name: string | null
}

const RULE = /^\s*(critical|high|medium|low|noise)\s*:\s*(\S+)\s*$/i

/**
 * Rules from the playbook's text, one per line: `<level>: <path>[#<name>]`. path is a file, a folder or a glob as in
 * `paths`; name a glob over `<symbol>[.<member>]` (contracts: `TOOL_DEFS[name]`), any case. Other lines are prose.
 */
export function parseSignificance(text: string): SignificanceRule[] {
  return text.split('\n').flatMap((line) => {
    const m = RULE.exec(line)
    if (!m) return []
    const [path, name] = m[2].split('#', 2)
    return [{ level: m[1].toLowerCase() as Level, path: path || null, name: name || null }]
  })
}

const DOCS = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|ico|webp)$|(^|\/)(LICENSE|CHANGELOG)[^/]*$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/i

const nameMatcher = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

/** mag's level of a change when no rule of the project matches. */
function byDefault(c: Change): Level {
  if (c.test) return 'noise'
  switch (c.kind) {
    case 'module':
      return 'high'
    case 'edge':
      return c.diff === 'mod' ? 'low' : c.name?.startsWith('ext:') ? 'medium' : 'high'
    case 'file':
      // A source file no adapter reads: what changed in it is unknown.
      if (c.path && isCode(c.path) && !adapterOf(c.path)) return 'high'
      return c.path && DOCS.test(c.path) ? 'noise' : 'low'
  }
  // A changed body of a table, view or resource is high; a new, removed or renamed one, or another header, critical.
  if (c.elementKind === 'entity' || c.elementKind === 'infra') return c.diff === 'mod' && c.part === 'body' ? 'high' : 'critical'
  if (c.elementKind === 'contract' || c.elementKind === 'field') return 'high'
  // A planned element does not know whether it is exported: it counts as exported.
  if (c.name === '(top-level)' || c.exported === false) return 'low'
  return c.diff === 'mod' && c.part === 'body' ? 'medium' : 'high'
}

/** The level of one change: the first matching rule of the project, else mag's default. */
export function significance(change: Change, rules: SignificanceRule[]): Level {
  if (change.test) return 'noise'
  const path = change.path ?? change.hunks[0]?.path
  for (const r of rules) {
    if (r.path && !(path && matcher(r.path)(path) >= 0)) continue
    if (r.name && !(change.name && change.kind !== 'edge' && nameMatcher(r.name).test(change.name))) continue
    if (!r.path && !r.name) continue
    return r.level
  }
  return byDefault(change)
}

/** The change set with every change's level. */
export function withLevels(cs: ChangeSet, rules: SignificanceRule[]): ChangeSet {
  return { ...cs, changes: cs.changes.map((c) => ({ ...c, level: significance(c, rules) })) }
}
