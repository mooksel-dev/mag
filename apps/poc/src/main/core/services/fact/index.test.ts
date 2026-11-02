// The fact service knows no step and no git: changes from any source, against any intent (reviews-ahent-reviuit-pr-timeitiv.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Canvas, ComponentDiagram, Project } from '@mag/core'
import type { FileDiff } from '@mag/diff'
import { changes, check, factReport, hunk, seed, type ChangeSource } from './index.ts'

const project = {
  baseBranch: 'main',
  architecture: { summary: '', updatedAt: 1, modules: [{ id: 'api', name: 'api', description: '', uses: [], paths: ['src/api'] }] },
} as unknown as Project

const DIFF: FileDiff[] = [
  { path: 'src/api/users.ts', status: 'mod', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }] },
  { path: 'src/jobs/sync.ts', status: 'add', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }] },
] as FileDiff[]

/** A source that is not git: what a PR's diff from GitHub will be. */
const source: ChangeSource = {
  diffHunks: async (at, base, head) => (at === 'gh:o/app#7' && base === 'aaaaaaa' && head === 'bbbbbbb' ? DIFF : []),
  hunkLines: async (_at, _base, _head, ref) => [`+${ref.path}`],
}

const target = { repo: 'o/app', name: 'app', at: 'gh:o/app#7', base: 'aaaaaaa', head: 'bbbbbbb' }

const INTENT: ComponentDiagram = {
  type: 'component',
  summary: 'users gets list',
  modules: [
    { id: 'api', name: 'api', description: '', uses: [], interface: [{ text: 'list(): User[]', diff: 'add' }] },
    { id: 'jobs', name: 'jobs', description: '', uses: [], path: 'src/jobs', diff: 'add', interface: [{ text: 'sync(): void', diff: 'add' }] },
  ],
}

const canvas = (id: string, diagram: ComponentDiagram, version = 1) => ({ id, title: id, version, diagram }) as unknown as Canvas

test('changes: files of any source, owned by the architecture and the modules the intent adds', async () => {
  const none = await changes(project, [target], source)
  assert.deepEqual(none.files.map((f) => [f.repo, f.path, f.module]), [['app', 'src/api/users.ts', 'api'], ['app', 'src/jobs/sync.ts', null]])
  assert.deepEqual(none.repos, [{ repo: 'o/app', name: 'app', baseSha: 'aaaaaaa', headSha: 'bbbbbbb' }])
  const withIntent = await changes(project, [target], source, [canvas('intent', INTENT)])
  assert.deepEqual(withIntent.files.map((f) => f.module), ['api', 'jobs'])
})

test('seed and check: the fact starts as a copy of the intent and is checked against files and intent', async () => {
  const intent = [canvas('intent', INTENT)]
  const changed = await changes(project, [target], source, intent)
  const start = seed('o/app#7', intent, changed.files, project.architecture)!
  assert.deepEqual(start.modules, INTENT.modules)
  assert.match(start.summary ?? '', /^Fact of o\/app#7, started as a copy/)

  const unchecked = check(project, changed, null, intent)
  assert.equal(unchecked.blockers[0], 'there is no fact diagram of the PRs yet')

  const drawn: ComponentDiagram = {
    ...INTENT,
    modules: [
      { ...INTENT.modules[0], interface: [{ text: 'list(): User[]', diff: 'add', files: ['src/api/users.ts'] }] },
      { ...INTENT.modules[1], interface: [{ text: 'sync(): void', diff: 'add', files: ['src/jobs/sync.ts'] }] },
    ],
  }
  const fact = check(project, changed, canvas('fact', drawn, 2), intent)
  assert.deepEqual(fact.coverage!.unshown, [])
  assert.deepEqual(fact.comparison.items.map((i) => i.status), ['match', 'match', 'match'])
  assert.deepEqual(fact.blockers, [])
  assert.match(factReport(fact, 1), /Fact diagram: \[fact\]\(canvas:fact\) \(v2\), revised\./)
})

test('hunk: through the source, between commit shas only', async () => {
  assert.deepEqual(await hunk(source, target.at, target.base, target.head, { path: 'src/api/users.ts', ...DIFF[0].hunks[0] }), ['+src/api/users.ts'])
  await assert.rejects(hunk(source, target.at, 'HEAD', target.head, { path: 'x', ...DIFF[0].hunks[0] }), /commit shas/)
})
