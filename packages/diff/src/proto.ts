// Protocol Buffers adapter (T-57.6): services and their rpcs, messages and enums with their fields, all contracts;
// `import "x.proto"` is a dependency on the file that defines it.
import { dirname, join, normalize } from 'node:path/posix'
import { clip, closing, collector, hash, lineOf, mask, oneLine, type Syntax } from './scan.ts'
import type { LangAdapter, ParsedElement } from './types.ts'

const SYNTAX: Syntax = { line: ['//'], block: true, quotes: ['"', "'"], backslash: true }

export function protoElements(_path: string, src: string): ParsedElement[] {
  const masked = mask(src, SYNTAX)
  const clean = mask(src, SYNTAX, true)
  const line = lineOf(src)
  const { add, list } = collector()
  const el = (name: string, decl: string, signature: string, body: string, start: number, end: number) =>
    add({ name, kind: 'contract', decl, exported: true, signature: clip(oneLine(signature)), bodyHash: hash(body), lines: [[line(start), line(Math.max(start, end - 1))]] })

  /** Statements and blocks of `[from, to)`, under `owner` (a message or service name; '' at the top). */
  const walk = (from: number, to: number, owner: string, oneof = '') => {
    let i = from
    while (i < to) {
      while (i < to && /[\s;]/.test(masked[i])) i++
      if (i >= to) break
      const semi = masked.indexOf(';', i)
      const brace = masked.indexOf('{', i)
      const isBlock = brace >= 0 && brace < to && (semi < 0 || brace < semi)
      const end = isBlock ? closing(masked, brace) : semi < 0 || semi > to ? to : semi + 1
      const head = oneLine(clean.slice(i, isBlock ? brace : end).replace(/;$/, ''))
      const [word, name] = head.split(/\s+/)
      const full = owner ? `${owner}.${name}` : name
      if (isBlock && (word === 'message' || word === 'enum' || word === 'service')) {
        // A block is its header: its members change on their own.
        el(full, word, head, head, i, end)
        walk(brace + 1, end - 1, full)
      } else if (isBlock && word === 'oneof') {
        walk(brace + 1, end - 1, owner, name)
      } else if (isBlock && word === 'extend') {
        walk(brace + 1, end - 1, name)
      } else if (word === 'rpc') {
        el(`${owner}.${/^rpc\s+(\w+)/.exec(head)?.[1] ?? name}`, 'rpc', head, clean.slice(i, end), i, end)
      } else if (word === 'package') {
        el('package', 'package', head, head, i, end)
      } else if (owner && word === 'reserved') {
        el(`${owner}.(reserved)`, 'reserved', head, head, i, end)
      } else if (owner && !isBlock && /(\w+)\s*=\s*-?\d+/.test(head) && !/^(option|syntax|edition)\b/.test(head)) {
        const field = /(\w+)\s*=\s*-?\d+/.exec(head)![1]
        const sig = oneof ? `oneof ${oneof}: ${head}` : head
        el(`${owner}.${field}`, /^\w+\s*=/.test(head) ? 'value' : 'field', sig, sig, i, end)
      }
      // syntax, option, import and the options of an rpc or a field are not elements.
      i = end
    }
  }
  walk(0, masked.length, '')
  return list()
}

function protoImports(_path: string, src: string) {
  const masked = mask(src, SYNTAX)
  const line = lineOf(src)
  return [...masked.matchAll(/\bimport\s+(?:public\s+|weak\s+)?["']/g)].map((m) => {
    const open = m.index + m[0].length - 1
    return { spec: src.slice(open + 1, src.indexOf(src[open], open + 1)), line: line(m.index) }
  })
}

/**
 * Proto imports are relative to an include root, not to the file: the file's folder or one above it, else the only
 * file of the repo with that path at its end. Well-known types and other repos are outside packages.
 */
function resolveProto(from: string, spec: string, files: Set<string>): string | null {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const p = normalize(join(dir, spec))
    if (files.has(p)) return p
    if (dir === '.' || dir === '/' || dir === '') break
  }
  const tail = [...files].filter((f) => f.endsWith(`/${spec}`))
  if (tail.length === 1) return tail[0]
  return `ext:${spec.split('/').slice(0, -1).slice(0, 2).join('/') || spec}`
}

export const proto: LangAdapter = {
  lang: 'proto',
  matches: (path) => path.endsWith('.proto'),
  elements: protoElements,
  imports: protoImports,
  resolve: resolveProto,
}
