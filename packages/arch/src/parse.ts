import ts from 'typescript'
import type { ExportedApi } from './types.ts'

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200)
const isExported = (n: ts.Node) =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

function signature(sf: ts.SourceFile, node: ts.Node, body?: ts.Node) {
  return oneLine(sf.text.slice(node.getStart(sf), body ? body.getStart(sf) : node.end).replace(/^export\s+(default\s+)?/, ''))
}

export function collectExports(sf: ts.SourceFile): ExportedApi[] {
  const out: ExportedApi[] = []
  for (const st of sf.statements) {
    if (!isExported(st)) continue
    if (ts.isInterfaceDeclaration(st)) {
      out.push({ name: st.name.text, kind: 'interface', members: st.members.map((m) => oneLine(m.getText(sf))) })
    } else if (ts.isClassDeclaration(st) && st.name) {
      const members = st.members
        .filter((m) => !ts.getModifiers(m as ts.HasModifiers)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword))
        .filter((m) => !(m.name && ts.isPrivateIdentifier(m.name)))
        .filter((m) => ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessor(m))
        .map((m) => signature(sf, m, (m as ts.MethodDeclaration).body))
      out.push({ name: st.name.text, kind: 'class', members })
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      out.push({ name: st.name.text, kind: 'function', members: [signature(sf, st, st.body)] })
    } else if (ts.isTypeAliasDeclaration(st)) {
      out.push({ name: st.name.text, kind: 'type', members: [] })
    } else if (ts.isEnumDeclaration(st)) {
      out.push({ name: st.name.text, kind: 'enum', members: st.members.map((m) => m.name.getText(sf)) })
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const init = d.initializer
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null
        out.push({
          name: d.name.text,
          kind: fn ? 'function' : 'const',
          members: fn ? [oneLine(`${d.name.text}${sf.text.slice(fn.getStart(sf), fn.body.getStart(sf)).replace(/=>\s*$/, '')}`)] : [],
        })
      }
    }
  }
  return out
}

export function importsOf(sf: ts.SourceFile): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = []
  const add = (lit: ts.Expression | undefined, at: ts.Node) => {
    if (lit && ts.isStringLiteral(lit)) out.push({ spec: lit.text, line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1 })
  }
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier, n)
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')))
      add(n.arguments[0], n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

