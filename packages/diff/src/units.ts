// Changed units (povnyi-diff-nabir-pov-iazanykh.1, Decisions 8–9): the public methods, models and dependencies a diff
// changes, read from what git gives, no code parsed: the declaration each hunk header names (git's xfuncname with mag's
// patterns below) and the changed lines themselves (declarations, imports). With --unified=0 every hunk is a run of
// changed lines, so a hunk across several declarations has the later ones among its changed lines.
import { builtinModules } from 'node:module'
import { dirname, join, normalize } from 'node:path/posix'
import { walkArch, type ArchNode } from '@mag/core'
import { moduleResolver } from './vocabulary.ts'
import type { ChangedUnit, FileChange, Hunk, Vocabulary } from './types.ts'

/** Languages whose declarations mag reads; other code gets git's own drivers and only low-confidence units. */
export type Lang = 'ts' | 'go' | 'py' | 'swift' | 'sql' | 'prisma' | 'proto' | 'graphql' | 'tf' | 'other'

const EXT: [RegExp, Lang][] = [
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, 'ts'],
  [/\.go$/i, 'go'],
  [/\.pyi?$/i, 'py'],
  [/\.swift$/i, 'swift'],
  [/\.sql$/i, 'sql'],
  [/\.prisma$/i, 'prisma'],
  [/\.proto$/i, 'proto'],
  [/\.(graphql|gql)$/i, 'graphql'],
  [/\.tf$/i, 'tf'],
]

export const langOf = (path: string): Lang => EXT.find(([re]) => re.test(path))?.[1] ?? 'other'

const SCHEMA = new Set<Lang>(['sql', 'prisma', 'proto', 'graphql', 'tf'])
const READ = new Set<Lang>(['ts', 'go', 'py', 'swift'])

/** A git diff driver: its name, the files it is for and its xfuncname (ERE lines; a `!` line rules a line out). */
export interface FuncnameDriver {
  name: string
  files: string[]
  xfuncname?: string
}

const T = '[ \t]'
/**
 * mag's diff drivers, passed to git without touching the user's repository (Decision 9): TypeScript / JavaScript and
 * Swift have no driver of git's own; for Go and Python mag's own name top-level declarations too, so a change in a
 * `var (…)` block or a module constant is not taken for the function before it. Java, Kotlin, C#, Rust, Ruby and PHP
 * get git's built-in drivers.
 */
export const FUNCNAME_DRIVERS: FuncnameDriver[] = [
  {
    name: 'magts',
    files: ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'],
    xfuncname: [
      `!^${T}*(if|else|for|while|do|switch|case|default|catch|try|finally|return|throw|new|await|yield|typeof|delete|void|super|this|with)([^A-Za-z0-9_$]|$)`,
      // A call that passes a callback (`walkArch(nodes, (n) => {`, `useEffect(() => {`) is no declaration.
      `!^${T}+.*(=>${T}*\\{|[^A-Za-z0-9_$]function${T}*\\()`,
      `^(${T}*(export${T}+)?(default${T}+)?(declare${T}+)?(abstract${T}+)?(class|interface|enum|namespace|type)${T}+[A-Za-z_$].*)$`,
      `^(${T}*(export${T}+)?(default${T}+)?(async${T}+)?function(${T}|\\*).*)$`,
      `^((export${T}+)?(const|let|var)${T}+[A-Za-z_$].*)$`,
      `^(${T}+((public|private|protected|static|readonly|async|override|abstract|get|set)${T}+)*#?[A-Za-z_$][A-Za-z0-9_$]*${T}*(<.*>)?${T}*\\(.*\\{${T}*)$`,
    ].join('\n'),
  },
  { name: 'maggo', files: ['*.go'], xfuncname: [`^(func${T}.*)$`, `^(type${T}.*)$`, `^((var|const|import)([${T.slice(1, -1)}(].*)?)$`].join('\n') },
  {
    name: 'magpy',
    files: ['*.py', '*.pyi'],
    xfuncname: [`^(${T}*(async${T}+)?def${T}.*)$`, `^(${T}*class${T}.*)$`, `^([A-Za-z_][A-Za-z0-9_]*${T}*(:[^=]*)?=.*)$`].join('\n'),
  },
  {
    name: 'magswift',
    files: ['*.swift'],
    xfuncname: [
      `^(${T}*((@[A-Za-z]+|public|open|internal|private|fileprivate|static|class|final|override|mutating|nonisolated|convenience|required)${T}+)*(func|init|deinit|subscript)([${T.slice(1, -1)}(<?].*)?)$`,
      `^(${T}*((@[A-Za-z]+|public|open|internal|private|fileprivate|final|indirect)${T}+)*(class|struct|enum|protocol|actor|extension)${T}+[A-Za-z_].*)$`,
      `^(${T}*((public|open|internal|private|fileprivate|static|class|final|override|lazy)${T}+)*(var|let)${T}+.*\\{${T}*)$`,
    ].join('\n'),
  },
  { name: 'magsql', files: ['*.sql'], xfuncname: `^${T}*(([Cc][Rr][Ee][Aa][Tt][Ee]|[Aa][Ll][Tt][Ee][Rr])${T}+.*)$` },
  { name: 'magprisma', files: ['*.prisma'], xfuncname: `^((model|enum|type|view)${T}.*)$` },
  { name: 'magproto', files: ['*.proto'], xfuncname: `^(${T}*(message|enum|service)${T}.*)$` },
  { name: 'maggraphql', files: ['*.graphql', '*.gql'], xfuncname: `^((extend${T}+)?(type|input|enum|interface|union|scalar)${T}.*)$` },
  { name: 'magtf', files: ['*.tf'], xfuncname: `^((resource|data|module|variable|output)${T}.*)$` },
  { name: 'java', files: ['*.java'] },
  { name: 'kotlin', files: ['*.kt', '*.kts'] },
  { name: 'csharp', files: ['*.cs'] },
  { name: 'rust', files: ['*.rs'] },
  { name: 'ruby', files: ['*.rb'] },
  { name: 'php', files: ['*.php'] },
]

/** The gitattributes lines that put each file pattern on its driver. */
export const funcnameAttributes = () => FUNCNAME_DRIVERS.flatMap((d) => d.files.map((f) => `${f} diff=${d.name}`)).join('\n') + '\n'

/** Whether a name is public by its language's convention: Go capitalized, the others not starting with `_` or `#`. */
export function isPublicName(lang: Lang, name: string): boolean {
  if (lang === 'go') return /^[A-Z]/.test(name)
  return !/^[_#]/.test(name)
}

interface Decl {
  kind: 'function' | 'type' | 'other'
  name: string
  public: boolean
  indent: number
}

const indentOf = (s: string) => s.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length
const ID = '[A-Za-z_$][\\w$]*'
const KEYWORDS = new Set('if else for while do switch case default catch try finally return throw new await yield typeof delete void super this with function'.split(' '))
const TS_TYPE = new RegExp(`^(export\\s+)?(default\\s+)?(declare\\s+)?(abstract\\s+)?(class|interface|enum|type|namespace)\\s+(${ID})`)
const TS_FUNCTION = new RegExp(`^(export\\s+)?(default\\s+)?(async\\s+)?function\\s*\\*?\\s*(${ID})`)
const TS_ARROW = new RegExp(`^(export\\s+)?(const|let|var)\\s+(${ID})\\s*(:[^=]*)?=\\s*(async\\s+)?(function\\b|\\(|${ID}\\s*=>|<)`)
const TS_VALUE = new RegExp(`^(export\\s+)?(const|let|var)\\s+(${ID})`)
const TS_METHOD = new RegExp(`^((?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*)(#?${ID})\\s*(<[^(]*>)?\\s*\\(.*\\{\\s*$`)
const TS_METHOD_HEAD = new RegExp(`^((?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*)(#?${ID})\\s*(<[^(]*>)?\\s*\\(`)
/** A call passing a callback, which TS_METHOD would take for a method. */
const CALLBACK = /=>\s*\{|\bfunction\s*\(/
const SWIFT_MODS = '((?:(?:@\\w+(?:\\([^)]*\\))?|public|open|internal|private|fileprivate|static|class|final|override|mutating|nonisolated|convenience|required|indirect|lazy)\\s+)*)'
const SWIFT_FUNC = new RegExp(`^${SWIFT_MODS}(?:func\\s+(\\w+)|(init|deinit|subscript)\\b)`)
const SWIFT_TYPE = new RegExp(`^${SWIFT_MODS}(class|struct|enum|protocol|actor|extension)\\s+(\\w+)`)
const SWIFT_VAR = new RegExp(`^${SWIFT_MODS}(var|let)\\s+(\\w+)`)
const TABLE = /\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?[`"[]?([\w.]+)/i

/** What a changed SQL statement does to its table: CREATE as the line says, DROP the opposite, ALTER changes it. */
function sqlSign(text: string, sign: string): string | null {
  if (/\bcreate\b/i.test(text)) return sign
  if (/\bdrop\b/i.test(text)) return sign === '+' ? '-' : '+'
  return null
}

/**
 * The declaration a line starts, in its language; null for any other line. `header`: a line git's driver matched in
 * full, given cut to 80 characters, so a method's signature needs no `{` at its end.
 */
function declOf(lang: Lang, line: string, header = false): Decl | null {
  const t = line.trim()
  const indent = indentOf(line)
  const d = (kind: Decl['kind'], name: string, pub: boolean): Decl => ({ kind, name, public: pub, indent })
  let m: RegExpMatchArray | null
  switch (lang) {
    case 'ts':
      if ((m = t.match(TS_TYPE))) return d(m[5] === 'namespace' ? 'other' : 'type', m[6], !!m[1] && isPublicName(lang, m[6]))
      if ((m = t.match(TS_FUNCTION))) return d('function', m[4], !!m[1] && isPublicName(lang, m[4]))
      if (indent === 0 && (m = t.match(TS_ARROW))) return d('function', m[3], !!m[1] && isPublicName(lang, m[3]))
      if (indent === 0 && (m = t.match(TS_VALUE))) return d('other', m[3], false)
      if (indent > 0 && (m = t.match(header ? TS_METHOD_HEAD : TS_METHOD)) && !KEYWORDS.has(m[2]) && !CALLBACK.test(t)) return d('function', m[2], !/\b(private|protected)\b/.test(m[1]) && isPublicName(lang, m[2]))
      return null
    case 'go':
      if ((m = t.match(/^func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/))) return d('function', m[1], isPublicName(lang, m[1]))
      if (indent === 0 && (m = t.match(/^type\s+([A-Za-z_]\w*)/))) return d('type', m[1], isPublicName(lang, m[1]))
      if (indent === 0 && (m = t.match(/^(var|const|import)\b/))) return d('other', m[1], false)
      return null
    case 'py':
      if ((m = t.match(/^(?:async\s+)?def\s+(\w+)/))) return d('function', m[1], isPublicName(lang, m[1]))
      if ((m = t.match(/^class\s+(\w+)/))) return d('type', m[1], isPublicName(lang, m[1]))
      if (indent === 0 && (m = t.match(/^([A-Za-z_]\w*)\s*(?::[^=]*)?=/))) return d('other', m[1], false)
      return null
    case 'swift': {
      const hidden = (mods: string) => /\b(private|fileprivate)\b/.test(mods)
      if ((m = t.match(SWIFT_FUNC))) return d('function', m[2] ?? m[3], !hidden(m[1]) && isPublicName(lang, m[2] ?? m[3]))
      if ((m = t.match(SWIFT_TYPE))) return d(m[2] === 'extension' ? 'other' : 'type', m[3], !hidden(m[1]) && isPublicName(lang, m[3]))
      if ((m = t.match(SWIFT_VAR)) && /\{\s*$/.test(t)) return d('other', m[3], false)
      return null
    }
    case 'sql':
      return (m = t.match(TABLE)) ? d('type', m[1].replace(/[`"\]]/g, ''), true) : null
    case 'prisma':
      return indent === 0 && (m = t.match(/^(model|enum|type|view)\s+(\w+)/)) ? d('type', m[2], true) : null
    case 'proto':
      if ((m = t.match(/^(message|enum)\s+(\w+)/))) return d('type', m[2], true)
      return (m = t.match(/^service\s+(\w+)/)) ? d('other', m[1], false) : null
    case 'graphql':
      return indent === 0 && (m = t.match(/^(?:extend\s+)?(type|input|enum|interface|union|scalar)\s+(\w+)/)) ? d('type', m[2], true) : null
    case 'tf':
      // Only tables are a data model; the rest of Terraform is infrastructure.
      if ((m = t.match(/^resource\s+"(\w+)"\s+"([\w-]+)"/))) return /_table$/.test(m[1]) ? d('type', m[2], true) : d('other', m[2], false)
      return indent === 0 && (m = t.match(/^(data|module|variable|output|resource)\b/)) ? d('other', m[1], false) : null
    default:
      if ((m = t.match(/\b(class|struct|interface|enum|record|trait|impl)\s+(\w+)/))) return d('type', m[2], true)
      if ((m = t.match(/(\w+)\s*\(/)) && !KEYWORDS.has(m[1])) return d('function', m[1], true)
      return null
  }
}

const COMMENT: Record<string, RegExp> = { py: /^(#|$)/, sql: /^(--|$)/, tf: /^(#|\/\/|\/\*|\*|$)/ }
const isComment = (lang: Lang, text: string) => (COMMENT[lang] ?? /^(\/\/|\/\*|\*|$)/).test(text.trim())

/** The modules a changed import line names, in its language; [] for any other line. */
export function importsOf(lang: Lang, line: string): string[] {
  let m: RegExpMatchArray | null
  switch (lang) {
    case 'ts': {
      if ((m = line.match(/^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/))) return [m[1]]
      if ((m = line.match(/^\s*(?:export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+|\}\s*)from\s+['"]([^'"]+)['"]/))) return [m[1]]
      return [...line.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((x) => x[1])
    }
    case 'py':
      if ((m = line.match(/^\s*from\s+(\.*[\w.]*)\s+import\b/))) return [m[1]]
      if ((m = line.match(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*$/))) return m[1].split(',').map((s) => s.trim().split(/\s+/)[0])
      return []
    case 'go':
      if ((m = line.match(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/))) return [m[1]]
      return (m = line.match(/^\s*(?:[\w.]+\s+)?"([^"\s]+)"\s*$/)) ? [m[1]] : []
    case 'swift':
      return (m = line.match(/^\s*(?:@testable\s+)?import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?(\w+)/)) ? [m[1]] : []
    default:
      return []
  }
}

const BUILTIN = new Set(builtinModules)
const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const pkgOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

/** What an import names: a module of the vocabulary (internal), a package outside it, or nothing to draw (the standard library). */
type Target = { module: string } | { package: string } | null

function importTarget(lang: Lang, file: string, spec: string, vocabulary: Vocabulary, moduleOf: (path: string) => string | null, depth: (id: string) => number): Target {
  // The file is one of the paths tried: the most specific module owning one of them (the others may fall to its app).
  const owned = (paths: string[]) =>
    paths
      .map(moduleOf)
      .filter((m): m is string => !!m)
      .reduce<string | null>((best, m) => (!best || depth(m) > depth(best) ? m : best), null)
  if (lang === 'ts' && spec.startsWith('.')) {
    const base = normalize(join(dirname(file), spec))
    const bare = base.replace(/\.(m?js|cjs|jsx)$/, '')
    const m = owned([base, ...SOURCE_EXT.map((e) => bare + e), ...SOURCE_EXT.map((e) => join(base, `index${e}`))])
    return m ? { module: m } : null
  }
  if (lang === 'py' && spec.startsWith('.')) {
    const ups = spec.match(/^\.+/)![0].length
    let dir = dirname(file)
    for (let i = 1; i < ups; i++) dir = dirname(dir)
    const rest = spec.slice(ups).replace(/\./g, '/')
    const base = rest ? join(dir, rest) : dir
    const m = owned([`${base}.py`, join(base, '__init__.py'), base])
    return m ? { module: m } : null
  }
  if (lang === 'ts' && (spec.startsWith('node:') || BUILTIN.has(spec) || BUILTIN.has(spec.split('/')[0]))) return null
  if (lang === 'go' && !spec.split('/')[0].includes('.')) return null
  // A path inside the project: the module whose folder the import names, the longest that fits.
  const path = lang === 'py' ? spec.replace(/\./g, '/') : spec
  let best: { id: string; len: number } | null = null
  for (const m of vocabulary.modules)
    for (const p of m.paths) {
      const fits = path === p || path.startsWith(`${p}/`) || (p.includes('/') && (path.endsWith(`/${p}`) || path.includes(`/${p}/`)))
      if (fits && (!best || p.length > best.len)) best = { id: m.id, len: p.length }
    }
  if (best) return { module: best.id }
  // A workspace package (`@scope/name`): the one module of a package folder named so.
  if (lang === 'ts' && spec.startsWith('@')) {
    const name = pkgOf(spec).split('/')[1]
    const hits = vocabulary.modules.filter((m) => m.paths.some((p) => p.endsWith(`/${name}`)))
    if (hits.length === 1) return { module: hits[0].id }
  }
  return { package: lang === 'go' ? spec : lang === 'py' ? spec.split('.')[0] : pkgOf(spec) }
}

/** Each module with its ancestors, outermost first. */
function chains(architecture: ArchNode[]): Map<string, string[]> {
  const chain = new Map<string, string[]>()
  walkArch(architecture, (n, ancestors) => chain.set(n.id, [...ancestors.map((a) => a.id), n.id]))
  return chain
}

/** Whether two modules are one, or one is inside the other: a dependency between them is not one between modules. */
function related(architecture: ArchNode[]): (a: string, b: string) => boolean {
  const chain = chains(architecture)
  return (a, b) => a === b || (chain.get(a) ?? []).includes(b) || (chain.get(b) ?? []).includes(a)
}

/** Whether the architecture has `from` (or a module around or inside it) using `to` (likewise) already. */
function usesAlready(architecture: ArchNode[]): (from: string, to: string) => boolean {
  const near = related(architecture)
  const edges: [string, string][] = []
  walkArch(architecture, (n) => n.uses.forEach((u) => edges.push([n.id, u.to])))
  return (from, to) => edges.some(([a, b]) => near(a, from) && near(b, to))
}

/**
 * The units a PR's changed code files change (Decision 8): each public function or method whose declaration or body
 * changes (bodyChanged: not only its signature), each public type, table or schema model, and each import of another
 * module added or removed, over the vocabulary of `architecture`. A dependency the architecture has already, or one
 * inside a module, is no change between modules. Hunks need their header and lines (diffHunks gives both locally).
 */
export function changedUnits(files: FileChange[], architecture: ArchNode[], vocabulary: Vocabulary): ChangedUnit[] {
  const moduleOf = moduleResolver(vocabulary)
  const near = related(architecture)
  const known = usesAlready(architecture)
  const chain = chains(architecture)
  const depth = (id: string) => chain.get(id)?.length ?? 0
  const units = new Map<string, ChangedUnit & { signs: Set<string> }>()
  const deps = new Map<string, ChangedUnit & { signs: Set<string> }>()

  for (const f of files) {
    if (f.kind !== 'code') continue
    const lang = langOf(f.path)
    const schema = SCHEMA.has(lang)
    const sure = READ.has(lang) || schema ? 'high' : 'low'
    const owner = f.module ?? moduleOf(f.path)
    const unit = (kind: ChangedUnit['kind'], name: string, confidence: ChangedUnit['confidence'], line: number) => {
      const key = `${f.repo}:${f.path}#${kind}:${name}`
      let u = units.get(key)
      if (!u) units.set(key, (u = { repo: f.repo, file: f.path, kind, name, module: owner, diff: 'mod', confidence, line, signs: new Set() }))
      return u
    }
    /** A change at `line` of a declaration: of its own line (sign: + or -) or of its body. */
    const touch = (d: Decl, confidence: ChangedUnit['confidence'], line: number, sign: string | null) => {
      if (d.kind === 'other' || !d.public) return
      const u = unit(d.kind === 'type' ? 'model' : 'method', d.name, confidence, line)
      if (sign) u.signs.add(sign)
      else if (d.kind === 'function') u.bodyChanged = true
    }
    let schemaNamed = false
    const fileLines: number[] = []

    for (const h of f.hunks as Hunk[]) {
      let ctx = h.header?.trim() ? declOf(lang, h.header, true) : null
      let oldNo = h.oldStart
      let newNo = h.newStart
      for (const raw of h.lines ?? []) {
        const sign = raw[0]
        if (sign !== '+' && sign !== '-') continue
        const text = raw.slice(1)
        const at = sign === '-' ? oldNo++ : newNo++
        if (isComment(lang, text)) continue
        fileLines.push(at)
        const specs = importsOf(lang, text)
        if (specs.length) {
          for (const spec of specs) {
            const target = importTarget(lang, f.path, spec, vocabulary, moduleOf, depth)
            if (!target || !owner) continue
            const to = 'module' in target ? target.module : target.package
            if ('module' in target && near(owner, to)) continue
            const key = `${f.repo}:${owner}->${to}`
            let u = deps.get(key)
            if (!u) deps.set(key, (u = { repo: f.repo, file: f.path, kind: 'dependency', name: to, module: owner, diff: 'mod', confidence: 'module' in target ? 'high' : 'low', line: at, signs: new Set() }))
            u.signs.add(sign)
          }
          continue
        }
        const d = declOf(lang, text)
        if (d) {
          ctx = d
          if (d.kind === 'type' && schema) schemaNamed = true
          touch(d, sure, at, lang === 'sql' ? sqlSign(text, sign) : sign)
          continue
        }
        const closing = /^[}\])]/.test(text.trim())
        if (ctx && (indentOf(text) > ctx.indent || (closing && indentOf(text) === ctx.indent))) {
          if (ctx.kind === 'type' && schema) schemaNamed = true
          touch(ctx, sure, at, null)
        } else if (indentOf(text) > 0 && !closing && !schema) {
          // Code under no declaration mag can name: a guess, a warning only.
          unit('method', '', 'low', at)
        } else ctx = null
      }
    }
    // A schema file changed where no table, model or message is named still changes the model.
    if (schema && !schemaNamed && fileLines.length && (lang !== 'tf' || f.hunks.some((h) => /_table"/.test(h.header ?? '') || (h.lines ?? []).some((l) => /_table"/.test(l)))))
      unit('model', f.path.split('/').at(-1)!.replace(/\.[^.]+$/, ''), 'high', fileLines[0])
  }

  const out: ChangedUnit[] = []
  for (const { signs, ...u } of units.values()) {
    // A declaration line only added is a new unit, only removed a removed one; both, or the body only, a change.
    const diff = signs.has('+') && !signs.has('-') ? 'add' : signs.has('-') && !signs.has('+') ? 'del' : 'mod'
    out.push({ ...u, diff, ...(u.kind === 'method' && { bodyChanged: !!u.bodyChanged }) })
  }
  for (const { signs, ...u } of deps.values()) {
    const added = signs.has('+')
    const removed = signs.has('-')
    // An import moved within the PR's files is no change of the dependency.
    if (added && removed) continue
    if (added && u.confidence === 'high' && known(u.module!, u.name)) continue
    // A removed import may leave others to the same module: only a guess that the dependency is gone.
    out.push({ ...u, diff: added ? 'add' : 'del', confidence: added ? u.confidence : 'low' })
  }
  return out
}
