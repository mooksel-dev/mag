import { walkArch, type ArchNode } from '@mag/core'
import type { Vocabulary } from './types.ts'

export const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '')

/** A glob (`*`, `**`) or a plain path: the file itself or anything under the folder. */
function matcher(pattern: string): (path: string) => number {
  const p = clean(pattern)
  if (!/[*?]/.test(p)) return (path) => (path === p || path.startsWith(`${p}/`) ? p.length : -1)
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}(/.*)?$`)
  // A glob is as specific as its literal prefix.
  const weight = p.split(/[*?]/)[0].length
  return (path) => (re.test(path) ? weight : -1)
}

/** The module owning `path`: the most specific match wins, so an inner module beats its app. null when none does. */
export function moduleResolver(vocabulary: Vocabulary): (path: string) => string | null {
  const rules = vocabulary.modules.flatMap((m) => m.paths.map((p) => ({ id: m.id, match: matcher(p) })))
  const cache = new Map<string, string | null>()
  return (path) => {
    if (cache.has(path)) return cache.get(path)!
    let best: string | null = null
    let weight = -1
    for (const r of rules) {
      const w = r.match(path)
      if (w > weight) [best, weight] = [r.id, w]
    }
    cache.set(path, best)
    return best
  }
}

/** The vocabulary of a recorded architecture: every module with a repo-relative path (`path` before T-57.2). */
export function vocabularyOf(modules: ArchNode[]): Vocabulary {
  const out: Vocabulary['modules'] = []
  walkArch(modules, (n) => {
    const paths = (n.paths?.length ? n.paths : n.path ? [n.path] : []).filter((p) => p && !/^([~/]|[a-z]+:)/i.test(p))
    if (paths.length) out.push({ id: n.id, paths })
  })
  return { modules: out }
}
