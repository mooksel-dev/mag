// Terraform adapter (T-57.6): resources, data sources, modules, providers and the `terraform` block are
// infrastructure; variables and outputs are the module's contract. A module's `source` is a dependency: a folder of
// the repo or an outside module.
import { dirname, join, normalize } from 'node:path/posix'
import { clip, closing, collector, hash, lineOf, mask, oneLine, type Syntax } from './scan.ts'
import type { LangAdapter, ParsedElement } from './types.ts'

const SYNTAX: Syntax = { line: ['#', '//'], block: true, quotes: ['"'], backslash: true, hcl: true }
const BLOCK = /(?:^|\n)[ \t]*([A-Za-z_][\w-]*)((?:[ \t]+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*)[ \t]*\{/g

interface Block {
  type: string
  labels: string[]
  start: number
  open: number
  end: number
}

function blocks(src: string): { masked: string; clean: string; list: Block[] } {
  const masked = mask(src, SYNTAX)
  // Labels are strings: read them from text with comments blanked and strings kept.
  const clean = mask(src, SYNTAX, true)
  const list: Block[] = []
  BLOCK.lastIndex = 0
  for (let m; (m = BLOCK.exec(masked)); ) {
    const start = m.index + m[0].indexOf(m[1])
    const open = m.index + m[0].length - 1
    const end = closing(masked, open)
    const labels = [...clean.slice(start + m[1].length, open).matchAll(/"([^"\n]*)"|([A-Za-z_][\w-]*)/g)].map((l) => l[1] ?? l[2])
    list.push({ type: m[1], labels, start, open, end })
    BLOCK.lastIndex = end
  }
  return { masked, clean, list }
}

/** A top-level attribute of a block body: `key = value` at depth 0, value as one line. */
function attr(masked: string, clean: string, b: Block, key: string): string | undefined {
  let depth = 0
  let offset = b.open + 1
  for (const raw of masked.slice(b.open + 1, b.end - 1).split('\n')) {
    const at = offset
    offset += raw.length + 1
    if (depth === 0 && new RegExp(`^\\s*${key}\\s*=`).test(raw)) {
      const text = clean.slice(at, at + raw.length)
      return oneLine(text.slice(text.indexOf('=') + 1))
    }
    for (const c of raw) depth += c === '{' || c === '[' || c === '(' ? 1 : c === '}' || c === ']' || c === ')' ? -1 : 0
  }
}

const unquote = (s?: string) => s?.replace(/^"([^]*)"$/, '$1')

export function terraformElements(_path: string, src: string): ParsedElement[] {
  const { masked, clean, list } = blocks(src)
  const line = lineOf(src)
  const { add, list: out } = collector()
  const other: [number, number][] = []
  let otherText = ''
  for (const b of list) {
    const body = clean.slice(b.open, b.end)
    const lines: [number, number][] = [[line(b.start), line(b.end - 1)]]
    const el = (name: string, kind: ParsedElement['kind'], signature: string, exported = true) =>
      add({ name, kind, decl: b.type, exported, signature: clip(oneLine(signature)), bodyHash: hash(body), lines })
    const [a, c] = b.labels
    if ((b.type === 'resource' || b.type === 'ephemeral') && c) el(`${a}.${c}`, 'infra', `${b.type} "${a}" "${c}"`)
    else if (b.type === 'data' && c) el(`data.${a}.${c}`, 'infra', `data "${a}" "${c}"`)
    else if (b.type === 'module' && a) el(`module.${a}`, 'infra', `module "${a}" (${unquote(attr(masked, clean, b, 'source')) ?? '?'})`)
    else if (b.type === 'provider' && a) {
      const alias = unquote(attr(masked, clean, b, 'alias'))
      el(`provider.${a}${alias ? `.${alias}` : ''}`, 'infra', `provider "${a}"${alias ? ` (${alias})` : ''}`)
    } else if (b.type === 'terraform') el('terraform', 'infra', 'terraform')
    else if (b.type === 'variable' && a) {
      const type = attr(masked, clean, b, 'type')
      const optional = attr(masked, clean, b, 'default') !== undefined
      el(`var.${a}`, 'contract', `var.${a}${optional ? '?' : ''}${type ? `: ${type}` : ''}`)
    } else if (b.type === 'output' && a) el(`output.${a}`, 'contract', `output.${a}${attr(masked, clean, b, 'sensitive') === 'true' ? ' (sensitive)' : ''}`)
    else {
      // locals, moved, import, check…: wiring, one element for them all.
      other.push(lines[0])
      otherText += `${body}\n`
    }
  }
  if (other.length) add({ name: '(top-level)', kind: 'symbol', decl: 'blocks', exported: false, signature: '(top-level)', bodyHash: hash(otherText), lines: other })
  return out()
}

function terraformImports(_path: string, src: string) {
  const { masked, clean, list } = blocks(src)
  const line = lineOf(src)
  return list.filter((b) => b.type === 'module').flatMap((b) => {
    const source = unquote(attr(masked, clean, b, 'source'))
    return source ? [{ spec: source, line: line(b.start) }] : []
  })
}

/** A local source is the folder of the module; any other (registry, git, URL) an outside one, by its address. */
function resolveTerraform(from: string, spec: string, files: Set<string>): string | null {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const dir = normalize(join(dirname(from), spec)).replace(/\/$/, '')
    return [...files].some((f) => f.startsWith(`${dir}/`)) ? dir : null
  }
  const address = spec
    .replace(/^[a-z0-9]+::/i, '')
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/\?.*$/, '')
    .replace(/\/\/.*$/, '')
    .replace(/\.git$/, '')
  return `ext:${address}`
}

export const terraform: LangAdapter = {
  lang: 'terraform',
  matches: (path) => path.endsWith('.tf'),
  elements: terraformElements,
  imports: terraformImports,
  resolve: resolveTerraform,
}
