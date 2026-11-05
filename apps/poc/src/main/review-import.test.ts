// An imported review on a machine without the repository (review-v2-part-2-v1-2.3): a read-only review work whose fact
// and hunks come from the bundled diff; nothing runs, decides or publishes on it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleOf, importedReview, remapCanvasIds, type PrDetails, type Task } from '@mag/core'
import { Store } from './store.ts'
import { Orchestrator } from './orchestrator.ts'
import { reviewDiff, reviewFactView, reviewHunk } from './fact.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const URL = 'https://github.com/acme/api/pull/418'
const DIFF = `diff --git a/src/retry.ts b/src/retry.ts
index 1111111..2222222 100644
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,2 +1,3 @@ export function retry() {
 const tries = 3
+const wait = 100
 return tries
`

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-import-'))
  const store = new Store(join(dir, 'db.json'))
  const orch = new Orchestrator(store, { url: 'http://127.0.0.1:1', token: 't' }, {
    mcpScript: join(dir, 'task-mcp.js'), runsDir: join(dir, 'runs'), worktreesDir: join(dir, 'worktrees'), attachmentsDir: join(dir, 'attachments'), logsDir: join(dir, 'logs'),
  })
  const project = store.createProject('home')
  const diffPath = join(dir, 'pr.diff')
  writeFileSync(diffPath, DIFF)
  // The review as exported on the work machine: its repository a path there.
  const src: Task = {
    id: 'w1', projectId: 'pw', key: 'api-418', parentId: null, title: 'api#418: Retry', type: 'review', status: 'in_progress', description: URL, rank: 0, needsInput: null, work: null, nextSubNo: 1, createdAt: 1, updatedAt: 1,
    fact: { heads: { '/work/api': HEAD }, counts: { match: 0, differs: 0, missing: 0, unplanned: 0, unaccounted: 0, ungrounded: 0 }, blockers: [], canvasId: 'c1', at: 1 },
    prReview: {
      pr: { url: URL, repo: '/work/api', number: 418, author: 'olena', base: 'main', head: HEAD },
      shown: 'v2', posted: null,
      results: { v2: { format: 'v2', sessionId: 's', problem: '', approach: '', verdict: 'approve', findings: [], head: HEAD, at: 2, report: { direction: { options: [] } } as never } },
    },
  }
  const canvases = [{ id: 'c1', projectId: 'pw', taskId: 'w1', sessionId: 's', title: 'Fact', kind: 'diagram' as const, role: 'fact' as const, root: true, version: 1, updatedAt: 1, diagram: { type: 'component', modules: [] } as never }]
  const pr = { url: URL, number: 418, title: 'Retry', body: '', author: 'olena', base: 'main', head: HEAD, files: [], commits: [], checks: [] } satisfies PrDetails
  const bundle = remapCanvasIds(bundleOf(src, '# Doc', canvases, 'work', { base: BASE, head: HEAD }), { c1: 'n1' })
  const task = store.createImportedReview(project.id, importedReview(bundle, pr, diffPath))
  return { store, orch, project, task }
}

test('an imported review is a done review work with its doc and diagrams, read from the bundled diff', async () => {
  const { store, project, task } = setup()
  assert.equal(task.type, 'review')
  assert.equal(task.status, 'done')
  assert.equal(store.data.docs[task.id], '# Doc')
  assert.deepEqual(Object.values(store.data.canvases).map((c) => [c.id, c.taskId, c.projectId]), [['n1', task.id, project.id]])
  const view = await reviewFactView(project, task, Object.values(store.data.canvases))
  assert.ok(view)
  assert.deepEqual(view.files.map((f) => f.path), ['src/retry.ts'])
  assert.deepEqual(view.repos.map((r) => [r.baseSha, r.headSha]), [[BASE, HEAD]])
  assert.equal(view.fact?.id, 'n1')
  const h = view.files[0].hunks[0]
  assert.deepEqual(await reviewHunk(task, view.repos[0].repo, BASE, HEAD, { ...h, path: 'src/retry.ts' }), [' const tries = 3', '+const wait = 100', ' return tries'])
  assert.deepEqual(await reviewDiff(project, task), { text: DIFF, base: BASE, head: HEAD }, 'exported again, it carries the same diff')
})

test('an imported review does not run, decide, publish, connect or record a review', async () => {
  const { orch, task } = setup()
  await assert.rejects(async () => orch.rereview(task.id), /read only/)
  await assert.rejects(async () => orch.runReviewFormat(task.id, 'v1'), /read only/)
  assert.throws(() => orch.decideDirection(task.id, { choice: 'ok' }), /read only/)
  await assert.rejects(orch.publishReview(task.id, 'approve', []), /read only/)
  await assert.rejects(orch.connectReviewRepo(task.id, '/x'), /read only/)
  await assert.rejects(orch.reviewFactOf(task.id), /read only/)
  assert.throws(() => orch.setPrReview(task.id, 's', { problem: '', approach: '', verdict: 'approve', findings: [] }), /read only/)
})
