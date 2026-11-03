// The architecture diff over real git (T-57.1, T-58): the git client, get_pr_changes, and merged PRs of mag as fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeInventory } from '@mag/core'
import { checkInventory, createDiff, inventoryBlockers, numberHunks, type Vocabulary } from '@mag/diff'
import { diffHunks, parseDiff, treeAt } from './git.ts'
import { Store } from './store.ts'
import { createTools, type ToolActions } from './tools.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('parseDiff: adds, deletes, renames and hunks; a removed line that looks like a header stays in its hunk', () => {
  const files = parseDiff(`diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -3 +3,2 @@ x
--- not a header
+++ nor this
+two
@@ -10,2 +11,0 @@
-a
-b
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+x
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-x
\\ No newline at end of file
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
`)
  assert.deepEqual(files, [
    {
      path: 'a.ts',
      status: 'mod',
      hunks: [
        { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, header: 'x', lines: ['--- not a header', '+++ nor this', '+two'] },
        { oldStart: 10, oldLines: 2, newStart: 11, newLines: 0, lines: ['-a', '-b'] },
      ],
    },
    { path: 'new.ts', status: 'add', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }] },
    { path: 'gone.ts', status: 'del', hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-x'] }] },
    { path: 'new name.ts', oldPath: 'old name.ts', status: 'rename', hunks: [] },
  ])
})

/** A repo with a base commit on main and a branch with a change, as a developer's worktree has it. */
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-diff-'))
  const repo = join(dir, 'app')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'src/store.ts'), 'export function load(id: string) {\n  return id\n}\n')
  writeFileSync(join(repo, 'src/old name.ts'), 'export const A = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'checkout', '-q', '-b', 'mag/x-1')
  writeFileSync(join(repo, 'src/store.ts'), "import { A } from './new name.ts'\nexport function load(id: string, fresh = false) {\n  return id\n}\n")
  git(repo, 'mv', 'src/old name.ts', 'src/new name.ts')
  git(repo, 'commit', '-q', '-am', 'change')
  return repo
}

test('git client: treeAt and diffHunks with a rename', async () => {
  const repo = fixtureRepo()
  const tree = await treeAt(repo, 'main')
  assert.deepEqual(tree.map((f) => f.path).sort(), ['src/old name.ts', 'src/store.ts'])
  const files = await diffHunks(repo, 'main', 'mag/x-1')
  assert.deepEqual(files, [
    { path: 'src/new name.ts', oldPath: 'src/old name.ts', status: 'rename', hunks: [] },
    {
      path: 'src/store.ts',
      status: 'mod',
      // Three lines of context, kept for the inventory check; git names no declaration before line 1.
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: ['-export function load(id: string) {', "+import { A } from './new name.ts'", '+export function load(id: string, fresh = false) {', '   return id', ' }'] }],
    },
  ])
})

test('get_pr_changes: the step branch against the base, by module of the architecture', async () => {
  const repo = fixtureRepo()
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'mag-tools-')), 'db.json'))
  const project = store.createProject('p')
  store.updateProject(project.id, {
    repos: [repo],
    architecture: { summary: '', updatedAt: 1, modules: [{ id: 'app', name: 'app', description: '', uses: [], path: 'src', children: [{ id: 'store', name: 'store', description: '', uses: [], path: 'src/store.ts' }] }] },
  })
  const task = store.createTask({ projectId: project.id, title: 'X', type: 'dev', description: '', status: 'in_progress' })
  const step = store.createTask({ projectId: project.id, parentId: task.id, title: 'One', type: 'dev', description: '', status: 'in_progress' })
  store.updateTask(step.id, { work: { repos: [{ repo, branch: 'mag/x-1', worktree: repo, prUrl: null, prState: null }], dir: join(repo, '..'), feedbackSeenAt: 0 } })
  const reviewer = store.createSession({ projectId: project.id, taskId: task.id, stepId: step.id, role: 'reviewer', agent: 'claude-code', status: 'running' })
  const tools = createTools(store, {} as ToolActions)
  const out = await tools({ taskId: task.id, sessionId: reviewer.id }, 'get_pr_changes', {})
  assert.match(out, /^app: [0-9a-f]{12} → [0-9a-f]{12}, 2 file\(s\) changed, 2 of them code\./)
  assert.match(out, /\napp\n {2}> src\/new name\.ts \(from src\/old name\.ts\): 0 hunk\(s\)\n\nstore\n {2}~ src\/store\.ts: 1 hunk\(s\) H1 1-3 → 1-4\n/)
  // The hunks with their ids and blocks, as set_inventory cites them.
  assert.match(out, /\n### Hunks \(cite their blocks in the inventory\)\n### H1 {2}app:src\/store\.ts {2}\[module: store\] {2}@@ -1,3 \+1,4 @@\n\[H1\.1\]\n-export function load\(id: string\) \{\n\+import \{ A \} from '\.\/new name\.ts'\n\+export function load\(id: string, fresh = false\) \{\n {3}return id\n \}$/)
  await assert.rejects(tools({ taskId: task.id, sessionId: reviewer.id }, 'get_pr_changes', { repo: 'web' }), /not a repo of this task/)
  git(repo, 'checkout', '-q', 'main')
  assert.equal(await tools({ taskId: task.id, sessionId: reviewer.id }, 'get_pr_changes', {}), 'app: no commits of its own on mag/x-1.')
})

// Merged PRs of mag: the files they change by module (T-58.1), and the change inventories a fresh agent wrote of #77 and
// #78 in the spike of diff-iak-inventar-zmin-ai (its own hunks, numbered as mag numbers them), with the calls between
// modules added in its step .2.
const ROOT = git(process.cwd(), 'rev-parse', '--show-toplevel')
const has = (sha: string) => {
  try {
    git(ROOT, 'cat-file', '-e', `${sha}^2`)
    return true
  } catch {
    return false
  }
}
const PRS = { 47: '7306f8ed1c09efbbbee58b5309d444a16f1296d7', 77: '1f1b2e9646487aa8df490211e15b1ed791d4bdc0', 78: 'a7bad79b607df716c93b02929d59467140771258' }

/** The modules of mag's architecture these PRs touch, as recorded by the architect. */
const PATHS: Record<string, string> = {
  'main-entry': 'apps/poc/src/main/index.ts', orchestrator: 'apps/poc/src/main/orchestrator.ts', 'agent-tools': 'apps/poc/src/main/tools.ts',
  store: 'apps/poc/src/main/store.ts', 'tool-defs': 'apps/poc/src/main/tool-defs.ts', 'preload-bridge': 'apps/poc/src/preload', 'renderer-app': 'apps/poc/src/renderer/src/App.tsx',
  'component-diagram': 'apps/poc/src/renderer/src/diagrams/Component.tsx', 'component-diff': 'apps/poc/src/renderer/src/componentDiff.ts', 'arch-edges': 'apps/poc/src/renderer/src/archEdges.ts',
}
const MAG: Vocabulary = { modules: [{ id: 'poc', paths: ['apps/poc'] }, ...Object.entries(PATHS).map(([id, path]) => ({ id, paths: [path] })), { id: 'core-model', paths: ['packages/core/src'] }] }

const engine = createDiff({ diffHunks })
const filesOf = (sha: string) => engine.changedFiles({ path: ROOT, name: 'mag' }, `${sha}^1`, `${sha}^2`, MAG)

test('PR #47 (T-48.1): changed files by owner module; tests and styles are not code', { skip: !has(PRS[47]) && 'mag history not here' }, async () => {
  const files = await filesOf(PRS[47])
  assert.deepEqual(files.filter((f) => f.kind === 'code').map((f) => `${f.module} ${f.path.split('/').at(-1)}`), [
    'arch-edges archEdges.ts', 'component-diff componentDiff.ts', 'component-diagram Component.tsx', 'core-model diagram.ts',
  ])
  assert.deepEqual(files.filter((f) => f.kind !== 'code').map((f) => f.kind).sort(), ['style', 'test', 'test', 'test'])
})

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('PR #77, #78 (diff-iak-inventar-zmin-ai.1): the inventories pass the check; dropping a method, model or field is caught', { skip: (!has(PRS[77]) || !has(PRS[78])) && 'mag history not here' }, async () => {
  const vocabulary = JSON.parse(fixture('vocabulary-mag77-78.json')) as Vocabulary
  let caught = 0
  let total = 0
  for (const pr of [77, 78] as const) {
    const files = numberHunks(await engine.changedFiles({ path: ROOT, name: 'mag' }, `${PRS[pr]}^1`, `${PRS[pr]}^2`, vocabulary))
    const { inventory, errors } = normalizeInventory(fixture(`inventory-mag${pr}.json`))
    assert.deepEqual(errors, [])
    const options = { modules: vocabulary.modules.map((m) => m.id) }
    const check = checkInventory(inventory, files, options)
    assert.deepEqual(inventoryBlockers(check), [], `#${pr}`)
    assert.ok(inventory.units.some((u) => u.kind === 'call'), `#${pr} has its calls`)
    for (const u of inventory.units.filter((x) => ['method', 'model', 'field'].includes(x.kind))) {
      total++
      const less = checkInventory({ ...inventory, units: inventory.units.filter((x) => x !== u) }, files, options)
      if (inventoryBlockers(less).length || less.undeclared.length > check.undeclared.length) caught++
    }
  }
  // Misses: two units in one changed line, the fields of a type in one block (as in the spike).
  assert.ok(caught / total >= 0.85, `${caught}/${total}`)
})

test('parseDiff: a diff with context (git -U3, GitHub) keeps its context lines; the counts hold (diff-iak-inventar-zmin-ai.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-context-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  writeFileSync(join(dir, 'a.ts'), lines.join('\n') + '\n')
  writeFileSync(join(dir, 'gone.ts'), 'x\ny\n')
  writeFileSync(join(dir, 'empty.ts'), '')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  const next = [...lines]
  next.splice(1, 1, '--- looks like a header', 'two b')
  next.splice(6, 0, 'inserted')
  next.splice(12, 2)
  next.push('end')
  writeFileSync(join(dir, 'a.ts'), next.join('\n') + '\n')
  writeFileSync(join(dir, 'new.ts'), 'n\n')
  writeFileSync(join(dir, 'empty.ts'), 'filled\n')
  git(dir, 'rm', '-q', 'gone.ts')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'change')
  const head = git(dir, 'rev-parse', 'HEAD')
  const files = parseDiff(execFileSync('git', ['diff', '--no-color', '-M', base, head], { cwd: dir, encoding: 'utf8' }))
  assert.deepEqual(files.map((f) => [f.path, f.status, f.hunks.length]), [['a.ts', 'mod', 2], ['empty.ts', 'mod', 1], ['gone.ts', 'del', 1], ['new.ts', 'add', 1]])
  for (const h of files.flatMap((f) => f.hunks)) {
    const count = (c: string) => h.lines!.filter((l) => l[0] === c).length
    assert.equal(count(' ') + count('-'), h.oldLines)
    assert.equal(count(' ') + count('+'), h.newLines)
  }
  const [first] = files[0].hunks
  assert.deepEqual(first.lines!.slice(0, 4), [' line 1', '-line 2', '+--- looks like a header', '+two b'], 'a changed line like a header stays in its hunk')
})
