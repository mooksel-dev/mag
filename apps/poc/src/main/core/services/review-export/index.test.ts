// Export → import of a review (review-v2-part-2-v1-2.3): the archive holds exactly its five kinds of entries, its page
// nothing external, and the review comes back the same, read only, with new canvas ids.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { externalUrls, type Canvas, type PrDetails, type Task } from '@mag/core'
import { exportReview, importReview, packReview, unpackReview, type ExportDeps, type ImportDeps } from './index.ts'

const URL = 'https://github.com/mooksel-dev/mag/pull/85'
const DIFF = 'diff --git a/src/api.ts b/src/api.ts\n--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1,1 +1,2 @@\n a\n+b\n'

const review: Task = {
  id: 't1', projectId: 'p1', key: 'mag-85', parentId: null, title: 'mag#85: Review report', type: 'review', status: 'in_progress', description: URL,
  rank: 0, needsInput: null, work: null, nextSubNo: 1, createdAt: 1, updatedAt: 1, ownerSessionId: 's2',
  fact: { heads: { '/repos/mag': 'h2' }, counts: { match: 0, differs: 0, missing: 0, unplanned: 0, unaccounted: 0, ungrounded: 0 }, blockers: [], canvasId: 'aaaa1111', at: 5 },
  prReview: {
    pr: { url: URL, repo: '/repos/mag', number: 85, author: 'teammate', base: 'main', head: 'h2' },
    shown: 'v2',
    posted: null,
    results: {
      v1: { format: 'v1', sessionId: 's1', problem: 'p', approach: 'a', verdict: 'comment', findings: [{ text: 'nit', level: 'nit', where: 'src/api.ts:2' }], head: 'h2', at: 3 },
      v2: {
        format: 'v2', sessionId: 's2', problem: '', approach: '', verdict: 'approve', findings: [], head: 'h2', at: 4,
        report: { checks: 'approve', decided: { choice: 'prefer', option: 'B', at: 4 }, direction: { decisions: [{ source: 'agent', text: 'x', cites: ['u1'], view: 'canvas:aaaa1111#api' }] } } as never,
      },
    },
  },
}

const canvases: Canvas[] = [
  {
    id: 'aaaa1111', projectId: 'p1', taskId: 't1', sessionId: 's2', title: 'Fact · Modules', kind: 'diagram', role: 'fact', root: true, version: 2, updatedAt: 1,
    diagram: { type: 'component', modules: [{ id: 'api', name: 'Api', layer: 'service', uses: [], links: [{ to: 'bbbb2222', kind: 'scenario' }] }] } as never,
    inventory: { summary: ['saves'], units: [{ id: 'u1', kind: 'method', module: 'api', name: 'Api.save', change: 'add', logic: 'trivial', hunks: ['H1'] }], noise: [] } as never,
  },
  { id: 'bbbb2222', projectId: 'p1', taskId: 't1', sessionId: 's2', title: 'Fact · Save', kind: 'diagram', role: 'fact', version: 1, updatedAt: 1, diagram: { type: 'sequence', participants: [], messages: [] } as never },
]

const pr: PrDetails = { url: URL, number: 85, title: 'Review report', body: 'Body', author: 'teammate', base: 'main', head: 'h2', files: [{ path: 'src/api.ts', additions: 1, deletions: 0 }], commits: [{ sha: 'h2', message: 'm', author: 'teammate' }], checks: [{ name: 'ci', bucket: 'pass', link: 'https://ci/1' }] }

const page = {
  html: '<!doctype html><html><body><a href="https://github.com/mooksel-dev/mag/pull/85">mag#85</a><svg id="d-aaaa1111"></svg></body></html>',
  svgs: { aaaa1111: '<svg xmlns="http://www.w3.org/2000/svg"><text>Api</text></svg>', bbbb2222: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
}

function exportDeps(written: Map<string, Uint8Array>): ExportDeps {
  return {
    review: () => ({ task: review, doc: '# Review doc\n\nsee canvas:aaaa1111', canvases, from: 'work' }),
    prDiff: async () => ({ text: DIFF, base: 'b1', head: 'h2' }),
    prDetails: async () => pr,
    render: async () => page,
    isDir: (p) => p === '/Downloads',
    write: (p, b) => void written.set(p, b),
  }
}

test('export writes one zip of exactly review.html, review.json, pr.diff, pr.json and diagrams/*.svg', async () => {
  const written = new Map<string, Uint8Array>()
  const path = await exportReview(exportDeps(written), 't1', '/Downloads')
  assert.equal(path, '/Downloads/mag-85-review.zip')
  const names = Object.keys(unzipSync(written.get(path)!)).sort()
  assert.deepEqual(names, ['diagrams/fact-modules-aaaa1111.svg', 'diagrams/fact-save-bbbb2222.svg', 'pr.diff', 'pr.json', 'review.html', 'review.json'])
  assert.equal(await exportReview(exportDeps(written), 't1', '/tmp/x.zip'), '/tmp/x.zip', 'a file path is used as it is')
})

test('review.html in the archive has no external URLs', async () => {
  const written = new Map<string, Uint8Array>()
  const path = await exportReview(exportDeps(written), 't1', '/Downloads')
  const { html } = unpackReview(written.get(path)!)
  assert.deepEqual(externalUrls(html), [])
  assert.match(html, /<a>mag#85<\/a>/, 'the link keeps its text')
})

test('export → import gives the same review: both results, the decision, the doc, canvases with the inventory, the diff', async () => {
  const written = new Map<string, Uint8Array>()
  const path = await exportReview(exportDeps(written), 't1', '/Downloads')
  let made: Parameters<ImportDeps['create']>[1] | null = null
  let n = 0
  const deps: ImportDeps = {
    read: (p) => written.get(p)!,
    newId: () => `new${++n}`,
    saveDiff: (text) => (assert.equal(text, DIFF), '/imports/x.diff'),
    create: (_pid, r) => ((made = r), { ...review, id: 'imp', ...r.task, status: 'done' }),
  }
  const task = importReview(deps, 'p9', path)
  assert.equal(task.status, 'done')
  const r = made!
  const results = r.task.prReview.results
  assert.deepEqual(Object.keys(results), ['v1', 'v2'])
  assert.deepEqual(results.v1, review.prReview!.results.v1)
  assert.deepEqual(results.v2!.report!.decided, { choice: 'prefer', option: 'B', at: 4 })
  assert.equal(results.v2!.report!.direction.decisions[0].view, 'canvas:new1#api', 'a claim view follows the new id')
  assert.equal(r.doc, '# Review doc\n\nsee canvas:new1')
  assert.deepEqual(r.canvases.map((c) => c.id), ['new1', 'new2'])
  assert.deepEqual(r.canvases[0].inventory, canvases[0].inventory)
  assert.deepEqual(r.canvases[0].diagram, { type: 'component', modules: [{ id: 'api', name: 'Api', layer: 'service', uses: [], links: [{ to: 'new2', kind: 'scenario' }] }] })
  assert.equal(r.task.fact!.canvasId, 'new1')
  assert.deepEqual(r.task.imported, { ...r.task.imported!, from: 'work', pr, base: 'b1', head: 'h2', diffPath: '/imports/x.diff' })
  assert.equal(r.task.prReview.pr.outside, true)
})

test('import refuses a file that is not a review archive, or of another version', () => {
  const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))
  const good = unpackReview(packReview(JSON.parse(JSON.stringify({ version: 1, exportedAt: 1, from: 'w', review: { key: 'k', title: 't', description: '', prReview: review.prReview, fact: null, doc: '' }, diff: { base: 'b', head: 'h' }, canvases: [] })), page, DIFF, pr))
  const all = { 'review.html': good.html, 'review.json': JSON.stringify(good.bundle), 'pr.diff': DIFF, 'pr.json': JSON.stringify(pr) }
  assert.throws(() => unpackReview(strToU8('not a zip')), /not a \.zip/)
  assert.throws(() => unpackReview(zip(Object.fromEntries(Object.entries(all).filter(([k]) => k !== 'pr.diff')))), /pr\.diff missing/)
  assert.throws(() => unpackReview(zip({ ...all, 'notes.txt': 'x' })), /unexpected notes\.txt/)
  assert.throws(() => unpackReview(zip({ ...all, 'review.json': JSON.stringify({ ...good.bundle, version: 2 }) })), /version 2/)
  assert.throws(() => unpackReview(zip({ ...all, 'review.json': '{' })), /not JSON/)
})
