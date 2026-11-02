// How much a change matters to a review (T-57.4): mag's defaults by the kind of change a diagram draws, under the
// project's own rules (playbook).
import { matcher } from './vocabulary.ts'
import type { Change, Level } from './types.ts'

export const LEVELS: Level[] = ['critical', 'high', 'medium', 'low', 'noise']

/** The levels a review must account for: unexplained ones keep the verdict at look (T-58 Decision 5). */
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
 * `paths`, matched against the files a change rests on; name a glob over the name it is about, any case. Other lines
 * are prose.
 */
export function parseSignificance(text: string): SignificanceRule[] {
  return text.split('\n').flatMap((line) => {
    const m = RULE.exec(line)
    if (!m) return []
    const [path, name] = m[2].split('#', 2)
    return [{ level: m[1].toLowerCase() as Level, path: path || null, name: name || null }]
  })
}

const nameMatcher = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

/** mag's level of a change when no rule of the project matches. */
function byDefault(c: Change): Level {
  switch (c.kind) {
    case 'module':
      return c.diff === 'mod' ? 'medium' : 'high'
    case 'edge':
      return c.diff === 'mod' ? 'low' : 'high'
    case 'call':
      return 'medium'
  }
  // A changed line body (marked mod) is medium; a new, removed, moved or re-signed one is high.
  return c.diff === 'mod' && c.part !== 'signature' ? 'medium' : 'high'
}

/** The level of one change: the first matching rule of the project, else mag's default. */
export function significance(change: Change, rules: SignificanceRule[]): Level {
  for (const r of rules) {
    if (!r.path && !r.name) continue
    if (r.path && !(change.files ?? []).some((f) => matcher(r.path!)(f) >= 0)) continue
    if (r.name && !(change.kind !== 'edge' && nameMatcher(r.name).test(change.name))) continue
    return r.level
  }
  return byDefault(change)
}

/** The changes with their levels. */
export function withLevels(changes: Change[], rules: SignificanceRule[]): Change[] {
  return changes.map((c) => ({ ...c, level: significance(c, rules) }))
}
