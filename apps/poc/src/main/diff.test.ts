// The architecture diff over real git (T-57.1): the git client, get_pr_changes, and merged PRs of mag as fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiff, type Change, type ChangeSet, type Vocabulary } from '@mag/diff'
import { blobs, diffHunks, parseDiff, treeAt } from './git.ts'
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
    { path: 'a.ts', status: 'mod', hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 }, { oldStart: 10, oldLines: 2, newStart: 11, newLines: 0 }] },
    { path: 'new.ts', status: 'add', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] },
    { path: 'gone.ts', status: 'del', hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 }] },
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

test('git client: treeAt, blobs and diffHunks with a rename', async () => {
  const repo = fixtureRepo()
  const tree = await treeAt(repo, 'main')
  assert.deepEqual(tree.map((f) => f.path).sort(), ['src/old name.ts', 'src/store.ts'])
  const src = await blobs(repo, [...tree.map((f) => f.blob), '0'.repeat(40)])
  assert.equal(src.get(tree.find((f) => f.path === 'src/store.ts')!.blob), 'export function load(id: string) {\n  return id\n}\n')
  assert.equal(src.size, 2)
  const files = await diffHunks(repo, 'main', 'mag/x-1')
  assert.deepEqual(files, [
    { path: 'src/new name.ts', oldPath: 'src/old name.ts', status: 'rename', hunks: [] },
    { path: 'src/store.ts', status: 'mod', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }] },
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
  assert.match(out, /^app: [0-9a-f]{12} → [0-9a-f]{12}, 2 file\(s\) changed, deterministic\./)
  assert.match(out, /\nstore\n {2}~ function load {2}src\/store\.ts:2\n {6}- function load\(id: string\)\n {6}\+ function load\(id: string, fresh = false\)\n {2}\+ uses app {2}src\/store\.ts:1\n/)
  assert.match(out, /file > src\/new name\.ts \(from src\/old name\.ts\)/)
  await assert.rejects(tools({ taskId: task.id, sessionId: reviewer.id }, 'get_pr_changes', { repo: 'web' }), /not a repo of this task/)
  git(repo, 'checkout', '-q', 'main')
  assert.equal(await tools({ taskId: task.id, sessionId: reviewer.id }, 'get_pr_changes', {}), 'app: no commits of its own on mag/x-1.')
})

// Merged PRs of mag; what their plans missed and the skeleton found is T-56 §Findings F10.
const ROOT = git(process.cwd(), 'rev-parse', '--show-toplevel')
const has = (sha: string) => {
  try {
    git(ROOT, 'cat-file', '-e', `${sha}^2`)
    return true
  } catch {
    return false
  }
}
const PRS = { 47: '7306f8ed1c09efbbbee58b5309d444a16f1296d7', 48: 'd15ff3ecd267fb5a4fdf23edc8901c4878137981', 51: 'cfcbf58955ea5e6e631c98fd21686b0983631bfa' }

/** The modules of mag's architecture these PRs touch, as recorded by the architect. */
const MAG: Vocabulary = {
  modules: Object.entries({
    poc: 'apps/poc', 'main-entry': 'apps/poc/src/main/index.ts', orchestrator: 'apps/poc/src/main/orchestrator.ts', 'agent-tools': 'apps/poc/src/main/tools.ts',
    store: 'apps/poc/src/main/store.ts', 'tool-defs': 'apps/poc/src/main/tool-defs.ts', 'preload-bridge': 'apps/poc/src/preload', 'renderer-app': 'apps/poc/src/renderer/src/App.tsx',
    'diff-tab': 'apps/poc/src/renderer/src/DiffTab.tsx', 'popout-view': 'apps/poc/src/renderer/src/Popout.tsx', 'chat-view': 'apps/poc/src/renderer/src/Chat.tsx',
    'diagram-views': 'apps/poc/src/renderer/src/diagrams', 'component-diagram': 'apps/poc/src/renderer/src/diagrams/Component.tsx', 'graph-diagrams': 'apps/poc/src/renderer/src/diagrams/Graph.tsx',
    'component-diff': 'apps/poc/src/renderer/src/componentDiff.ts', 'arch-edges': 'apps/poc/src/renderer/src/archEdges.ts', 'core-model': 'packages/core/src',
  }).map(([id, path]) => ({ id, paths: [path] })),
}

const engine = createDiff({ treeAt, blobs, diffHunks })
const factOf = (sha: string) => engine.changes({ path: ROOT, name: 'mag' }, `${sha}^1`, `${sha}^2`, MAG)
const lines = (cs: ChangeSet, pick: (c: Change) => boolean) => cs.changes.filter(pick).map((c) => `${c.diff} ${c.module}:${c.kind === 'edge' ? `-> ${c.name}` : c.name}`)
const elements = (cs: ChangeSet) => lines(cs, (c) => c.kind === 'element')
const edges = (cs: ChangeSet) => lines(cs, (c) => c.kind === 'edge' && !c.name!.startsWith('ext:'))
const includes = (all: string[], want: string[]) => assert.deepEqual(want.filter((w) => !all.includes(w)), [], `missing in\n${all.join('\n')}`)

test('PR #47 (T-48.1): the API changes of component-diff its plan missed, and routeEdges got pill', { skip: !has(PRS[47]) && 'mag history not here' }, async () => {
  const cs = await factOf(PRS[47])
  includes(elements(cs), ['add component-diff:edgePill', 'add component-diff:callGroups', 'add component-diff:CallGroup', 'del component-diff:edgeCalls', 'del component-diff:EDGE_CALLS', 'mod arch-edges:routeEdges'])
  const route = cs.changes.find((c) => c.name === 'routeEdges')!
  assert.equal(route.part, 'signature')
  assert.match(route.after!, /pill = PILL/)
  // The plan marked 7 modules the PR did not touch; the fact has only these.
  assert.deepEqual([...new Set(cs.changes.filter((c) => !c.test).map((c) => c.module))].sort(), ['arch-edges', 'component-diagram', 'component-diff', 'core-model', 'poc'])
  assert.equal(cs.deterministic, true)
})

test('PR #48 (T-48.2): CanvasFrame got siblings, new dependencies, flow types in core', { skip: !has(PRS[48]) && 'mag history not here' }, async () => {
  const cs = await factOf(PRS[48])
  includes(elements(cs), ['mod chat-view:CanvasFrame', 'add component-diff:flowOf', 'add component-diff:methodCallers', 'add component-diff:FlowItem', 'add diagram-views:DiagramItem', 'add core-model:flowDiff', 'add core-model:MethodFlow'])
  assert.match(cs.changes.find((c) => c.name === 'CanvasFrame')!.after!, /siblings/)
  includes(edges(cs), ['add popout-view:-> diff-tab', 'add diagram-views:-> component-diff', 'add component-diagram:-> graph-diagrams'])
  // arch-edges changed in #47, not here.
  assert.ok(!cs.changes.some((c) => c.module === 'arch-edges'))
})

test('PR #51 (T-50.1): wiring, preload, App.tsx, core helpers, Store.createTask and the tool contracts', { skip: !has(PRS[51]) && 'mag history not here' }, async () => {
  const cs = await factOf(PRS[51])
  includes(elements(cs), [
    'mod main-entry:(top-level)', 'add preload-bridge:NewTask.repos', 'mod renderer-app:SubtaskRow', 'add core-model:repoNames', 'add core-model:projectRepo', 'add core-model:stepRepoNames',
    'mod store:Store.createTask', 'add tool-defs:TOOL_DEFS[add_repo]', 'mod tool-defs:TOOL_DEFS[create_subtask]',
  ])
  assert.equal(cs.changes.find((c) => c.name === 'TOOL_DEFS[create_subtask]')!.after, 'create_subtask(title, note?, start_manually?, repos?)')
  // The plan marked tasks-view changed; the change was in App.tsx.
  assert.ok(!cs.changes.some((c) => c.path?.endsWith('Tasks.tsx')))
})
