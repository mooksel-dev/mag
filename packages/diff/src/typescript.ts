// TypeScript / JavaScript adapter: top-level declarations with their members, contracts-as-data and imports.
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { importsOf } from '@mag/arch/parse'
import type { LangAdapter, ParsedElement } from './types.ts'

const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
const hash = (s: string) => createHash('sha1').update(oneLine(s)).digest('hex').slice(0, 16)

const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === kind))
const isExported = (n: ts.Node) => hasModifier(n, ts.SyntaxKind.ExportKeyword)

/** `as const`, `satisfies T` and parentheses around a value. */
function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
  return e
}

const propName = (p: ts.ObjectLiteralElementLike, sf: ts.SourceFile) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : p.name?.getText(sf))

function prop(o: ts.ObjectLiteralExpression, name: string, sf: ts.SourceFile): ts.Expression | undefined {
  const p = o.properties.find((x) => propName(x, sf) === name)
  return p && ts.isPropertyAssignment(p) ? unwrap(p.initializer) : undefined
}

/** `name` of a contract item: an object literal whose `name` is a string. */
function contractName(e: ts.Expression, sf: ts.SourceFile): string | null {
  const o = unwrap(e)
  if (!ts.isObjectLiteralExpression(o)) return null
  const n = prop(o, 'name', sf)
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null
}

/** `name(a, b?)` from the item's JSON schema (inputSchema / parameters / input_schema), else its name. */
function contractSignature(name: string, o: ts.ObjectLiteralExpression, sf: ts.SourceFile): string {
  const schema = ['inputSchema', 'input_schema', 'parameters', 'schema'].map((k) => prop(o, k, sf)).find((x) => x && ts.isObjectLiteralExpression(x))
  if (!schema || !ts.isObjectLiteralExpression(schema)) return name
  const props = prop(schema, 'properties', sf)
  const req = prop(schema, 'required', sf)
  const required = new Set(req && ts.isArrayLiteralExpression(req) ? req.elements.filter(ts.isStringLiteral).map((s) => s.text) : [])
  const keys = props && ts.isObjectLiteralExpression(props) ? props.properties.map((p) => propName(p, sf) ?? '?') : []
  return `${name}(${keys.map((k) => (required.has(k) ? k : `${k}?`)).join(', ')})`
}

export function tsElements(path: string, src: string): ParsedElement[] {
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : undefined)
  const out = new Map<string, ParsedElement>()
  const lines = (n: ts.Node): [number, number] => [sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, sf.getLineAndCharacterOfPosition(n.end).line + 1]
  const text = (from: ts.Node, to?: ts.Node) => sf.text.slice(from.getStart(sf), to ? to.getStart(sf) : from.end)
  const head = (n: ts.Node, body?: ts.Node) => clip(oneLine(text(n, body).replace(/^export\s+(default\s+)?(declare\s+)?/, '')).replace(/\s*(=>|=|\{)\s*$/, ''))
  /** Overloads and merged declarations add up under one name. */
  const add = (e: ParsedElement) => {
    const prev = out.get(e.name)
    if (!prev) return void out.set(e.name, e)
    out.set(e.name, { ...prev, exported: prev.exported || e.exported, signature: clip(`${prev.signature}; ${e.signature}`), bodyHash: hash(prev.bodyHash + e.bodyHash), lines: [...prev.lines, ...e.lines] })
  }
  const el = (name: string, decl: string, exported: boolean, signature: string, body: string, at: ts.Node, kind: ParsedElement['kind'] = 'symbol') =>
    add({ name, kind, decl, exported, signature, bodyHash: hash(body), lines: [lines(at)] })

  const members = (owner: string, exported: boolean, list: readonly (ts.ClassElement | ts.TypeElement)[]) => {
    for (const m of list) {
      if (!m.name || ts.isPrivateIdentifier(m.name)) continue
      if (hasModifier(m, ts.SyntaxKind.PrivateKeyword)) continue
      const name = m.name.getText(sf)
      const body = 'body' in m ? (m.body as ts.Node | undefined) : undefined
      const decl = ts.isMethodDeclaration(m) || ts.isMethodSignature(m) ? 'method' : ts.isGetAccessor(m) || ts.isSetAccessor(m) ? 'accessor' : 'property'
      el(`${owner}.${name}`, decl, exported && !hasModifier(m, ts.SyntaxKind.ProtectedKeyword), head(m, body), text(m), m)
    }
    // Constructors have no name: their parameters are the class's signature too.
    for (const m of list) if (ts.isConstructorDeclaration(m)) el(`${owner}.constructor`, 'constructor', exported, head(m, m.body), text(m), m)
  }

  const topLevel: ts.Statement[] = []
  for (const st of sf.statements) {
    const exported = isExported(st)
    if (ts.isFunctionDeclaration(st)) {
      const name = st.name?.text ?? 'default'
      el(name, 'function', exported, head(st, st.body), text(st), st)
    } else if (ts.isClassDeclaration(st)) {
      const name = st.name?.text ?? 'default'
      const open = st.members.length ? st.members[0] : undefined
      const header = head(st, open).replace(/\s*\{[^]*$/, '')
      el(name, 'class', exported, header, header, st)
      members(name, exported, st.members)
    } else if (ts.isInterfaceDeclaration(st)) {
      const name = st.name.text
      const header = clip(oneLine(sf.text.slice(st.getStart(sf), st.members.pos)).replace(/^export\s+/, '').replace(/\s*\{\s*$/, ''))
      el(name, 'interface', exported, header, header, st)
      members(name, exported, st.members)
    } else if (ts.isTypeAliasDeclaration(st)) {
      el(st.name.text, 'type', exported, head(st), text(st), st)
    } else if (ts.isEnumDeclaration(st)) {
      el(st.name.text, 'enum', exported, clip(oneLine(text(st)).replace(/^export\s+/, '')), text(st), st)
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          topLevel.push(st)
          continue
        }
        const name = d.name.text
        const init = d.initializer && unwrap(d.initializer)
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          el(name, 'function', exported, clip(oneLine(`${name}${sf.text.slice(init.getStart(sf), init.body.getStart(sf))}`).replace(/\s*=>\s*$/, '')), text(d), d)
          continue
        }
        const items = init && ts.isArrayLiteralExpression(init) && init.elements.length ? init.elements.map((e) => contractName(e, sf)) : []
        if (items.length && items.every(Boolean)) {
          // Contracts-as-data (T-56 F1): an array of described items, e.g. tool definitions.
          el(name, 'const', exported, head(d, init), head(d, init), d)
          ;(init as ts.ArrayLiteralExpression).elements.forEach((e, i) => {
            const o = unwrap(e) as ts.ObjectLiteralExpression
            el(`${name}[${items[i]}]`, 'contract', exported, contractSignature(items[i]!, o, sf), text(e), e, 'contract')
          })
          continue
        }
        el(name, 'const', exported, d.type ? clip(oneLine(`${name}: ${d.type.getText(sf)}`)) : name, text(d), d)
      }
    } else if (ts.isExportAssignment(st)) {
      el('default', 'default', true, 'default', text(st), st)
    } else if (!ts.isImportDeclaration(st) && !ts.isExportDeclaration(st) && !ts.isImportEqualsDeclaration(st) && !ts.isEmptyStatement(st)) {
      topLevel.push(st)
    }
  }
  // Statements that declare nothing (wiring in an entry file) are one element, so their hunks have a symbol.
  if (topLevel.length)
    add({ name: '(top-level)', kind: 'symbol', decl: 'statements', exported: false, signature: '(top-level)', bodyHash: hash(topLevel.map((s) => text(s)).join('\n')), lines: topLevel.map(lines) })
  return [...out.values()]
}

export const typescript: LangAdapter = {
  lang: 'typescript',
  matches: (path) => EXT.test(path) && !path.endsWith('.d.ts'),
  elements: tsElements,
  imports: (path, src) => importsOf(ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true)),
}
