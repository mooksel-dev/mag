import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tsElements, typescript } from './typescript.ts'

const byName = (src: string, path = 'a.ts') => new Map(tsElements(path, src).map((e) => [e.name, e]))

test('top-level declarations with signatures, members and lines', () => {
  const els = byName(`import { x } from './x'
export function run(a: string, b = 2): number {
  return 1
}
const helper = (n: number) => n * 2
export interface Store {
  get(id: string): Task
  name: string
}
export class Orchestrator extends Base {
  private secret = 1
  #hidden = 2
  constructor(store: Store) { super() }
  async develop(stepId: string): Promise<void> {}
}
export type Id = string
export enum Mode { A, B }
`)
  assert.deepEqual([...els.keys()], ['run', 'helper', 'Store', 'Store.get', 'Store.name', 'Orchestrator', 'Orchestrator.develop', 'Orchestrator.constructor', 'Id', 'Mode'])
  assert.equal(els.get('run')!.signature, 'function run(a: string, b = 2): number')
  assert.deepEqual(els.get('run')!.lines, [[2, 4]])
  assert.equal(els.get('helper')!.signature, 'helper(n: number)')
  assert.equal(els.get('helper')!.exported, false)
  assert.equal(els.get('Store')!.signature, 'interface Store')
  assert.equal(els.get('Store.get')!.signature, 'get(id: string): Task')
  assert.equal(els.get('Orchestrator')!.signature, 'class Orchestrator extends Base')
  assert.equal(els.get('Orchestrator.develop')!.signature, 'async develop(stepId: string): Promise<void>')
  assert.equal(els.get('Orchestrator.develop')!.decl, 'method')
  assert.equal(els.get('Id')!.signature, 'type Id = string')
})

test('a body change keeps the signature and changes the hash; a member change leaves its class alone', () => {
  const a = byName('export class C {\n  m(x: number) { return x }\n}\nexport function f() { return 1 }')
  const b = byName('export class C {\n  m(x: number) { return x + 1 }\n}\nexport function f() {\n  return 2\n}')
  assert.equal(a.get('C')!.bodyHash, b.get('C')!.bodyHash)
  assert.equal(a.get('C.m')!.signature, b.get('C.m')!.signature)
  assert.notEqual(a.get('C.m')!.bodyHash, b.get('C.m')!.bodyHash)
  assert.notEqual(a.get('f')!.bodyHash, b.get('f')!.bodyHash)
  // Whitespace and comments alone change nothing.
  assert.equal(byName('function g() { return 1 }').get('g')!.bodyHash, byName('/** doc */\nfunction g() {\n  return 1\n}').get('g')!.bodyHash)
})

test('contracts-as-data: an array of named items is one contract per item, the schema keys its signature', () => {
  const els = byName(`export const TOOL_DEFS = [
  { name: 'get_task', description: 'Get it', inputSchema: { type: 'object', properties: {} } },
  { name: 'set_pr', description: 'PR', inputSchema: { type: 'object', properties: { url: { type: 'string' }, repo: {} }, required: ['url'] } },
] as const
export const NAMES = ['a', 'b']
export const PROMPT = \`You are…\`
`)
  assert.equal(els.get('TOOL_DEFS')!.decl, 'const')
  assert.equal(els.get('TOOL_DEFS[get_task]')!.kind, 'contract')
  assert.equal(els.get('TOOL_DEFS[get_task]')!.signature, 'get_task()')
  assert.equal(els.get('TOOL_DEFS[set_pr]')!.signature, 'set_pr(url, repo?)')
  assert.deepEqual(els.get('TOOL_DEFS[set_pr]')!.lines, [[3, 3]])
  assert.ok(!els.has('NAMES[a]'))
  assert.equal(els.get('PROMPT')!.kind, 'symbol')
  const changed = byName("export const TOOL_DEFS = [{ name: 'get_task', description: 'Get the task', inputSchema: { type: 'object', properties: {} } }]")
  assert.notEqual(changed.get('TOOL_DEFS[get_task]')!.bodyHash, els.get('TOOL_DEFS[get_task]')!.bodyHash)
  assert.equal(changed.get('TOOL_DEFS')!.bodyHash, els.get('TOOL_DEFS')!.bodyHash)
})

test('statements that declare nothing are one top-level element; overloads are one element', () => {
  const els = byName(`app.whenReady().then(start)
export function f(a: string): void
export function f(a: number): void
export function f(a: unknown) {}
if (dev) log()
`)
  assert.deepEqual(els.get('(top-level)')!.lines, [[1, 1], [5, 5]])
  assert.deepEqual(els.get('f')!.lines.length, 3)
})

test('the adapter reads TS and JS, not declarations; tsx parses', () => {
  assert.ok(typescript.matches('a/b.tsx') && typescript.matches('x.mjs') && !typescript.matches('x.d.ts') && !typescript.matches('x.css'))
  assert.deepEqual([...byName('export function App() { return <div/> }', 'App.tsx').keys()], ['App'])
  assert.deepEqual(typescript.imports('a.ts', "import a from './a'\nconst b = await import('b')"), [{ spec: './a', line: 1 }, { spec: 'b', line: 2 }])
})
