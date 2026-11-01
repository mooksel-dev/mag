import { builtinModules } from 'node:module'
import { dirname, join, normalize } from 'node:path/posix'
import { typescript } from './typescript.ts'
import { moduleResolver } from './vocabulary.ts'
import type { Change, ChangeSet, Element, FileDiff, FileImport, GitSource, Hunk, LangAdapter, ModuleEdge, ParsedElement, Repo, Skeleton, Vocabulary } from './types.ts'

export const ADAPTERS: LangAdapter[] = [typescript]

/** Source files of languages without an adapter yet: a change there makes the set non-deterministic. */
const CODE = /\.(py|go|rs|java|kt|kts|scala|rb|php|cs|fs|swift|m|mm|c|h|cc|cpp|hpp|ex|exs|erl|clj|dart|lua|sql|prisma|proto|graphql|gql|tf|hcl|vue|svelte)$/i
const TEST = /(^|\/)(__tests__|__mocks__)\/|\.(test|spec|stories)\.[^./]+$/
export const isTest = (path: string) => TEST.test(path)

const adapterOf = (path: string) => ADAPTERS.find((a) => a.matches(path))

/** A source file: one an adapter reads or of a language without an adapter yet. */
export const isCode = (path: string) => !!adapterOf(path) || CODE.test(path)

interface Parsed {
  elements: ParsedElement[]
  imports: { spec: string; line: number }[]
}

/** Parsed files by blob sha and adapter: a blob parses once however many commits share it. */
const cache = new Map<string, Parsed>()
const CACHE_MAX = 20000

const BUILTIN = new Set(builtinModules)
const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const pkgOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

const repoOf = (repo: string | Repo): Repo => (typeof repo === 'string' ? { path: repo, name: repo.split('/').filter(Boolean).at(-1) ?? repo } : repo)

const overlaps = (a: [number, number], start: number, count: number) => count > 0 && start <= a[1] && start + count - 1 >= a[0]

export function createDiff(git: GitSource) {
  async function parseAll(repo: string, files: { path: string; blob: string }[]): Promise<Map<string, Parsed>> {
    const key = (f: { path: string; blob: string }) => `${adapterOf(f.path)!.lang}:${f.path.split('.').at(-1)}:${f.blob}`
    const missing = [...new Set(files.filter((f) => !cache.has(key(f))).map((f) => f.blob))]
    const src = missing.length ? await git.blobs(repo, missing) : new Map<string, string>()
    const out = new Map<string, Parsed>()
    for (const f of files) {
      const k = key(f)
      let p = cache.get(k)
      if (!p) {
        const a = adapterOf(f.path)!
        const text = src.get(f.blob) ?? ''
        try {
          p = { elements: a.elements(f.path, text), imports: a.imports(f.path, text) }
        } catch {
          p = { elements: [], imports: [] }
        }
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
        cache.set(k, p)
      }
      out.set(f.path, p)
    }
    return out
  }

  /** Workspace packages of the tree: name → folder and entry points, for imports like `@mag/core`. */
  async function packagesOf(repo: string, tree: { path: string; blob: string }[]) {
    const manifests = tree.filter((f) => f.path === 'package.json' || f.path.endsWith('/package.json')).filter((f) => !f.path.includes('node_modules/'))
    const src = manifests.length ? await git.blobs(repo, manifests.map((f) => f.blob)) : new Map<string, string>()
    const out = new Map<string, { dir: string; entries: Record<string, string> }>()
    for (const m of manifests) {
      try {
        const pkg = JSON.parse(src.get(m.blob) ?? '')
        if (typeof pkg.name !== 'string') continue
        const entries: Record<string, string> = {}
        if (typeof pkg.exports === 'string') entries['.'] = pkg.exports
        else if (pkg.exports && typeof pkg.exports === 'object')
          for (const [k, v] of Object.entries(pkg.exports)) {
            const target = typeof v === 'string' ? v : (v as Record<string, unknown>)?.import ?? (v as Record<string, unknown>)?.default
            if (typeof target === 'string') entries[k] = target
          }
        if (!entries['.'] && typeof pkg.main === 'string') entries['.'] = pkg.main
        out.set(pkg.name, { dir: dirname(m.path), entries })
      } catch {}
    }
    return out
  }

  async function skeleton(repoArg: string | Repo, sha: string, vocabulary: Vocabulary): Promise<Skeleton> {
    const repo = repoOf(repoArg)
    const tree = await git.treeAt(repo.path, sha)
    const paths = new Set(tree.map((f) => f.path))
    const sources = tree.filter((f) => !isTest(f.path) && adapterOf(f.path))
    const parsed = await parseAll(repo.path, sources)
    const packages = await packagesOf(repo.path, tree)
    const moduleOf = moduleResolver(vocabulary)

    const resolveFile = (base: string): string | null => {
      base = normalize(base)
      const noJs = base.replace(/\.(m?js|cjs|jsx)$/, '')
      for (const p of [base, ...SOURCE_EXT.map((e) => noJs + e), ...SOURCE_EXT.map((e) => join(base, 'index' + e))]) if (paths.has(p)) return p
      return null
    }
    const resolve = (from: string, spec: string): string | null => {
      if (spec.startsWith('.')) return resolveFile(join(dirname(from), spec))
      if (spec.startsWith('node:') || BUILTIN.has(spec) || BUILTIN.has(spec.split('/')[0]) || /^[@~]\//.test(spec)) return null
      const name = pkgOf(spec)
      const pkg = packages.get(name)
      if (!pkg) return `ext:${name}`
      const sub = `.${spec.slice(name.length)}`
      const entry = pkg.entries[sub] ?? (sub === '.' ? 'index' : sub)
      return resolveFile(join(pkg.dir, entry)) ?? pkg.dir
    }

    const elements: Element[] = []
    const imports: FileImport[] = []
    for (const f of sources) {
      const p = parsed.get(f.path)!
      const module = moduleOf(f.path)
      for (const e of p.elements) elements.push({ ...e, ref: `${repo.name}:${f.path}#${e.name}`, path: f.path, module })
      for (const i of p.imports) imports.push({ path: f.path, spec: i.spec, line: i.line, target: resolve(f.path, i.spec) })
    }
    const edges = new Map<string, ModuleEdge>()
    for (const i of imports) {
      const from = moduleOf(i.path)
      const to = i.target?.startsWith('ext:') ? i.target : i.target ? moduleOf(i.target) : null
      if (!from || !to || from === to) continue
      const e = edges.get(`${from} -> ${to}`) ?? { from, to, files: [] }
      if (!e.files.includes(i.path)) e.files.push(i.path)
      edges.set(`${from} -> ${to}`, e)
    }
    const unparsed = tree.filter((f) => !isTest(f.path) && !adapterOf(f.path) && CODE.test(f.path)).map((f) => f.path)
    return { repo: repo.name, sha, elements, imports, edges: [...edges.values()], unparsed }
  }

  async function changes(repoArg: string | Repo, baseSha: string, headSha: string, vocabulary: Vocabulary): Promise<ChangeSet> {
    const repo = repoOf(repoArg)
    const [diffs, base, head] = await Promise.all([git.diffHunks(repo.path, baseSha, headSha), skeleton(repo, baseSha, vocabulary), skeleton(repo, headSha, vocabulary)])
    const moduleOf = moduleResolver(vocabulary)
    const out: Change[] = []
    const byPath = (s: Skeleton) => {
      const m = new Map<string, Element[]>()
      for (const e of s.elements) m.set(e.path, [...(m.get(e.path) ?? []), e])
      return m
    }
    const baseEls = byPath(base)
    const headEls = byPath(head)
    const hunksOf = (d: FileDiff, pick: (h: Hunk) => boolean) => d.hunks.filter(pick).map((h) => ({ path: d.path, ...h }))
    const elementHunks = (d: FileDiff, before?: Element, after?: Element) =>
      hunksOf(d, (h) => !!(after?.lines.some((r) => overlaps(r, h.newStart, h.newLines)) || before?.lines.some((r) => overlaps(r, h.oldStart, h.oldLines))))
    const elementChange = (e: Element, diff: Change['diff'], d: FileDiff, extra: Partial<Change>): Change => ({
      key: e.ref, kind: 'element', diff, module: e.module, path: e.path, line: e.lines[0]?.[0], name: e.name, elementKind: e.kind, decl: e.decl, exported: e.exported, hunks: [], ...extra,
    })

    const added: Change[] = []
    const deleted: { change: Change; el: Element }[] = []
    for (const d of diffs) {
      out.push({
        key: `${repo.name}:${d.path}`, kind: 'file', diff: d.status === 'rename' ? 'move' : d.status, module: moduleOf(d.path), path: d.path,
        ...(d.oldPath && { from: d.oldPath }), ...(isTest(d.path) && { test: true }), hunks: hunksOf(d, () => true),
      })
      if (isTest(d.path)) continue
      const before = new Map((d.status === 'add' ? [] : (baseEls.get(d.oldPath ?? d.path) ?? [])).map((e) => [e.name, e]))
      const after = new Map((d.status === 'del' ? [] : (headEls.get(d.path) ?? [])).map((e) => [e.name, e]))
      for (const [name, a] of after) {
        const b = before.get(name)
        if (!b) {
          const c = elementChange(a, 'add', d, { after: a.signature, hunks: elementHunks(d, undefined, a) })
          added.push(c)
          out.push(c)
        } else if (b.signature !== a.signature || b.bodyHash !== a.bodyHash) {
          const part = b.signature !== a.signature ? 'signature' : 'body'
          out.push(elementChange(a, 'mod', d, { before: b.signature, after: a.signature, part, hunks: elementHunks(d, b, a) }))
        } else if (b.module !== a.module) {
          out.push(elementChange(a, 'move', d, { before: b.signature, after: a.signature, from: b.ref, hunks: elementHunks(d, b, a) }))
        }
      }
      for (const [name, b] of before) {
        if (after.has(name)) continue
        const c = elementChange(b, 'del', d, { before: b.signature, hunks: elementHunks(d, b) })
        deleted.push({ change: c, el: b })
        out.push(c)
      }
    }
    // The same body deleted in one place and added in another moved there.
    for (const { change, el } of deleted) {
      const add = added.find((c) => c.diff === 'add' && c.name === el.name && head.elements.find((e) => e.ref === c.key)?.bodyHash === el.bodyHash)
      if (!add) continue
      Object.assign(add, { diff: 'move', from: el.ref, before: el.signature, hunks: [...add.hunks, ...change.hunks] })
      out.splice(out.indexOf(change), 1)
    }

    // Module dependencies that appear or go away, with the hunks of the imports that make them.
    const edgeKey = (e: ModuleEdge) => `${e.from} -> ${e.to}`
    const baseEdges = new Map(base.edges.map((e) => [edgeKey(e), e]))
    const headEdges = new Map(head.edges.map((e) => [edgeKey(e), e]))
    const importHunks = (s: Skeleton, e: ModuleEdge, side: 'old' | 'new') =>
      diffs.flatMap((d) => {
        const path = side === 'old' ? (d.oldPath ?? d.path) : d.path
        if (!e.files.includes(path)) return []
        const lines = s.imports.filter((i) => i.path === path && (i.target?.startsWith('ext:') ? i.target : i.target && moduleOf(i.target)) === e.to).map((i) => i.line)
        return hunksOf(d, (h) => lines.some((l) => (side === 'new' ? overlaps([l, l], h.newStart, h.newLines) : overlaps([l, l], h.oldStart, h.oldLines))))
      })
    for (const [k, e] of headEdges)
      if (!baseEdges.has(k)) out.push({ key: k, kind: 'edge', diff: 'add', module: e.from, name: e.to, hunks: importHunks(head, e, 'new') })
    for (const [k, e] of baseEdges)
      if (!headEdges.has(k)) out.push({ key: k, kind: 'edge', diff: 'del', module: e.from, name: e.to, hunks: importHunks(base, e, 'old') })

    const unparsed = diffs.filter((d) => d.status !== 'del' && !isTest(d.path) && head.unparsed.includes(d.path)).map((d) => d.path)
    return { repo: repo.name, baseSha, headSha, changes: out, deterministic: unparsed.length === 0, unparsed }
  }

  return { skeleton, changes }
}

export type DiffEngine = ReturnType<typeof createDiff>
