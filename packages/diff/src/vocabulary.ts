import { walkArch, type ArchNode, type Diagram } from '@mag/core'
import type { Vocabulary } from './types.ts'

export const clean = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '')

/** A glob (`*`, `**`) or a plain path: the file itself or anything under the folder. */
export function matcher(pattern: string): (path: string) => number {
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

/**
 * The vocabulary a PR's fact is read in (T-57.4): the architecture's, plus the modules its plan diagrams draw with a
 * path the architecture does not have yet (a new module), so the fact speaks of them by the plan's ids.
 */
export function planVocabulary(modules: ArchNode[], diagrams: Diagram[]): Vocabulary {
  const out = vocabularyOf(modules)
  const ids = new Set(out.modules.map((m) => m.id))
  for (const d of diagrams) {
    if (d.type !== 'component') continue
    for (const m of vocabularyOf(d.modules as unknown as ArchNode[]).modules) if (!ids.has(m.id)) (ids.add(m.id), out.modules.push(m))
  }
  return out
}

/** Folders whose children are each a module of their own: a monorepo's apps and packages, a source root's areas. */
const PACKAGE_DIRS = new Set(['apps', 'packages', 'services', 'libs', 'modules', 'cmd', 'internal', 'pkg', 'crates', 'plugins', 'src', 'lib'])

/**
 * The vocabulary of a repository without a recorded architecture (reviews-ahent-reviuit-pr-timeitiv.3, Decision 10): a
 * module per top folder of `paths`, one per child of a folder like apps/, packages/ or src/. Files at the root get none.
 */
export function folderVocabulary(paths: string[]): Vocabulary {
  const seen = new Set<string>()
  const out: Vocabulary['modules'] = []
  for (const p of paths.map(clean)) {
    const parts = p.split('/')
    if (parts.length < 2) continue
    const dir = PACKAGE_DIRS.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push({ id: dir.replace(/[^\w-]+/g, '-'), paths: [dir] })
  }
  return { modules: out }
}
