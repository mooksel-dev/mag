import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDiff } from './engine.ts'
import { formatChangeSet } from './format.ts'
import { moduleResolver, vocabularyOf } from './vocabulary.ts'
import type { FileDiff, GitSource, Vocabulary } from './types.ts'

type Commit = Record<string, string>

/** Commits in memory. A changed file's hunks span the whole file, unless the test passes its own. */
function fakeGit(commits: Record<string, Commit>, hunks: Record<string, FileDiff['hunks']> = {}): GitSource & { reads: number } {
  const blob = (s: string) => createHash('sha1').update(s).digest('hex')
  const all = new Map(Object.values(commits).flatMap((c) => Object.values(c).map((s) => [blob(s), s])))
  const len = (s?: string) => (s ? s.split('\n').length : 0)
  const git = {
    reads: 0,
    treeAt: async (_: string, sha: string) => Object.entries(commits[sha]).map(([path, s]) => ({ path, blob: blob(s) })),
    blobs: async (_: string, shas: string[]) => {
      git.reads += shas.length
      return new Map(shas.map((s) => [s, all.get(s)!]))
    },
    diffHunks: async (_: string, base: string, head: string) => {
      const a = commits[base]
      const b = commits[head]
      const out: FileDiff[] = []
      for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[p] === b[p]) continue
        const status = !(p in a) ? 'add' : !(p in b) ? 'del' : 'mod'
        out.push({ path: p, status, hunks: hunks[p] ?? [{ oldStart: a[p] ? 1 : 0, oldLines: len(a[p]), newStart: b[p] ? 1 : 0, newLines: len(b[p]) }] })
      }
      return out
    },
  }
  return git
}

const vocab: Vocabulary = {
  modules: [
    { id: 'app', paths: ['apps/app'] },
    { id: 'orchestrator', paths: ['apps/app/src/orchestrator.ts'] },
    { id: 'git', paths: ['apps/app/src/git.ts'] },
    { id: 'core', paths: ['packages/core/src'] },
  ],
}

const base: Commit = {
  'package.json': '{"name":"root"}',
  'packages/core/package.json': '{"name":"@x/core","exports":{".":"./src/index.ts"}}',
  'packages/core/src/index.ts': 'export interface Task {\n  id: string\n}\nexport function old(): void {}\n',
  'apps/app/src/orchestrator.ts': "import type { Task } from '@x/core'\nexport function groom(t: Task) {\n  return 1\n}\nexport function keep() {}\n",
  'apps/app/src/git.ts': 'export function run() {}\nexport function moved(a: number) {\n  return a\n}\n',
  'apps/app/src/main.py': 'print(1)\n',
  'README.md': '# x\n',
}
const head: Commit = {
  ...base,
  'packages/core/src/index.ts': 'export interface Task {\n  id: string\n  repos?: string[]\n}\n',
  'apps/app/src/orchestrator.ts':
    "import type { Task } from '@x/core'\nimport { run } from './git.ts'\nimport ky from 'ky'\nexport function groom(t: Task, why: string) {\n  return 1\n}\nexport function keep() {}\nexport function moved(a: number) {\n  return a\n}\n",
  'apps/app/src/git.ts': 'export function run() {}\n',
  'apps/app/src/orchestrator.test.ts': 'test()\n',
  'README.md': '# y\n',
}

test('changes: elements, moves, new dependencies and files over the vocabulary', async () => {
  const d = createDiff(fakeGit({ base, head }))
  const cs = await d.changes({ path: '/r', name: 'r' }, 'base', 'head', vocab)
  const el = (diff: string) => cs.changes.filter((c) => c.kind === 'element' && c.diff === diff).map((c) => `${c.module}:${c.name}`).sort()
  assert.deepEqual(el('add'), ['core:Task.repos'])
  assert.deepEqual(el('del'), ['core:old'])
  assert.deepEqual(el('mod'), ['orchestrator:groom'])
  assert.deepEqual(el('move'), ['orchestrator:moved'])
  const groom = cs.changes.find((c) => c.name === 'groom')!
  assert.deepEqual([groom.part, groom.before, groom.after, groom.key, groom.line], ['signature', 'function groom(t: Task)', 'function groom(t: Task, why: string)', 'r:apps/app/src/orchestrator.ts#groom', 4])
  assert.equal(cs.changes.find((c) => c.name === 'moved')!.from, 'r:apps/app/src/git.ts#moved')
  assert.deepEqual(cs.changes.filter((c) => c.kind === 'edge').map((c) => `${c.diff} ${c.key}`).sort(), ['add orchestrator -> ext:ky', 'add orchestrator -> git'])
  const files = cs.changes.filter((c) => c.kind === 'file')
  assert.deepEqual(files.map((c) => `${c.diff} ${c.path} ${c.module}${c.test ? ' test' : ''}`).sort(), [
    'add apps/app/src/orchestrator.test.ts app test',
    'mod README.md null',
    'mod apps/app/src/git.ts git',
    'mod apps/app/src/orchestrator.ts orchestrator',
    'mod packages/core/src/index.ts core',
  ])
  // main.py did not change: the set stays deterministic.
  assert.equal(cs.deterministic, true)
  const text = formatChangeSet(cs)
  assert.match(text, /^r: base → head, 5 file\(s\) changed, deterministic\./)
  assert.match(text, /orchestrator\n {2}~ function groom {2}apps\/app\/src\/orchestrator\.ts:4\n {6}- function groom\(t: Task\)\n {6}\+ function groom\(t: Task, why: string\)/)
  assert.match(text, /\+ uses ext:ky/)
  assert.match(text, /tests: \+ apps\/app\/src\/orchestrator\.test\.ts/)
})

test('changes: hunks go to the elements they touch; a changed file without an adapter is not deterministic', async () => {
  const next: Commit = { ...base, 'apps/app/src/git.ts': 'export function run() {}\nexport function moved(a: number) {\n  return a + 1\n}\n', 'apps/app/src/main.py': 'print(2)\n' }
  const git = fakeGit({ base, next }, { 'apps/app/src/git.ts': [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }] })
  const cs = await createDiff(git).changes('/repos/r', 'base', 'next', vocab)
  const moved = cs.changes.find((c) => c.name === 'moved')!
  assert.deepEqual([moved.diff, moved.part, moved.hunks], ['mod', 'body', [{ path: 'apps/app/src/git.ts', oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }]])
  assert.equal(cs.changes.find((c) => c.name === 'run'), undefined)
  assert.deepEqual([cs.deterministic, cs.unparsed], [false, ['apps/app/src/main.py']])
  assert.match(formatChangeSet(cs), /NOT deterministic: no adapter for apps\/app\/src\/main\.py/)
})

test('skeleton: module edges through workspace packages; blobs parse once', async () => {
  const git = fakeGit({ base, head })
  const d = createDiff(git)
  const sk = await d.skeleton('/r', 'base', vocab)
  assert.deepEqual(sk.edges, [{ from: 'orchestrator', to: 'core', files: ['apps/app/src/orchestrator.ts'] }])
  assert.equal(sk.elements.find((e) => e.name === 'groom')!.ref, 'r:apps/app/src/orchestrator.ts#groom')
  assert.deepEqual(sk.unparsed, ['apps/app/src/main.py'])
  const reads = git.reads
  await d.skeleton('/r', 'base', vocab)
  // Only package.json files are read again: parsed sources come from the cache.
  assert.equal(git.reads - reads, 2)
})

test('vocabulary: the most specific path wins; globs; the architecture tree with repo-relative paths', () => {
  const of = moduleResolver({ modules: [{ id: 'app', paths: ['apps/poc'] }, { id: 'views', paths: ['apps/poc/src/renderer/src/*.tsx'] }, { id: 'diagrams', paths: ['apps/poc/src/renderer/src/diagrams/'] }] })
  assert.equal(of('apps/poc/src/main/x.ts'), 'app')
  assert.equal(of('apps/poc/src/renderer/src/App.tsx'), 'views')
  assert.equal(of('apps/poc/src/renderer/src/diagrams/Graph.tsx'), 'diagrams')
  assert.equal(of('apps/pocket/a.ts'), null)
  const v = vocabularyOf([
    { id: 'poc', name: 'poc', description: '', uses: [], path: 'apps/poc', children: [{ id: 'store', name: 'store', description: '', uses: [], path: './apps/poc/src/main/store.ts' }] },
    { id: 'db', name: 'db', description: '', uses: [], path: '~/Library/mag' },
    { id: 'gh', name: 'GitHub', description: '', uses: [] },
  ])
  assert.deepEqual(v.modules, [{ id: 'poc', paths: ['apps/poc'] }, { id: 'store', paths: ['./apps/poc/src/main/store.ts'] }])
  assert.equal(moduleResolver(v)('apps/poc/src/main/store.ts'), 'store')
})
