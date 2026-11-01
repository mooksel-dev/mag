// Every code file in exactly one module, and module ids that survive a new run of the architect (T-56 F2, T-57.2).
import { walkArch, type ArchNode } from '@mag/core'
import { isCode } from './engine.ts'
import type { Vocabulary } from './types.ts'
import { clean, moduleResolver, vocabularyOf } from './vocabulary.ts'

/** Code files (tests included) that no module of the vocabulary owns. */
export function unowned(vocabulary: Vocabulary, files: string[]): string[] {
  const of = moduleResolver(vocabulary)
  return files.filter((f) => isCode(f) && !of(f))
}

/** A path more than one module gives: the files under it would be in each of them. */
export function sharedPaths(vocabulary: Vocabulary): { path: string; modules: string[] }[] {
  const by = new Map<string, string[]>()
  for (const m of vocabulary.modules)
    for (const p of new Set(m.paths.map(clean))) by.set(p, [...(by.get(p) ?? []), m.id])
  return [...by].filter(([, ids]) => ids.length > 1).map(([path, modules]) => ({ path, modules }))
}

/** How much two sets of files have in common to count as one module under two ids. */
const SAME = 0.5

/**
 * Old ids for the modules of `next` that are those of `prev` under a new id: the new id is not in `prev`, the old one
 * is gone from `next`, both are on the same level, and the files they own with their inner modules overlap by at least
 * half (Jaccard). `files` are the repo's files; without them the paths of both trees stand in. Returns new id → old id;
 * the best overlaps pair first, each id at most once.
 */
export function carryIds(prev: ArchNode[], next: ArchNode[], files: string[]): Map<string, string> {
  const universe = files.length ? files : [...new Set([...vocabularyOf(prev).modules, ...vocabularyOf(next).modules].flatMap((m) => m.paths.map(clean)))]
  const prevOwn = owned(prev, universe)
  const nextOwn = owned(next, universe)
  const pairs: { from: string; to: string; score: number }[] = []
  for (const [id, a] of nextOwn) {
    if (prevOwn.has(id)) continue
    for (const [old, b] of prevOwn) {
      if (nextOwn.has(old) || a.level !== b.level) continue
      const common = [...a.files].filter((f) => b.files.has(f)).length
      const score = common / (a.files.size + b.files.size - common || 1)
      if (common && score >= SAME) pairs.push({ from: id, to: old, score })
    }
  }
  pairs.sort((x, y) => y.score - x.score)
  const out = new Map<string, string>()
  const taken = new Set<string>()
  for (const p of pairs) {
    if (out.has(p.from) || taken.has(p.to)) continue
    out.set(p.from, p.to)
    taken.add(p.to)
  }
  return out
}

/** Every module with its level and the files it owns with its inner modules. */
function owned(tree: ArchNode[], files: string[]): Map<string, { level: string; files: Set<string> }> {
  const of = moduleResolver(vocabularyOf(tree))
  const out = new Map<string, { level: string; files: Set<string> }>()
  const ancestors = new Map<string, string[]>()
  walkArch(tree, (n, anc) => {
    out.set(n.id, { level: n.level ?? (anc.length ? 'module' : 'system'), files: new Set() })
    ancestors.set(n.id, anc.map((a) => a.id))
  })
  for (const f of files) {
    const id = of(f)
    if (id) for (const m of [id, ...ancestors.get(id)!]) out.get(m)!.files.add(f)
  }
  return out
}
