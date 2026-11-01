// Prisma adapter (T-57.6): models, views, composite types and enums are entities with their fields; datasources and
// generators are infrastructure.
import { clip, closing, collector, hash, lineOf, mask, oneLine, type Syntax } from './scan.ts'
import type { LangAdapter, ParsedElement } from './types.ts'

const SYNTAX: Syntax = { line: ['//'], block: true, quotes: ['"'], backslash: true }
const BLOCK = /(?:^|\n)[ \t]*(model|view|type|enum|datasource|generator)[ \t]+(\w+)[ \t]*\{/g

export function prismaElements(_path: string, src: string): ParsedElement[] {
  const masked = mask(src, SYNTAX)
  const clean = mask(src, SYNTAX, true)
  const line = lineOf(src)
  const { add, list } = collector()
  BLOCK.lastIndex = 0
  for (let m; (m = BLOCK.exec(masked)); ) {
    const [decl, name] = [m[1], m[2]]
    const open = m.index + m[0].length - 1
    const close = closing(masked, open)
    BLOCK.lastIndex = close
    const start = m.index + m[0].indexOf(decl)
    const lines: [number, number][] = [[line(start), line(close - 1)]]
    if (decl === 'datasource' || decl === 'generator') {
      const provider = /\bprovider\s*=\s*([^\n]+)/.exec(clean.slice(open, close))
      add({ name, kind: 'infra', decl, exported: true, signature: `${decl} ${name}${provider ? ` (${oneLine(provider[1])})` : ''}`, bodyHash: hash(clean.slice(open, close)), lines })
      continue
    }
    // The block itself is its header: its fields change on their own.
    add({ name, kind: 'entity', decl, exported: true, signature: `${decl} ${name}`, bodyHash: hash(`${decl} ${name}`), lines })
    let offset = open + 1
    for (const raw of masked.slice(open + 1, close - 1).split('\n')) {
      const at = offset
      offset += raw.length + 1
      const text = raw.trim()
      if (!text) continue
      const def = oneLine(clean.slice(at, at + raw.length))
      const field = decl === 'enum' ? /^(\w+)/.exec(text)?.[1] : text.startsWith('@@') ? def.replace(/\s/g, '') : /^(\w+)\s/.exec(`${text} `)?.[1]
      if (!field) continue
      add({ name: `${name}.${field}`, kind: 'field', decl: decl === 'enum' ? 'value' : text.startsWith('@@') ? 'attribute' : 'field', exported: true, signature: clip(def), bodyHash: hash(def), lines: [[line(at), line(at)]] })
    }
  }
  return list()
}

export const prisma: LangAdapter = {
  lang: 'prisma',
  matches: (path) => path.endsWith('.prisma'),
  elements: prismaElements,
  imports: () => [],
}
