// mag's check of a change inventory against the hunks (diff-iak-inventar-zmin-ai.1): language-agnostic, no parser. Every
// hunk of the PRs has an id (H1…, in diff order across the repositories of the fact) and every block of consecutive
// changed lines in it one more (H1.1, H1.2…); the inventory cites the blocks. What it checks is what the spike's
// check.py did: blocks in no unit, ids that do not exist, units whose name their hunks do not bear out, units on a
// module that owns none of their hunks; and, as warnings, code called noise and declarations no unit names.
import { unitLeaf, type ChangeInventory, type InventoryUnit } from '@mag/core'
import type { FileChange, HunkBlock, InventoryCheck } from './types.ts'

/** The files with an id on every hunk, H1… in their order (the order of the repositories, then of git's diff). */
export function numberHunks(files: FileChange[]): FileChange[] {
  let n = 0
  return files.map((f) => ({ ...f, hunks: f.hunks.map((h) => ({ ...h, id: `H${++n}` })) }))
}

/** The blocks of consecutive changed lines of numbered hunks, each `<hunk id>.<k>`. */
export function hunkBlocks(files: FileChange[]): HunkBlock[] {
  const out: HunkBlock[] = []
  for (const f of files)
    for (const h of f.hunks) {
      if (!h.id) continue
      let cur: HunkBlock | null = null
      let k = 0
      for (const l of h.lines ?? []) {
        if (l[0] === '+' || l[0] === '-') {
          if (!cur) out.push((cur = { id: `${h.id}.${++k}`, hunk: h.id, repo: f.repo, path: f.path, module: f.module, kind: f.kind, lines: [] }))
          cur.lines.push(l)
        } else cur = null
      }
    }
  return out
}

const WORD = /[A-Za-z_$][\w$]*/g
const words = (text: string) => new Set(text.match(WORD) ?? [])
const IDENT = /^[A-Za-z_$][\w$]*$/
/** A changed line that is a comment or blank: no change of the design by itself. */
const COMMENT = /^[+-]\s*(\/\/|#|\/\*|\*|--|$)/

/** A path's last segment: `review.tpl` of `prompts/review.tpl`. */
const baseName = (path: string) => path.split('/').at(-1) ?? path

/**
 * A name that reads as a file name (`dar-request.tpl`, `prompts/review.md`): a base name with an extension that has a
 * character no identifier has, or is the base name of one of `paths`. Such a name is never cut at its dots.
 */
function fileLike(name: string, paths: string[]): boolean {
  const base = baseName(name)
  return /^[\w-]+(\.[\w-]+)+$/.test(base) && (base.includes('-') || paths.some((p) => baseName(p) === base))
}

/** Whether a name is the file at one of `paths`: its base name, with or without its extension. */
const namesFile = (name: string, paths: string[]) => paths.some((p) => baseName(p) === baseName(name) || fileStems(p).includes(baseName(name)))

/**
 * What a name must be found as in its hunks: a file name whole (its base name), else the last segment of the name
 * (`save` of `Repository.save`); null when that is no identifier, nothing to look for.
 */
function keyName(name: string, paths: string[]): string | null {
  if (fileLike(name, paths)) return baseName(name)
  const leaf = unitLeaf(name)
  return IDENT.test(leaf) ? leaf : null
}

/** Names that must occur in a unit's hunks: its name's, and its old name's for a rename (keyName). */
function keyNames(u: InventoryUnit, paths: string[] = []): string[] {
  return [u.name, ...(u.change === 'rename' && u.from ? [u.from] : [])].map((n) => keyName(n, paths)).filter((n): n is string => !!n)
}

/**
 * A config unit is also borne out by the constant it is part of (`DEFAULT_PLAYBOOK` of `DEFAULT_PLAYBOOK.fact`), named
 * in any hunk of its file: a long constant changes far below the line that names it.
 */
function ownerNames(u: InventoryUnit): string[] {
  if (u.kind !== 'config') return []
  return [u.owner, u.name.split(/[.#/:]/)[0]].filter((n): n is string => !!n && IDENT.test(n))
}

/** A file's base name without its extension, without each one for several: `review` and `review.md` of `prompts/review.md.tmpl`. */
function fileStems(path: string): string[] {
  const parts = (path.split('/').at(-1) ?? path).split('.')
  return parts.length < 2 ? parts : parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('.')).filter(Boolean)
}

// Declarations a changed line may make, by the shape most languages give them (a warning only, never a blocker).
const DECL = [
  /^[+-]\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/, // go
  /^[+-]\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, // js / ts
  /^[+-]\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^=]*)?\{\s*$/, // a method
  /^[+-]\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, // an arrow function (or a call: a hint)
  /^[+-]\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*\([^)]*\)\s*:\s*[^;{=]+;?\s*$/, // an interface method
  /^[+-]\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // python
  /^[+-]\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|enum|struct|protocol)\s+([A-Za-z_$][\w$]*)/, // types
  /^[+-]\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, // go types
]
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try'])

/**
 * The inventory against the numbered hunks of `files`. A hunk id stands for every block of its hunk. Blockers: a
 * block of a code file in no unit and not in noise; an id that is not a block or hunk; a unit whose name (the last
 * segment, a file name whole; both for a rename; the base name of its file, with or without the extension, the old
 * path's for the old name) is not in the lines (changed and context) or the header of
 * the hunks of its blocks, nor, for a config unit, its constant in a hunk of its file; a unit on a module that owns none of its blocks. Dependencies are
 * checked for their blocks only: the module they use is often not named there.
 */
export function checkInventory(inventory: ChangeInventory, files: FileChange[]): InventoryCheck {
  const blocks = hunkBlocks(files)
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const ofHunk = new Map<string, HunkBlock[]>()
  for (const b of blocks) ofHunk.set(b.hunk, [...(ofHunk.get(b.hunk) ?? []), b])
  const hunks = new Map(files.flatMap((f) => f.hunks.flatMap((h) => (h.id ? [[h.id, { file: f, hunk: h }] as const] : []))))
  const unknown: InventoryCheck['unknown'] = []
  const expand = (ids: string[], by: string) =>
    ids.flatMap((id) => {
      const found = byId.has(id) ? [byId.get(id)!] : (ofHunk.get(id) ?? [])
      if (!found.length) unknown.push({ id, by })
      return found
    })

  const claimed = new Set<string>()
  const ungrounded: InventoryCheck['ungrounded'] = []
  const otherModule: InventoryCheck['otherModule'] = []
  for (const u of inventory.units) {
    const of = expand(u.hunks, u.id)
    of.forEach((b) => claimed.add(b.id))
    if (!of.length) {
      ungrounded.push({ unit: u.id, name: u.name, why: 'none of its hunks exists' })
      continue
    }
    if (u.kind === 'dependency') continue
    // A name is borne out by the hunks around its blocks: a body change shows its method in the context or the header.
    const around = [...new Set(of.map((b) => b.hunk))].map((id) => hunks.get(id)!)
    const seen = words(around.map(({ hunk }) => [hunk.header ?? '', ...(hunk.lines ?? [])].join('\n')).join('\n'))
    const text = around.map(({ hunk }) => [hunk.header ?? '', ...(hunk.lines ?? [])].join('\n')).join('\n')
    const paths = around.map(({ file }) => file.path)
    // A renamed file's old name is its old path's.
    const oldPaths = around.map(({ file }) => file.oldPath ?? file.path)
    const allPaths = [...paths, ...oldPaths]
    const borneOut = (name: string, own: string[]) => {
      if (namesFile(name, own)) return true
      const key = keyName(name, allPaths)
      return !key || (fileLike(name, allPaths) ? text.includes(key) : seen.has(key))
    }
    const missing = [
      ...(borneOut(u.name, u.change === 'rename' ? paths : allPaths) ? [] : [keyName(u.name, allPaths)!]),
      ...(u.change === 'rename' && u.from && !borneOut(u.from, oldPaths) ? [keyName(u.from, allPaths)!] : []),
    ]
    const inFile = () => words(around.flatMap(({ file }) => file.hunks.flatMap((h) => [h.header ?? '', ...(h.lines ?? [])])).join('\n'))
    if (missing.length && !(ownerNames(u).length && ownerNames(u).some((n) => inFile().has(n))))
      ungrounded.push({ unit: u.id, name: u.name, why: `${missing.join(', ')} is not in its hunks` })
    const modules = [...new Set(of.map((b) => b.module ?? ''))]
    if (of.every((b) => b.module !== null && b.module !== u.module)) otherModule.push({ unit: u.id, name: u.name, module: u.module, hunkModules: modules })
  }
  const noised = new Map<string, string>()
  for (const [i, n] of inventory.noise.entries()) for (const b of expand(n.hunks, `noise[${i}]`)) noised.set(b.id, n.reason)

  const code = blocks.filter((b) => b.kind === 'code')
  const unaccounted = code.filter((b) => !claimed.has(b.id) && !noised.has(b.id))
  const noiseClaims = code.flatMap((b) => {
    const real = b.lines.filter((l) => !COMMENT.test(l)).length
    return !claimed.has(b.id) && noised.has(b.id) && real ? [{ block: b.id, reason: noised.get(b.id)!, lines: real }] : []
  })
  // Per module: a name a unit of another module gives does not cover a declaration here.
  const named = new Map<string, Set<string>>()
  for (const u of inventory.units) {
    const set = named.get(u.module) ?? new Set<string>()
    for (const w of [...keyNames(u), ...words(`${u.name} ${u.before ?? ''} ${u.after ?? ''}`)]) set.add(w)
    named.set(u.module, set)
  }
  const undeclared: InventoryCheck['undeclared'] = []
  for (const b of code)
    for (const l of b.lines) {
      const name = DECL.map((rx) => rx.exec(l)?.[1]).find(Boolean)
      if (name && !KEYWORDS.has(name) && !named.get(b.module ?? '')?.has(name)) undeclared.push({ block: b.id, name, line: l.trim().slice(0, 120) })
    }
  return { blocks: blocks.length, codeBlocks: code.length, units: inventory.units.length, unaccounted, unknown, ungrounded, otherModule, noiseClaims, undeclared }
}

const where = (b: HunkBlock) => `${b.repo}:${b.path}`

/** What of the check keeps a review from merge, one line each; [] when the inventory accounts for every code block. */
export function inventoryBlockers(check: InventoryCheck): string[] {
  return [
    ...check.unaccounted.map((b) => `${b.id} (${where(b)}, ${b.module ?? 'no module'}) is changed code in no unit and not in noise`),
    ...check.unknown.map((u) => `${u.by} cites ${u.id}, which is no hunk of the PRs`),
    ...check.ungrounded.map((u) => `unit ${u.unit} (${u.name}): ${u.why}`),
    ...check.otherModule.map((u) => `unit ${u.unit} (${u.name}) is on ${u.module}, its hunks are of ${u.hunkModules.join(', ') || 'no module'}`),
  ]
}

/** The check as the reviewer reads it: the blockers, then the warnings to answer. */
export function formatInventoryCheck(check: InventoryCheck): string {
  const out = [`Inventory: ${check.units} unit(s) over ${check.codeBlocks} block(s) of changed code (${check.blocks} in all).`]
  const blockers = inventoryBlockers(check)
  out.push(blockers.length ? `Blockers (${blockers.length}):\n${blockers.map((b) => `- ${b}`).join('\n')}` : 'Every block of changed code is in a unit or noise, and every unit rests on its hunks.')
  if (check.noiseClaims.length)
    out.push(`Code blocks called noise that change real lines (check the reason holds) (${check.noiseClaims.length}):\n${check.noiseClaims.map((n) => `- ${n.block}: ${n.lines} line(s), "${n.reason}"`).join('\n')}`)
  if (check.undeclared.length)
    out.push(`Declarations in changed lines no unit of their module names (a hint: add the unit, or leave it when it is part of one) (${check.undeclared.length}):\n${check.undeclared.map((d) => `- ${d.block} ${d.name}: ${d.line}`).join('\n')}`)
  return out.join('\n')
}
