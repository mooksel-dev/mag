import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertNotImported, bundleFileName, bundleOf, externalUrls, importedReview, isImported, offline, readBundle, remapCanvasIds,
  type Canvas, type PrDetails, type Task,
} from './index.ts'

const review: Task = {
  id: 't1', projectId: 'p1', key: 'mag-85', parentId: null, title: 'mag#85: Review report', type: 'review', status: 'in_progress', description: 'https://github.com/mooksel-dev/mag/pull/85',
  rank: 0, needsInput: null, work: null, nextSubNo: 1, createdAt: 1, updatedAt: 1,
  fact: { heads: { '/repos/mag': 'h2' }, counts: { match: 0, differs: 0, missing: 0, unplanned: 0, unaccounted: 1, ungrounded: 0 }, blockers: [], canvasId: 'aaaa1111', at: 5 },
  prReview: {
    pr: { url: 'https://github.com/mooksel-dev/mag/pull/85', repo: '/repos/mag', number: 85, author: 'teammate', base: 'main', head: 'h2' },
    shown: 'v2',
    posted: null,
    results: {
      v1: { format: 'v1', sessionId: 's1', problem: 'p', approach: 'a', verdict: 'comment', findings: [{ text: 'nit', level: 'nit', node: 'canvas:aaaa1111#api' }], head: 'h2', at: 3 },
      v2: { format: 'v2', sessionId: 's2', problem: '', approach: '', verdict: 'approve', findings: [], head: 'h2', at: 4, report: { decided: { choice: 'ok', at: 4 } } as never },
    },
  },
}

const canvas = (id: string, extra: Partial<Canvas> = {}): Canvas => ({
  id, projectId: 'p1', taskId: 't1', sessionId: 's2', title: id, kind: 'diagram', role: 'fact', version: 1, updatedAt: 1,
  diagram: { type: 'component', modules: [{ id: 'api', name: 'Api', layer: 'service', uses: [], links: [{ to: 'bbbb2222', kind: 'scenario' }] }] } as never,
  ...extra,
})
const canvases = [
  canvas('aaaa1111', { root: true, inventory: { summary: ['x'], units: [], noise: [] } }),
  canvas('bbbb2222'),
  canvas('cccc3333', { taskId: 'other' }),
  { ...canvas('dddd4444'), kind: 'html', html: '<p>x</p>', diagram: undefined } as Canvas,
]

const pr: PrDetails = { url: review.prReview!.pr.url, number: 85, title: 'Review report', body: 'b', author: 'teammate', base: 'main', head: 'h2', files: [], commits: [], checks: [] }

test('bundleOf keeps both results, the direction call, the doc, the inventory and only the review\'s diagrams', () => {
  const b = bundleOf(review, '# Doc', canvases, 'mag', { base: 'b1', head: 'h2' }, 9)
  assert.equal(b.version, 1)
  assert.deepEqual(Object.keys(b.review.prReview.results), ['v1', 'v2'])
  assert.deepEqual(b.review.prReview.results.v2!.report!.decided, { choice: 'ok', at: 4 })
  assert.equal(b.review.doc, '# Doc')
  assert.deepEqual(b.canvases.map((c) => c.id), ['aaaa1111', 'bbbb2222'])
  assert.deepEqual(b.canvases[0].inventory, { summary: ['x'], units: [], noise: [] })
  assert.ok(!('projectId' in b.canvases[0]) && !('sessionId' in b.canvases[0]))
  assert.throws(() => bundleOf({ ...review, type: 'dev' }, '', [], 'mag', { base: 'b', head: 'h' }), /not a review/)
})

test('readBundle refuses another version and a file that is not a review', () => {
  const b = bundleOf(review, '', canvases, 'mag', { base: 'b1', head: 'h2' })
  assert.deepEqual(readBundle(JSON.parse(JSON.stringify(b))), b)
  assert.throws(() => readBundle({ ...b, version: 2 }), /version 2/)
  assert.throws(() => readBundle([]), /not an object/)
  assert.throws(() => readBundle({ ...b, review: { ...b.review, prReview: { ...b.review.prReview, pr: { ...b.review.prReview.pr, url: 'https://example.com' } } } }), /not a GitHub PR/)
  assert.throws(() => readBundle({ ...b, canvases: [{ id: 'x', kind: 'html' }] }), /diagram/)
  assert.throws(() => readBundle({ ...b, diff: undefined }), /commits/)
})

test('remapCanvasIds renames every mention of a canvas, and nothing else', () => {
  const b = bundleOf(review, 'see canvas:aaaa1111', canvases, 'mag', { base: 'b1', head: 'h2' })
  const m = remapCanvasIds(b, { aaaa1111: 'n1', bbbb2222: 'n2' })
  assert.deepEqual(m.canvases.map((c) => c.id), ['n1', 'n2'])
  assert.equal((m.canvases[0].diagram as { modules: { links: { to: string }[] }[] }).modules[0].links[0].to, 'n2')
  assert.equal(m.review.prReview.results.v1!.findings[0].node, 'canvas:n1#api')
  assert.equal(m.review.fact!.canvasId, 'n1')
  assert.equal(m.review.doc, 'see canvas:n1')
  assert.equal(m.review.key, 'mag-85')
})

test('an imported review reads its PR from the bundle: outside, at the bundled head, read only', () => {
  const b = bundleOf(review, '# Doc', canvases, 'work mag', { base: 'b1', head: 'h2' }, 9)
  const { task, doc } = importedReview(b, pr, '/imports/x.diff', 10)
  assert.equal(task.prReview.pr.repo, 'mooksel-dev/mag')
  assert.equal(task.prReview.pr.outside, true)
  assert.deepEqual(task.fact!.heads, { 'mooksel-dev/mag': 'h2' })
  assert.deepEqual(task.imported, { from: 'work mag', exportedAt: 9, at: 10, pr, base: 'b1', head: 'h2', diffPath: '/imports/x.diff' })
  assert.equal(doc, '# Doc')
  assert.ok(isImported(task) && !isImported(review))
  assert.throws(() => assertNotImported({ ...task, key: 'k' }, 'run'), /read only/)
})

test('offline leaves no external URL in a page; links keep their text', () => {
  const html = `<link rel="stylesheet" href="https://x.com/a.css"><a href="https://github.com/o/r/pull/1">PR</a><img src='//cdn.x/i.png'>
<div style="background:url(https://x/y.png)">u</div><script>fetch('/x')</script><a href="#card">in page</a><style>@import url("http://x.css");</style>`
  assert.ok(externalUrls(html).length >= 5)
  const out = offline(html)
  assert.deepEqual(externalUrls(out), [])
  assert.match(out, /<a>PR<\/a>/)
  assert.match(out, /href="#card"/)
  assert.doesNotMatch(out, /script/)
})

test('the archive is named <repo>-<n>-review.zip', () => {
  assert.equal(bundleFileName(review.prReview!), 'mag-85-review.zip')
})
