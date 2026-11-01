// SQL adapter (T-57.6): what a schema file or a migration declares, statement by statement. Tables, views and types
// are entities; columns, indexes and constraints are their fields, so a new column is one change and not a changed
// table. A migration's ALTER is a field change of its own (`users.email`, decl `add column`): migrations are read one
// file at a time, not replayed into a schema.
import { clip, closing, collector, hash, lineOf, mask, oneLine, split, type Syntax } from './scan.ts'
import type { LangAdapter, ParsedElement } from './types.ts'

const SYNTAX: Syntax = { line: ['--'], block: true, quotes: ["'", '"', '`'], sql: true }

const ID = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)`
const QID = String.raw`${ID}(?:\s*\.\s*${ID})*`
const re = (s: string) => new RegExp(s.replaceAll('QID', `(${QID})`).replaceAll('ID', `(${ID})`), 'i')

/** Unquoted, lower case where it was not quoted (SQL folds those), without the default schema. */
const ident = (s: string) =>
  [...s.matchAll(new RegExp(ID, 'g'))]
    .map(([p]) => (/^["`[]/.test(p) ? p.slice(1, -1) : p.toLowerCase()))
    .join('.')
    .replace(/^(public|dbo)\./, '')

const CREATE_TABLE = re(String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?QID`)
const CREATE_INDEX = re(String.raw`^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:QID\s+)?on\s+(?:only\s+)?QID`)
const CREATE_VIEW = re(String.raw`^create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?QID`)
const CREATE_ENTITY = re(String.raw`^create\s+(type|domain|sequence|schema)\s+(?:if\s+not\s+exists\s+)?QID`)
const CREATE_EXTENSION = re(String.raw`^create\s+extension\s+(?:if\s+not\s+exists\s+)?QID`)
const CREATE_FUNCTION = re(String.raw`^create\s+(?:or\s+replace\s+)?(function|procedure)\s+QID\s*\(`)
const CREATE_TRIGGER = re(String.raw`^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+ID\s[^]*?\bon\s+QID`)
const ALTER_TABLE = re(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?QID\s+`)
const DROP = re(String.raw`^drop\s+(table|view|materialized\s+view|type|domain|sequence|schema|index|function|procedure|trigger|extension)\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(${QID}(?:\s*,\s*${QID})*)`)
const CONSTRAINT = /^(constraint|primary|foreign|unique|check|index|key|exclude|fulltext|spatial|like)\b/i
const TRANSACTION = /^(begin|commit|end|rollback|start\s+transaction)(\s+(work|transaction))?$/i

const DROPPED: Record<string, ParsedElement['kind']> = { index: 'field', function: 'symbol', procedure: 'symbol', trigger: 'symbol', extension: 'infra' }

export function sqlElements(_path: string, src: string): ParsedElement[] {
  const masked = mask(src, SYNTAX)
  const clean = mask(src, SYNTAX, true)
  const line = lineOf(src)
  const { add, list } = collector()
  const at = (start: number, end: number): [number, number] => [line(start), line(Math.max(start, end - 1))]
  const el = (name: string, kind: ParsedElement['kind'], decl: string, signature: string, body: string, start: number, end: number, exported = true) =>
    add({ name, kind, decl, exported, signature: clip(oneLine(signature)), bodyHash: hash(body), lines: [at(start, end)] })
  const other: [number, number][] = []
  let otherText = ''

  for (const { start, end } of split(masked, 0, masked.length, ';')) {
    const text = clean.slice(start, end)
    const m = (r: RegExp) => r.exec(text)
    let x: RegExpExecArray | null
    if ((x = m(CREATE_TABLE))) {
      const table = ident(x[1])
      const open = masked.indexOf('(', start + x[0].length)
      const isDefs = open >= 0 && open < end && !masked.slice(start + x[0].length, open).trim()
      const close = isDefs ? closing(masked, open) : start + x[0].length
      const tail = oneLine(clean.slice(close, end))
      el(table, 'entity', 'table', `table ${table}${tail ? ` ${tail}` : ''}`, `table ${table} ${tail}`, start, end)
      if (!isDefs) continue
      for (const d of split(masked, open + 1, close - 1, ',')) {
        const def = oneLine(clean.slice(d.start, d.end))
        if (CONSTRAINT.test(def)) {
          const named = /^constraint\s+(\S+)/i.exec(def)
          const name = named ? ident(named[1]) : oneLine(def.replace(/\s*\(/, '(')).toLowerCase()
          el(`${table}.${name}`, 'field', 'constraint', def, def, d.start, d.end)
        } else {
          el(`${table}.${ident(new RegExp(`^${ID}`).exec(def)![0])}`, 'field', 'column', def, def, d.start, d.end)
        }
      }
    } else if ((x = m(CREATE_INDEX))) {
      const table = ident(x[2])
      const name = x[1] ? ident(x[1]).split('.').at(-1)! : `index${oneLine(text.slice(x[0].length)).replace(/^using\s+\w+\s*/i, '')}`
      el(`${table}.${name}`, 'field', 'index', text.replace(/^create\s+/i, ''), text, start, end)
    } else if ((x = m(CREATE_VIEW))) {
      el(ident(x[1]), 'entity', 'view', `view ${ident(x[1])}`, text, start, end)
    } else if ((x = m(CREATE_ENTITY))) {
      const decl = x[1].toLowerCase()
      el(ident(x[2]), 'entity', decl, decl === 'type' || decl === 'domain' ? text.replace(/^create\s+/i, '') : `${decl} ${ident(x[2])}`, text, start, end)
    } else if ((x = m(CREATE_EXTENSION))) {
      el(ident(x[1]), 'infra', 'extension', `extension ${ident(x[1])}`, text, start, end)
    } else if ((x = m(CREATE_FUNCTION))) {
      const open = start + x[0].length - 1
      const close = closing(masked, open)
      const returns = /^\s*returns\s+([^]+?)(?=\s+(?:as|language|begin|immutable|stable|volatile|strict|security|set|cost|parallel|return)\b|\s*\$|$)/i.exec(clean.slice(close, end))
      el(ident(x[2]), 'symbol', x[1].toLowerCase(), `${ident(x[2])}${oneLine(clean.slice(open, close))}${returns ? `: ${oneLine(returns[1])}` : ''}`, text, start, end)
    } else if ((x = m(CREATE_TRIGGER))) {
      el(`${ident(x[2])}.${ident(x[1])}`, 'symbol', 'trigger', text.replace(/^create\s+(or\s+replace\s+)?/i, '').replace(/\s+execute\s[^]*$/i, ''), text, start, end)
    } else if ((x = m(ALTER_TABLE))) {
      const table = ident(x[1])
      for (const a of split(masked, start + x[0].length, end, ',')) {
        const action = oneLine(clean.slice(a.start, a.end))
        const [name, kind, decl] = alterTarget(table, action)
        el(name, kind, decl, action, action, a.start, a.end)
      }
    } else if ((x = m(DROP))) {
      const what = x[1].toLowerCase().replace(/\s+/g, ' ')
      for (const n of x[2].split(',')) el(ident(n), DROPPED[what] ?? 'entity', `drop ${what}`, `drop ${what} ${ident(n)}`, text, start, end)
    } else if (!TRANSACTION.test(oneLine(text))) {
      // Data, grants, comments: they declare nothing, so one element holds them all.
      other.push(at(start, end))
      otherText += `${text}\n`
    }
  }
  if (other.length) add({ name: '(top-level)', kind: 'symbol', decl: 'statements', exported: false, signature: '(top-level)', bodyHash: hash(otherText), lines: other })
  return list()
}

/** What one ALTER TABLE action changes: name, kind, decl. */
function alterTarget(table: string, action: string): [string, ParsedElement['kind'], string] {
  let x: RegExpExecArray | null
  if ((x = re(String.raw`^add\s+constraint\s+ID`).exec(action))) return [`${table}.${ident(x[1])}`, 'field', 'add constraint']
  if (/^add\s+/i.test(action) && CONSTRAINT.test(action.slice(4))) return [`${table}.${action.slice(4).replace(/\s*\(/, '(').toLowerCase()}`, 'field', 'add constraint']
  if ((x = re(String.raw`^drop\s+constraint\s+(?:if\s+exists\s+)?ID`).exec(action))) return [`${table}.${ident(x[1])}`, 'field', 'drop constraint']
  if ((x = re(String.raw`^rename\s+constraint\s+ID`).exec(action))) return [`${table}.${ident(x[1])}`, 'field', 'rename constraint']
  if ((x = re(String.raw`^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?ID`).exec(action))) return [`${table}.${ident(x[1])}`, 'field', 'add column']
  if ((x = re(String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?ID`).exec(action))) return [`${table}.${ident(x[1])}`, 'field', 'drop column']
  if ((x = re(String.raw`^rename\s+to\s+QID`).exec(action))) return [table, 'entity', 'rename table']
  if ((x = re(String.raw`^rename\s+(?:column\s+)?ID\s+to\s`).exec(action))) return [`${table}.${ident(x[1])}`, 'field', 'rename column']
  if ((x = re(String.raw`^(?:alter|modify|change)\s+(?:column\s+)?ID`).exec(action))) return [`${table}.${ident(x[1])}`, 'field', 'alter column']
  return [table, 'entity', 'alter table']
}

export const sql: LangAdapter = {
  lang: 'sql',
  matches: (path) => /\.sql$/i.test(path),
  elements: sqlElements,
  imports: () => [],
}
