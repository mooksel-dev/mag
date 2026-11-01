// GraphQL SDL adapter (T-57.6): types, inputs, interfaces, enums, unions and scalars with their fields, all contracts.
// The fields of Query, Mutation and Subscription are the API's operations.
import { clip, closing, collector, hash, lineOf, mask, oneLine, type Syntax } from './scan.ts'
import type { LangAdapter, ParsedElement } from './types.ts'

const SYNTAX: Syntax = { line: ['#'], quotes: ['"'], backslash: true, triple: true }
const DEF = /(?:^|\n)[ \t]*(?:extend[ \t]+)?(type|interface|input|enum|union|scalar|schema|directive)\b/g
const ROOT = new Set(['Query', 'Mutation', 'Subscription'])

export function graphqlElements(_path: string, src: string): ParsedElement[] {
  const masked = mask(src, SYNTAX)
  const clean = mask(src, SYNTAX, true)
  const line = lineOf(src)
  const { add, list } = collector()
  const el = (name: string, decl: string, signature: string, body: string, start: number, end: number) =>
    add({ name, kind: 'contract', decl, exported: true, signature: clip(oneLine(signature)), bodyHash: hash(body), lines: [[line(start), line(Math.max(start, end - 1))]] })

  const defs: { start: number; decl: string }[] = []
  DEF.lastIndex = 0
  for (let m; (m = DEF.exec(masked)); ) {
    const start = m.index + (m[0].length - m[0].trimStart().length)
    const open = masked.slice(start, nextDef(masked, DEF.lastIndex)).indexOf('{')
    defs.push({ start, decl: m[1] })
    // Skip the body: its fields may be called `type` or `input`.
    if (open >= 0) DEF.lastIndex = closing(masked, start + open)
  }
  defs.forEach(({ start, decl }, k) => {
    const limit = k + 1 < defs.length ? defs[k + 1].start : masked.length
    const brace = masked.slice(start, limit).indexOf('{')
    const end = brace >= 0 ? closing(masked, start + brace) : start + masked.slice(start, limit).trimEnd().length
    const head = oneLine(clean.slice(start, brace >= 0 ? start + brace : end))
    const name = decl === 'schema' ? 'schema' : (/^(?:extend\s+)?\w+\s+@?(\w+)/.exec(head)?.[1] ?? decl)
    // A block is its header (a union or scalar has no other): its fields change on their own.
    el(name, decl, head.replace(/^extend\s+/, ''), head, start, end)
    if (brace < 0) return
    const fieldDecl = decl === 'enum' ? 'value' : ROOT.has(name) ? name.toLowerCase() : 'field'
    // A field starts a line with its name; the lines after it that do not are its arguments or directives.
    const open = start + brace + 1
    const fields: { start: number; end: number; name: string }[] = []
    let depth = 0
    let offset = open
    // Descriptions are blank in masked text but for their quotes.
    for (const raw of masked.slice(open, end - 1).replace(/"/g, ' ').split('\n')) {
      const at = offset
      offset += raw.length + 1
      const m = /^\s*(\w+)\s*(?=[(:]|$|\s+@|\s*$)/.exec(raw)
      if (depth === 0 && m && raw.trim()) fields.push({ start: at + raw.indexOf(m[1]), end: at + raw.length, name: m[1] })
      else if (fields.length && raw.trim()) fields.at(-1)!.end = at + raw.length
      for (const c of raw) depth += c === '(' ? 1 : c === ')' ? -1 : 0
    }
    for (const f of fields) {
      const text = oneLine(clean.slice(f.start, f.end))
      el(`${name}.${f.name}`, fieldDecl, text, text, f.start, f.end)
    }
  })
  return list()
}

function nextDef(masked: string, from: number): number {
  const re = new RegExp(DEF.source, 'g')
  re.lastIndex = from
  return re.exec(masked)?.index ?? masked.length
}

export const graphql: LangAdapter = {
  lang: 'graphql',
  matches: (path) => /\.(graphql|graphqls|gql)$/i.test(path),
  elements: graphqlElements,
  imports: () => [],
}
