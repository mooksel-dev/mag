// Shared by the schema adapters (T-57.6): comments and strings blanked out at the same offsets, so statements and
// braces are found by position in the masked text and read from the source.
import { createHash } from 'node:crypto'
import type { ParsedElement } from './types.ts'

export interface Syntax {
  /** Line comment openers: `//`, `#`, `--`. */
  line: string[]
  /** `/* … *\/` comments. */
  block?: boolean
  quotes: string[]
  /** `\` escapes inside quotes. */
  backslash?: boolean
  /** SQL: `''` inside `'…'`, and `$tag$ … $tag$` bodies. */
  sql?: boolean
  /** GraphQL: `"""` block strings. */
  triple?: boolean
  /** HCL: `${ … }` / `%{ … }` inside strings, and `<<EOF` heredocs. */
  hcl?: boolean
}

/** The source with comments (and, unless `keepStrings`, string contents) replaced by spaces; newlines stay. */
export function mask(src: string, s: Syntax, keepStrings = false): string {
  const out = src.split('')
  const n = src.length
  const blank = (from: number, to: number) => {
    for (let i = from; i < Math.min(to, n); i++) if (out[i] !== '\n') out[i] = ' '
  }
  const blankString = (from: number, to: number) => keepStrings || blank(from, to)

  /** From inside `${`: past its closing `}`. */
  const code = (i: number): number => {
    let depth = 1
    while (i < n) {
      const c = src[i]
      if (c === '"') i = string(i, '"')
      else if (c === '{') (depth++, i++)
      else if (c === '}') {
        if (--depth === 0) return i + 1
        i++
      } else i++
    }
    return n
  }
  /** From an opening quote: past the closing one. */
  const string = (i: number, q: string): number => {
    let j = i + q.length
    while (j < n) {
      if (s.backslash && src[j] === '\\') {
        j += 2
        continue
      }
      if (s.hcl && (src.startsWith('${', j) || src.startsWith('%{', j))) {
        j = code(j + 2)
        continue
      }
      if (src.startsWith(q, j)) {
        if (s.sql && q === "'" && src[j + 1] === "'") {
          j += 2
          continue
        }
        return j + q.length
      }
      j++
    }
    return n
  }

  let i = 0
  while (i < n) {
    const c = src[i]
    const line = s.line.find((l) => src.startsWith(l, i))
    if (line) {
      const end = src.indexOf('\n', i)
      blank(i, end < 0 ? n : end)
      i = end < 0 ? n : end
    } else if (s.block && src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      blank(i, end < 0 ? n : end + 2)
      i = end < 0 ? n : end + 2
    } else if (s.triple && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3)
      const to = end < 0 ? n : end + 3
      blankString(i + 3, to - 3)
      i = to
    } else if (s.sql && c === '$' && /^\$\w*\$/.test(src.slice(i, i + 64)) && !/[\w$]/.test(src[i - 1] ?? '')) {
      const tag = /^\$\w*\$/.exec(src.slice(i, i + 64))![0]
      const end = src.indexOf(tag, i + tag.length)
      const to = end < 0 ? n : end + tag.length
      blankString(i + tag.length, to - tag.length)
      i = to
    } else if (s.hcl && src.startsWith('<<', i) && /^<<-?([A-Za-z_]\w*)\r?\n/.test(src.slice(i, i + 64))) {
      const tag = /^<<-?([A-Za-z_]\w*)/.exec(src.slice(i, i + 64))![1]
      const re = new RegExp(`\\n[ \\t]*${tag}[ \\t]*(?=\\r?\\n|$)`, 'g')
      re.lastIndex = i
      const m = re.exec(src)
      const to = m ? m.index + m[0].length : n
      blankString(src.indexOf('\n', i) + 1, m ? m.index : n)
      i = to
    } else if (s.quotes.includes(c)) {
      const to = string(i, c)
      blankString(i + 1, to - 1)
      i = to
    } else i++
  }
  return out.join('')
}

/** The offset past the bracket matching the one at `open`, in masked text. */
export function closing(masked: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
  const o = masked[open]
  const c = pairs[o]
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === o) depth++
    else if (masked[i] === c && --depth === 0) return i + 1
  }
  return masked.length
}

/** Parts of `text` between `sep` at bracket depth 0, with their offsets. */
export function split(masked: string, from: number, to: number, sep: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let depth = 0
  let start = from
  for (let i = from; i < to; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === sep && depth === 0) (out.push({ start, end: i }), (start = i + 1))
  }
  out.push({ start, end: to })
  return out.map((p) => trimRange(masked, p.start, p.end)).filter((p) => p.end > p.start)
}

/** The range without the whitespace around it (in masked text, so comments count as whitespace). */
export function trimRange(masked: string, start: number, end: number) {
  while (start < end && /\s/.test(masked[start])) start++
  while (end > start && /\s/.test(masked[end - 1])) end--
  return { start, end }
}

/** 1-based line of an offset. */
export function lineOf(src: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
export const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)
export const hash = (s: string) => createHash('sha1').update(oneLine(s)).digest('hex').slice(0, 16)

/** Elements by name, in order: the same name twice in a file (an overload, a second ALTER) adds up into one. */
export function collector() {
  const out = new Map<string, ParsedElement>()
  const add = (e: ParsedElement) => {
    const prev = out.get(e.name)
    if (!prev) return void out.set(e.name, e)
    out.set(e.name, { ...prev, signature: prev.signature === e.signature ? prev.signature : clip(`${prev.signature}; ${e.signature}`), bodyHash: hash(prev.bodyHash + e.bodyHash), lines: [...prev.lines, ...e.lines] })
  }
  return { add, list: () => [...out.values()] }
}

/** Keys sorted, so a reformatted document hashes the same. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
