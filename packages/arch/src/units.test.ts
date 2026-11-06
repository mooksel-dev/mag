import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { changedUnits, draftable, type DraftFile } from './units.ts'

const before = `import { a } from './a'

/** Saves it. */
export function save(id: string): void {
  a(id)
}

export class Repo {
  private n = 0
  get(id: string): string {
    return id
  }
  #hidden() {}
}

export interface Opts {
  depth: number
}
`

const after = `import { a } from './a'

/** Saves it, twice. */
export async function save(id: string, again = true): Promise<void> {
  a(id)
  if (again) a(id)
}

export class Repo {
  private n = 0
  get(id: string): string {
    // trimmed
    return id.trim()
  }
  #hidden() {}
}

const helper = (x: number): number => x + 1
`

const file = (hunks: DraftFile['hunks'], over: Partial<DraftFile> = {}): DraftFile => ({ path: 'src/repo.ts', module: 'core:repo', before, after, hunks, ...over })

test('a changed function, a changed method, an added helper, a removed interface: one unit each with signatures and blocks', () => {
  const draft = changedUnits([
    file([
      {
        id: 'H1',
        oldStart: 2,
        newStart: 2,
        lines: [' ', '-/** Saves it. */', '-export function save(id: string): void {', '+/** Saves it, twice. */', '+export async function save(id: string, again = true): Promise<void> {', '   a(id)', '+  if (again) a(id)', ' }'],
      },
      { id: 'H2', oldStart: 10, newStart: 11, lines: ['   get(id: string): string {', '-    return id', '+    // trimmed', '+    return id.trim()', '   }'] },
      {
        id: 'H3',
        oldStart: 15,
        newStart: 17,
        lines: [' ', '-export interface Opts {', '-  depth: number', '-}', '+const helper = (x: number): number => x + 1'],
      },
    ]),
  ])
  const by = (name: string) => draft.units.find((u) => u.name === name)
  assert.deepEqual(by('save'), {
    id: 'd1', kind: 'method', module: 'core:repo', owner: 'repo', name: 'save', change: 'mod', visibility: 'public',
    before: 'save(id: string): void', after: 'async save(id: string, again = true): Promise<void>', hunks: ['H1.1', 'H1.2'],
  })
  assert.equal(by('Repo.get')?.change, 'mod')
  assert.equal(by('Repo.get')?.owner, 'Repo')
  assert.deepEqual(by('Repo.get')?.hunks, ['H2.1'])
  assert.equal(by('Opts')?.kind, 'model')
  assert.equal(by('Opts')?.change, 'del')
  assert.equal(by('Opts')?.before, 'interface Opts')
  assert.deepEqual(by('helper'), {
    id: 'd4', kind: 'method', module: 'core:repo', owner: 'repo', name: 'helper', change: 'add', visibility: 'private',
    after: 'helper(x: number): number', hunks: ['H3.1'],
  })
  assert.equal(by('Repo'), undefined, 'a change inside a method is not its class')
  assert.deepEqual(draft.noise, [])
})

test('a block of comments only is noise; private members are private', () => {
  const src = 'export class A {\n  #x() {\n    return 1\n  }\n}\n'
  const next = 'export class A {\n  // why\n  #x() {\n    return 2\n  }\n}\n'
  const draft = changedUnits([
    file([{ id: 'H1', oldStart: 1, newStart: 1, lines: [' export class A {', '+  // why', '   #x() {', '-    return 1', '+    return 2', '   }'] }], { before: src, after: next }),
  ])
  assert.deepEqual(draft.noise, [{ hunks: ['H1.1'], reason: 'comments and blank lines only' }])
  assert.equal(draft.units.length, 1)
  assert.equal(draft.units[0].name, 'A.#x')
  assert.equal(draft.units[0].visibility, 'private')
  assert.deepEqual(draft.units[0].hunks, ['H1.2'])
})

test('an added file: every declaration is added; a file of no module or another language gets none', () => {
  const text = 'export type Id = string\nexport function f(): Id {\n  return ""\n}\n'
  const lines = text.trimEnd().split('\n').map((l) => `+${l}`)
  const added = changedUnits([file([{ id: 'H1', oldStart: 0, newStart: 1, lines }], { before: null, after: text })])
  assert.deepEqual(added.units.map((u) => [u.name, u.kind, u.change, u.after]), [['Id', 'model', 'add', 'type Id = string'], ['f', 'method', 'add', 'f(): Id']])
  assert.deepEqual(changedUnits([file([{ id: 'H1', oldStart: 0, newStart: 1, lines }], { before: null, after: text, module: null })]).units, [])
  assert.deepEqual(changedUnits([file([{ id: 'H1', oldStart: 0, newStart: 1, lines }], { before: null, after: text, path: 'x.go' })]).units, [])
  assert.equal(draftable('a/b.d.ts'), false)
  assert.equal(draftable('a/b.tsx'), true)
  assert.equal(draftable('a/b.mjs'), true)
})

test('lines between declarations (imports) are no unit: the reviewer gives their dependency', () => {
  const next = before.replace("import { a } from './a'", "import { a } from './a'\nimport { b } from './b'")
  const draft = changedUnits([file([{ id: 'H1', oldStart: 1, newStart: 1, lines: [" import { a } from './a'", "+import { b } from './b'", ' '] }], { after: next })])
  assert.deepEqual(draft.units, [])
  assert.deepEqual(draft.noise, [])
})
