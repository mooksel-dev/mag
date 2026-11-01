// YAML / JSON adapter (T-57.6): OpenAPI / Swagger specs and Kubernetes manifests. Other YAML and JSON (configs,
// package.json, CI) has no elements and is not code (`data`), so it needs no module.
import { dirname, join, normalize } from 'node:path/posix'
import { isMap, isScalar, isSeq, parseAllDocuments, type Node, type Pair, type YAMLMap } from 'yaml'
import { clip, collector, hash, lineOf, stable } from './scan.ts'
import type { LangAdapter, ParsedElement } from './types.ts'

const MAX = 2_000_000
/** Cheap look before parsing: a spec or a manifest says so at the top level. */
const LOOKS = /(^|\n)\s*"?(openapi|swagger|apiVersion)"?\s*:/
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

function parse(src: string) {
  if (src.length > MAX || !LOOKS.test(src)) return []
  return parseAllDocuments(src, { uniqueKeys: false, logLevel: 'error' }) as ReturnType<typeof parseAllDocuments> & unknown[]
}

const pairs = (n: unknown): Pair<Node, Node>[] => (isMap(n) ? (n as YAMLMap<Node, Node>).items : [])
const keyOf = (p: Pair<Node, Node>) => (isScalar(p.key) ? String(p.key.value) : '')
const get = (n: unknown, key: string) => pairs(n).find((p) => keyOf(p) === key)

export function manifestElements(_path: string, src: string): ParsedElement[] {
  const line = lineOf(src)
  const { add, list } = collector()
  /** A pair spans its key to its value's end. */
  const span = (at: Pair<Node, Node> | Node): [number, number] => {
    const [from, to] = 'key' in at ? [at.key.range![0], (at.value ?? at.key).range![1]] : [at.range![0], at.range![1]]
    return [line(from), line(Math.max(from, to - 1))]
  }
  const el = (name: string, kind: ParsedElement['kind'], decl: string, signature: string, body: unknown, at: Pair<Node, Node> | Node) =>
    add({ name, kind, decl, exported: true, signature: clip(signature), bodyHash: hash(stable(body)), lines: [span(at)] })

  for (const doc of parse(src)) {
    if (doc.errors.length || !doc.contents) continue
    const js = obj(doc.toJS())
    if (typeof js.openapi === 'string' || typeof js.swagger === 'string') openapi(js, doc.contents, el)
    else if (typeof js.apiVersion === 'string' && typeof js.kind === 'string') {
      const meta = obj(js.metadata)
      const name = typeof meta.name === 'string' ? `${js.kind}/${meta.name}` : js.kind
      const ns = typeof meta.namespace === 'string' ? ` in ${meta.namespace}` : ''
      el(name, 'infra', js.kind, `${js.kind} ${typeof meta.name === 'string' ? meta.name : ''}${ns} (${js.apiVersion})`.replace(/\s+/g, ' '), js, doc.contents)
    }
  }
  return list()
}

type El = (name: string, kind: ParsedElement['kind'], decl: string, signature: string, body: unknown, at: Pair<Node, Node> | Node) => void

/** Operations (`GET /users/{id}`), schemas with their properties and the other components, all contracts. */
function openapi(js: Json, root: Node, el: El) {
  const shared = (v: unknown) => (Array.isArray(v) ? v.map(obj) : [])
  for (const p of pairs(get(root, 'paths')?.value)) {
    const path = keyOf(p)
    const item = obj(obj(js.paths)[path])
    for (const op of pairs(p.value)) {
      const method = keyOf(op)
      if (!METHODS.includes(method)) continue
      const o = obj(item[method])
      const params = [...shared(item.parameters), ...shared(o.parameters)]
        .filter((x) => typeof x.name === 'string' || typeof x.$ref === 'string')
        .map((x) => (typeof x.name === 'string' ? `${x.name}${x.required || x.in === 'path' ? '' : '?'}` : String(x.$ref).split('/').at(-1)))
      const body = o.requestBody ? [`body${obj(o.requestBody).required ? '' : '?'}`] : []
      const codes = Object.keys(obj(o.responses))
      const name = `${method.toUpperCase()} ${path}`
      el(name, 'contract', 'operation', `${name}(${[...params, ...body].join(', ')})${codes.length ? ` → ${codes.join(' | ')}` : ''}`, o, op)
    }
  }
  const components = get(root, 'components')?.value
  const sections = [...pairs(components).map((s) => ({ section: keyOf(s), node: s.value })), ...(js.swagger ? [{ section: 'definitions', node: get(root, 'definitions')?.value }] : [])]
  for (const { section, node } of sections) {
    const values = obj(section === 'definitions' ? js.definitions : obj(js.components)[section])
    for (const s of pairs(node)) {
      const name = keyOf(s)
      const v = obj(values[name])
      if (section !== 'schemas' && section !== 'definitions') {
        el(`${section}.${name}`, 'contract', section.replace(/s$/, ''), `${section}.${name}`, v, s)
        continue
      }
      // A schema is its header and shape; its properties change on their own.
      const { properties, ...shape } = v
      el(name, 'contract', 'schema', `schema ${name}${typeOf(v) !== 'object' ? `: ${typeOf(v)}` : ''}`, shape, s)
      const required = new Set(Array.isArray(v.required) ? v.required : [])
      for (const prop of pairs(get(s.value, 'properties')?.value)) {
        const key = keyOf(prop)
        const pv = obj(obj(properties)[key])
        el(`${name}.${key}`, 'contract', 'property', `${key}${required.has(key) ? '' : '?'}: ${typeOf(pv)}`, pv, prop)
      }
    }
  }
}

/** A schema's type in one word: `string`, `User`, `User[]`, `A | B`. */
function typeOf(s: Json): string {
  if (typeof s.$ref === 'string') return s.$ref.split('/').at(-1)!
  if (s.type === 'array') return `${typeOf(obj(s.items))}[]`
  for (const k of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(s[k])) return (s[k] as unknown[]).map((x) => typeOf(obj(x))).join(k === 'allOf' ? ' & ' : ' | ')
  if (Array.isArray(s.enum)) return s.enum.map((x) => JSON.stringify(x)).join(' | ')
  const t = Array.isArray(s.type) ? s.type.join(' | ') : typeof s.type === 'string' ? s.type : 'object'
  return `${t}${s.format ? `(${s.format})` : ''}${s.nullable ? ' | null' : ''}`
}

/** `$ref`s to other files, and the resources a Kustomization pulls in. */
function manifestImports(_path: string, src: string) {
  const line = lineOf(src)
  const out: { spec: string; line: number }[] = []
  const walk = (n: unknown) => {
    if (isMap(n))
      for (const p of (n as YAMLMap<Node, Node>).items) {
        const k = keyOf(p)
        if (k === '$ref' && isScalar(p.value) && typeof p.value.value === 'string' && !p.value.value.startsWith('#'))
          out.push({ spec: p.value.value.split('#')[0], line: line(p.value.range![0]) })
        else walk(p.value)
      }
    else if (isSeq(n)) n.items.forEach(walk)
  }
  for (const doc of parse(src)) {
    if (doc.errors.length || !doc.contents) continue
    const js = obj(doc.toJS())
    if (js.kind === 'Kustomization')
      for (const key of ['resources', 'bases', 'components'])
        for (const r of (get(doc.contents, key)?.value as { items?: Node[] } | undefined)?.items ?? [])
          if (isScalar(r) && typeof r.value === 'string') out.push({ spec: r.value, line: line(r.range![0]) })
    walk(doc.contents)
  }
  return out
}

/** Relative to the file; a folder (a Kustomization base) counts. A URL is an outside package by its host. */
function resolveManifest(from: string, spec: string, files: Set<string>): string | null {
  const url = /^[a-z+]+:\/\/([^/]+)/i.exec(spec)
  if (url) return `ext:${url[1]}`
  const p = normalize(join(dirname(from), spec)).replace(/\/$/, '')
  if (files.has(p)) return p
  return [...files].some((f) => f.startsWith(`${p}/`)) ? p : null
}

export const manifest: LangAdapter = {
  lang: 'yaml',
  data: true,
  matches: (path) => /\.(ya?ml|json)$/i.test(path),
  elements: manifestElements,
  imports: manifestImports,
  resolve: resolveManifest,
}
