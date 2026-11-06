// The mechanical part of a change inventory for TS/JS files (prompts-use-the-models-to.6): mag parses each changed file
// at base and at head and gives every function, method and type its changed blocks of lines touch as a draft unit, with
// its signatures and the ids of those blocks. The reviewer adds the meaning (logic, note, stored) and the units no
// parser sees (dependencies, calls, fields, config, renames). Other languages get no draft.
import ts from 'typescript'
import type { InventoryDraft, InventoryUnit } from '@mag/core'

/** A changed file as the draft reads it: its numbered hunks (with context lines) and its text at base and at head. */
export interface DraftFile {
  path: string
  /** The module that owns it; files of no module get no units (the reviewer names their module). */
  module: string | null
  /** At base; null when the file is added. */
  before: string | null
  /** At head; null when the file is deleted. */
  after: string | null
  hunks: { id?: string; oldStart: number; newStart: number; lines?: string[] }[]
}

const DRAFT_EXT = /\.(c|m)?(t|j)sx?$/
/** Files the draft parses: TS and JS sources, never declaration files. */
export const draftable = (path: string) => DRAFT_EXT.test(path) && !path.endsWith('.d.ts')

interface Decl {
  key: string
  kind: 'method' | 'model'
  name: string
  owner: string
  /** First and last line, 1-based; a leading comment counts as the declaration's. */
  start: number
  end: number
  signature: string
  visibility: 'public' | 'private'
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200)
const has = (n: ts.Node, kind: ts.SyntaxKind) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === kind))
const fileOwner = (path: string) => (path.split('/').at(-1) ?? path).replace(/\.[^.]+$/, '')

/** `name<T>(a: A, b): R`, with async, static, get or set before it as the code has them. */
function callSignature(sf: ts.SourceFile, name: string, fn: ts.SignatureDeclarationBase, prefix: string[] = []): string {
  const types = fn.typeParameters?.length ? `<${fn.typeParameters.map((p) => p.getText(sf)).join(', ')}>` : ''
  const params = fn.parameters.map((p) => p.getText(sf)).join(', ')
  return oneLine(`${prefix.join(' ')} ${name}${types}(${params})${fn.type ? `: ${fn.type.getText(sf)}` : ''}`)
}

/** A type's header: its text up to its body (`interface Foo<T> extends Bar`). */
const header = (sf: ts.SourceFile, n: ts.Node, bodyAt: number) => oneLine(sf.text.slice(n.getStart(sf), bodyAt).replace(/\{\s*$/, '').replace(/^export\s+(default\s+)?(declare\s+)?/, ''))

/** The declarations of a source file a draft unit may be: top-level functions and types, and the members of classes. */
function declarations(path: string, text: string): Decl[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  // From its leading comment on: a changed doc comment is a change of what it documents.
  const startOf = (n: ts.Node) => {
    const full = n.getFullStart()
    const lead = sf.text.slice(full, n.getStart(sf)).search(/\S/)
    return lineOf(lead < 0 ? n.getStart(sf) : full + lead)
  }
  const out: Decl[] = []
  const add = (n: ts.Node, kind: Decl['kind'], name: string, owner: string, signature: string, visibility: Decl['visibility'], ownerKey = '') =>
    out.push({ key: `${kind}:${ownerKey}:${name}`, kind, name, owner, start: startOf(n), end: lineOf(n.end), signature, visibility })
  const top = fileOwner(path)
  for (const st of sf.statements) {
    const visibility = has(st, ts.SyntaxKind.ExportKeyword) ? 'public' : 'private'
    const async = has(st, ts.SyntaxKind.AsyncKeyword) ? ['async'] : []
    if (ts.isFunctionDeclaration(st) && st.name) add(st, 'method', st.name.text, top, callSignature(sf, st.name.text, st, async), visibility)
    else if (ts.isVariableStatement(st)) {
      const decls = st.declarationList.declarations
      for (const d of decls) {
        const init = d.initializer
        if (!ts.isIdentifier(d.name) || !init || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue
        const prefix = has(init, ts.SyntaxKind.AsyncKeyword) ? ['async'] : []
        add(decls.length === 1 ? st : d, 'method', d.name.text, top, callSignature(sf, d.name.text, init, prefix), visibility)
      }
    } else if (ts.isInterfaceDeclaration(st)) add(st, 'model', st.name.text, top, header(sf, st, st.members.pos), visibility)
    else if (ts.isTypeAliasDeclaration(st)) add(st, 'model', st.name.text, top, oneLine(st.getText(sf).replace(/^export\s+(declare\s+)?/, '')), visibility)
    else if (ts.isEnumDeclaration(st)) add(st, 'model', st.name.text, top, header(sf, st, st.members.pos), visibility)
    else if (ts.isClassDeclaration(st) && st.name) {
      const cls = st.name.text
      add(st, 'model', cls, top, header(sf, st, st.members.pos), visibility)
      for (const m of st.members) {
        const priv = has(m, ts.SyntaxKind.PrivateKeyword) || has(m, ts.SyntaxKind.ProtectedKeyword) || (!!m.name && ts.isPrivateIdentifier(m.name))
        const mods = [ts.SyntaxKind.StaticKeyword, ts.SyntaxKind.AsyncKeyword].filter((k) => has(m, k)).map((k) => ts.tokenToString(k)!)
        const member = (name: string, fn: ts.SignatureDeclarationBase, prefix = mods) => add(m, 'method', `${cls}.${name}`, cls, callSignature(sf, name, fn, prefix), priv ? 'private' : 'public', cls)
        if (ts.isConstructorDeclaration(m)) member('constructor', m)
        else if (!m.name) continue
        else if (ts.isMethodDeclaration(m)) member(m.name.getText(sf), m)
        else if (ts.isGetAccessor(m)) member(m.name.getText(sf), m, [...mods, 'get'])
        else if (ts.isSetAccessor(m)) member(m.name.getText(sf), m, [...mods, 'set'])
        else if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) member(m.name.getText(sf), m.initializer)
      }
    }
  }
  return out
}

/** The innermost declaration over a line (a member before its class). */
function at(decls: Decl[], line: number): Decl | undefined {
  let best: Decl | undefined
  for (const d of decls) if (d.start <= line && line <= d.end && (!best || d.end - d.start < best.end - best.start)) best = d
  return best
}

/** A changed line that is a comment or blank: a block of only those changes no design. */
const COMMENT = /^[+-]\s*(\/\/|\/\*|\*|$)/

/** The blocks of a hunk (`<hunk id>.<k>`, as @mag/diff's hunkBlocks numbers them) with the old and new lines they change. */
function blocks(h: DraftFile['hunks'][number]): { id: string; old: number[]; new: number[]; lines: string[] }[] {
  const out: { id: string; old: number[]; new: number[]; lines: string[] }[] = []
  let oldLine = h.oldStart
  let newLine = h.newStart
  let cur: (typeof out)[number] | null = null
  for (const l of h.lines ?? []) {
    if (l[0] === '+' || l[0] === '-') {
      if (!cur) out.push((cur = { id: `${h.id}.${out.length + 1}`, old: [], new: [], lines: [] }))
      cur.lines.push(l)
      if (l[0] === '-') cur.old.push(oldLine++)
      else cur.new.push(newLine++)
    } else {
      cur = null
      oldLine++
      newLine++
    }
  }
  return out
}

function parse(path: string, text: string | null): Decl[] {
  if (text == null) return []
  try {
    return declarations(path, text)
  } catch {
    return []
  }
}

/**
 * The draft of an inventory over changed TS/JS files: per file, every declaration (declarations) a block of changed
 * lines touches, at base by its removed lines and at head by its added ones, becomes a unit: add when only head has
 * it, del when only base, else mod; with its signatures at base and head and the ids of its blocks, numbered from d1.
 * Blocks that change only comments and blank lines are noise and no unit's. Files of no module, or not TS/JS, are left
 * to the reviewer.
 */
export function changedUnits(files: DraftFile[]): InventoryDraft {
  const units: InventoryUnit[] = []
  const noise: string[] = []
  for (const f of files) {
    if (!f.module || !draftable(f.path)) continue
    const before = parse(f.path, f.before)
    const after = parse(f.path, f.after)
    const touched = new Map<string, { before?: Decl; after?: Decl; hunks: string[] }>()
    const touch = (d: Decl | undefined, side: 'before' | 'after', block: string) => {
      if (!d) return
      const t = touched.get(d.key) ?? { hunks: [] }
      t[side] ??= d
      if (!t.hunks.includes(block)) t.hunks.push(block)
      touched.set(d.key, t)
    }
    for (const h of f.hunks) {
      if (!h.id) continue
      for (const b of blocks(h)) {
        if (b.lines.every((l) => COMMENT.test(l))) {
          noise.push(b.id)
          continue
        }
        for (const n of b.old) touch(at(before, n), 'before', b.id)
        for (const n of b.new) touch(at(after, n), 'after', b.id)
      }
    }
    // A declaration touched on one side only may still be on the other: then it changes, not comes or goes.
    const byKey = (decls: Decl[], key: string) => decls.find((d) => d.key === key)
    for (const [key, t] of touched) {
      const b = t.before ?? byKey(before, key)
      const a = t.after ?? byKey(after, key)
      const d = (a ?? b)!
      units.push({
        id: `d${units.length + 1}`,
        kind: d.kind,
        module: f.module,
        owner: d.owner,
        name: d.name,
        change: a && b ? 'mod' : a ? 'add' : 'del',
        visibility: d.visibility,
        ...(b && { before: b.signature }),
        ...(a && { after: a.signature }),
        hunks: t.hunks,
      })
    }
  }
  return { units, noise: noise.length ? [{ hunks: noise, reason: 'comments and blank lines only' }] : [] }
}
