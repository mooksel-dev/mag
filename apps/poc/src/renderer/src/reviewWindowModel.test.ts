import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hunksOf, type ChangeInventory, type IssuesReport, type LegacyReport, type ReviewResult, type Task } from '@mag/core'
import type { FileChange } from '@mag/diff/types'
import type { AppState, FactView } from '../../preload/api'
import { askHunk, hunkCacheFor, paneShowsFact, reviewWindowModel, shownHunks } from './reviewWindowModel.ts'

// A synthetic review of a PR: a legacy v2 report over a two-unit inventory, its fact set of a Component and a Data diagram.
const inventory: ChangeInventory = {
  summary: ['keeps one review per format'],
  units: [
    { id: 'u1', kind: 'method', module: 'core-pr-review', name: 'shownResult', change: 'add', logic: 'trivial', hunks: ['H1.1'] },
    { id: 'u2', kind: 'field', module: 'store', name: 'PrReview.results', stored: true, change: 'add', after: 'Record', hunks: ['H2'] },
  ],
  noise: [],
}
const claim = (text: string, cites: string[]) => ({ text, source: 'agent' as const, cites })
const report: LegacyReport = {
  direction: { decisions: [claim('One result per format', ['u2'])], options: [{ name: 'Results map', tradeoffs: 'simple', pr: true }, { name: 'Two reviews', tradeoffs: 'duplication' }], facts: [], references: [] },
  problem: [{ ...claim('Both are kept', ['u2']), criterion: 'v1 and v2 side by side', status: 'solved' }],
  conventions: [],
  risks: [{ ...claim('Old reviews lose data', ['packages/core/src/pr-review.ts:12']), level: 'low', kind: 'data', mechanism: 'migration' }],
  questions: [],
  changes: [{ title: 'Results per format', why: 'the point', units: ['u1', 'u2'] }],
  checks: 'approve',
}
const result: ReviewResult = { format: 'v2', sessionId: 's1', problem: '', approach: '', verdict: 'approve', findings: [], report, head: 'abc', at: 1 }
const review = {
  id: 'r1', projectId: 'p', key: 'R-1', parentId: null, title: 'mag#85: Results', type: 'review', status: 'in_progress',
  prReview: { pr: { url: 'https://github.com/o/mag/pull/85', number: 85, repo: '/repo', head: 'abc', base: 'main', author: 'a' }, results: { v2: result }, shown: 'v2', posted: null },
} as unknown as Task

const canvas = (id: string, diagram: unknown, extra: object = {}) =>
  ({ id, projectId: 'p', taskId: 'r1', kind: 'diagram', title: id, role: 'fact', version: 1, updatedAt: 0, diagram, ...extra }) as unknown as AppState['canvases'][number]
const canvases = [
  canvas('c1', { type: 'component', modules: [{ id: 'core-pr-review', name: 'PR review', uses: [] }, { id: 'store', name: 'Store', uses: [] }] }, { root: true, inventory }),
  canvas('c2', { type: 'data', entities: [{ id: 'PrReview', name: 'PrReview', fields: [] }], relations: [] }),
]
const files: FileChange[] = [
  { repo: 'mag', path: 'packages/core/src/pr-review.ts', status: 'mod', module: 'core-pr-review', kind: 'code', hunks: [{ id: 'H1', oldStart: 10, oldLines: 2, newStart: 10, newLines: 6 }] },
  { repo: 'mag', path: 'apps/poc/src/main/store.ts', status: 'mod', module: 'store', kind: 'code', hunks: [{ id: 'H2', oldStart: 5, oldLines: 1, newStart: 5, newLines: 3 }] },
  { repo: 'mag', path: 'README.md', status: 'mod', module: null, kind: 'docs', hunks: [{ id: 'H3', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] },
]
const view = { files, fact: { id: 'c1', title: 'c1', version: 1 } } as unknown as FactView

test('a review of a PR: every block in page order, its fact set inline, the full diff by change', () => {
  const m = reviewWindowModel(review, canvases, view)
  assert.equal(m.kind, 'pr')
  assert.deepEqual(m.blocks, ['strip', 'direction', 'questions', 'changes', 'diagrams', 'conclusion', 'diff'])
  assert.deepEqual(m.sets.map((s) => [s.title, s.set.map((c) => c.id)]), [['Fact', ['c1', 'c2']]])
  assert.equal(m.inventory, inventory)
  assert.deepEqual(m.groups.map((g) => [g.title, g.files.map((f) => f.file.path)]), [
    ['Results per format', ['packages/core/src/pr-review.ts', 'apps/poc/src/main/store.ts']],
    ['Not in the inventory', ['README.md']],
  ])
  assert.deepEqual(reviewWindowModel(review, canvases, undefined).groups, [], 'no diff before the fact loads')
})

test('the window expands the hunks of a claim, a diagram node and a change row', () => {
  const m = reviewWindowModel(review, canvases, view)
  const ids = (target: Parameters<typeof hunksOf>[0]) => hunksOf(target, m.inventory, files).map((p) => `${p.hunk.id}${p.blocks ? `.${p.blocks}` : ''}`)
  assert.deepEqual(ids({ kind: 'claim', cites: report.direction.decisions[0].cites }), ['H2'])
  assert.deepEqual(ids({ kind: 'claim', cites: report.risks[0].cites }), ['H1'], 'file:line')
  assert.deepEqual(ids({ kind: 'node', diagram: m.sets[0].set[0].diagram, node: 'core-pr-review' }), ['H1.1'])
  assert.deepEqual(ids({ kind: 'node', diagram: m.sets[0].set[1].diagram, node: 'PrReview' }), ['H2'])
  assert.deepEqual(ids({ kind: 'change', units: report.changes[0].units }), ['H1.1', 'H2'])
})

test('a v1 result shows in the legacy layout; a step shows plan ↔ fact with its plan and fact sets', () => {
  const v1 = { ...review, prReview: { ...review.prReview!, results: { v1: { ...result, format: 'v1', report: undefined } }, shown: 'v1' } } as Task
  assert.deepEqual(reviewWindowModel(v1, canvases, view).blocks, ['legacy', 'diagrams', 'diff'])
  const step = { ...review, id: 'st', type: 'dev', parentId: 'w', prReview: undefined, review: { verdict: 'merge', findings: [], report, round: 1, heads: {}, withContext: false, at: 1 } } as unknown as Task
  const stepCanvases = [
    canvas('p1', { type: 'component', modules: [] }, { taskId: 'w', role: 'plan', stepId: 'st', root: true }),
    canvas('f1', { type: 'component', modules: [] }, { taskId: 'w', role: 'fact', stepId: 'st', root: true, inventory }),
  ]
  const m = reviewWindowModel(step, stepCanvases, view)
  assert.equal(m.kind, 'step')
  assert.deepEqual(m.blocks, ['strip', 'direction', 'questions', 'changes', 'comparison', 'diagrams', 'conclusion', 'diff'])
  assert.deepEqual(m.sets.map((s) => [s.title, s.set.map((c) => c.id)]), [['Plan', ['p1']], ['Fact', ['f1']]])
})

// Today's report (review-v3-concise-design-first.1): issues and evidence, its one diagram.
const issues: IssuesReport = {
  intent: 'Keeps one result per format.',
  checks: 'approve_with_comments',
  why: 'one nit',
  issues: [{ title: 'Old reviews lose their format', impact: 'a v1 review shows as v2', kind: 'data', severity: 'nit', owner: 'author', comment: 'Migrate the format too.', where: 'packages/core/src/pr-review.ts:12' }],
  acceptance: [{ criterion: 'v1 and v2 side by side', source: 'ticket', evidence: 'pr-review.test.ts "both kept"', status: 'met' }],
  verified: ['CI green'],
  notChecked: [],
  follows: 'decision:d1',
  diagram: 'c2',
  conclusion: 'Approve; the nit can go with the next PR.',
}

test('an issues report: intent → issues → acceptance → verified → direction → its one diagram → conclusion → the diff; no inventory groups', () => {
  const withIssues = { ...review, prReview: { ...review.prReview!, results: { v2: { ...result, report: issues } } } } as Task
  const m = reviewWindowModel(withIssues, canvases, view)
  assert.deepEqual(m.blocks, ['intent', 'issues', 'acceptance', 'verified', 'direction', 'diagrams', 'conclusion', 'diff'])
  // Only the set of its diagram, opened on it; never the rest of the fact.
  assert.deepEqual(m.sets.map((s) => [s.title, s.set.map((c) => c.id), s.current]), [['Diagram', ['c1', 'c2'], 'c2']])
  // The diff is reference: one group of every file, not the inventory's changes.
  assert.deepEqual(m.groups.map((g) => [g.title, g.files.length]), [['Files', 3]])
  assert.deepEqual(hunksOf({ kind: 'claim', cites: [issues.issues[0].where!] }, m.inventory, files).map((p) => p.hunk.id), ['H1'], 'an issue expands its file:line')
  // Without a diagram, no fact diagram at all.
  const { diagram: _, ...bare } = issues
  const none = reviewWindowModel({ ...withIssues, prReview: { ...withIssues.prReview!, results: { v2: { ...result, report: bare } } } } as Task, canvases, view)
  assert.deepEqual([none.blocks.includes('diagrams'), none.sets], [false, []])
  // A step keeps its plan ↔ fact and plan diagrams.
  const step = { ...review, id: 'st', type: 'dev', parentId: 'w', prReview: undefined, review: { verdict: 'merge', findings: [], report: bare, round: 1, heads: {}, withContext: false, at: 1 } } as unknown as Task
  const stepCanvases = [
    canvas('p1', { type: 'component', modules: [] }, { taskId: 'w', role: 'plan', stepId: 'st', root: true }),
    canvas('f1', { type: 'component', modules: [] }, { taskId: 'w', role: 'fact', stepId: 'st', root: true, inventory }),
  ]
  const s = reviewWindowModel(step, stepCanvases, view)
  assert.deepEqual(s.blocks, ['intent', 'issues', 'acceptance', 'verified', 'direction', 'comparison', 'diagrams', 'conclusion', 'diff'])
  assert.deepEqual(s.sets.map((x) => x.title), ['Plan'])
})

test('no diagram of the window opens a separate window: the window never calls openWindow, the inline set hides ⧉', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
  assert.doesNotMatch(read('./ReviewWindow.tsx'), /openWindow/)
  assert.match(read('./ReviewWindow.tsx'), /<DiffSetView[^>]*\binline\b/s)
  const set = read('./DiffSetView.tsx')
  const calls = set.split('\n').filter((l) => l.includes('openWindow'))
  assert.ok(calls.length > 0 && calls.every((l) => l.includes('!inline &&')), 'every openWindow of DiffSetView is behind !inline')
})

test('the full diff loads a file\'s hunks only once the file is opened', () => {
  assert.deepEqual(shownHunks(['H1', 'H2'], false), [], 'folded: nothing renders, nothing loads')
  assert.deepEqual(shownHunks(['H1', 'H2'], true), ['H1', 'H2'])
  assert.match(readFileSync(new URL('./ReviewWindow.tsx', import.meta.url), 'utf8'), /shownHunks\(hunks, open \|\| still\)/, 'DiffFile renders through shownHunks; a static page has every hunk')
})

test('a hunk loads once per fact view, and again after the view refreshes', () => {
  const v1 = { at: 1 }
  const v2 = { at: 2 }
  const cache = hunkCacheFor(null, v1)
  assert.equal(askHunk(cache, 'k'), true)
  assert.equal(askHunk(cache, 'k'), false, 'asked already: loading')
  assert.equal(hunkCacheFor(cache, v1), cache, 'the same view keeps its cache')
  const next = hunkCacheFor(cache, v2)
  assert.notEqual(next, cache)
  assert.equal(next.lines.get('k'), undefined, 'the refreshed view does not wait on the old load')
  assert.equal(askHunk(next, 'k'), true, 'so the open hunk loads again')
})

test('the static page and an imported review have no run, direction buttons, drawer or IPC (review-v2-part-2-v1-2.3)', () => {
  const src = readFileSync(new URL('./ReviewWindow.tsx', import.meta.url), 'utf8')
  assert.match(src, /const ro = isImported\(task\) \|\| !!still/)
  assert.match(src, /\{!still && pr && review && <ReviewMenu/, 'no v1/v2 switch, Run or Export on the static page')
  assert.match(src, /direction=\{pr && !ro \?/, 'no direction buttons when read only')
  assert.match(src, /\{drawer && !ro && <ChatDrawer/, 'no agent drawer when read only')
  assert.match(src, /if \(still\) return <StaticDiagrams/, 'diagrams as their SVGs, never DiffSetView')
  assert.match(src, /if \(!task \|\| still\) return/, 'the fact view is not fetched for a static page')
  const reviews = readFileSync(new URL('./Reviews.tsx', import.meta.url), 'utf8')
  assert.match(reviews, /direction=\{ro \? undefined/, 'the right pane: no direction buttons on an imported review')
  assert.match(reviews, /r\.verdict && !ro && <Publish/, 'nor Publish')
})

test('the report reads intent first and conclusion last; a report without them shows neither', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
  const view = read('./ReportView.tsx')
  assert.match(view, /<div className="report">\s*<ReportIntent report=\{report\} \/>\s*<div className="reportstrip">/)
  assert.match(view, /\{children\}\s*\{conclusion && <ReportConclusion report=\{report\} \/>\}\s*<\/div>/)
  assert.match(view, /return report\.intent \?[^\n]*: null/)
  assert.match(view, /return report\.conclusion \?[^\n]*: null/)
  const win = read('./ReviewWindow.tsx')
  assert.match(win, /conclusion=\{false\}/)
  assert.match(win, /\{model\.report && <ReportConclusion report=\{model\.report\} \/>\}\s*<FoldedDiff[\s\S]*<\/FoldedDiff>\s*<\/main>/, 'the window: the conclusion last to read, the folded diff after it as reference')
  // Today's report reads the same way: intent first, conclusion last.
  assert.match(view, /<div className="report">\s*<section className="reportcard verdictcard">/)
  assert.match(view, /\{children\}\s*\{conclusion && <ReportConclusion report=\{report\} \/>\}\s*<\/div>\s*\)\s*\}\s*\/\*\*\s*\* A report from before/)
})

test('a review panel\'s header: one line (PR · author → base · tickets · CI), the status in words, Open review, the rest in ⋯ (review-v3-concise-design-first.1)', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
  const reviews = read('./Reviews.tsx')
  const head = reviews.slice(reviews.indexOf('<div className="taskrow reviewhead">'))
  const order = ['{repo}#{review.pr.number} ↗', '· @{review.pr.author} → {review.pr.base} ·', '<TicketLinks task={work} />', '<Checks work={work} />', '{!firstRun && ', '>Open review</button>', '<ReviewMenu ']
  const at = order.map((x) => head.indexOf(x))
  assert.ok(at.every((i) => i >= 0), `every part in the header: ${order.filter((_, i) => at[i] < 0)}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in this order')
  assert.ok(head.indexOf('<ReviewMenu ') < head.indexOf('</div>\n      {error'), 'all in the one line')
  assert.doesNotMatch(reviews, /<h1>\{shortTitle\(work\)\}<\/h1>/, 'the title once: the panel\'s header has it')
  assert.doesNotMatch(reviews, /<FormatSwitch|<ExportReviewButton|>\s*Delete review\s*</, 'no big action buttons above the content')
  // The actions live in the menu.
  const menu = reviews.slice(reviews.indexOf('export function ReviewMenu'))
  for (const item of ["'Review again' : 'Reopen review'", 'Show {f}', 'Run {f}', 'Export review', 'Close review', 'Delete review…']) assert.ok(menu.includes(item), item)
  // The panel has no review stepper: the status is words.
  const pane = read('./ArtifactPane.tsx')
  assert.doesNotMatch(pane, /REVIEW_STAGES/)
  assert.match(pane, /status=\{reviewStatus\(work, state\.sessions, now\)\}/)
  // Its first run: one status line, nothing about fact, inventory or findings; "reviewing" said once.
  assert.match(reviews, /\{firstRun \? \(\s*<ReviewRunLine status=\{status\} \/>\s*\) : r\.report \?/)
  assert.match(reviews, /\{!firstRun && <span className="muted small reviewstatus"/)
  assert.doesNotMatch(reviews, /The agent is reviewing/)
  // The verdict big, the intent right below it; the direction only when the report lays one out.
  const view = read('./ReportView.tsx')
  assert.match(view, /<section className="reportcard verdictcard">\s*<div className="cardhead">\s*<span className=\{`verdict [^\n]*\n\s*\{kind === 'pr' && report\.direction && [^\n]*Direction: your call[^\n]*\n\s*<\/div>\s*<p className="intent">\{report\.intent\}<\/p>/)
})

test("a PR review's pane shows the inventory and fact diagrams only for a legacy report (review-v3-concise-design-first.3)", () => {
  assert.equal(paneShowsFact(issues), false, 'an issues report: its one diagram, the inventory stays internal')
  assert.equal(paneShowsFact({ checks: 'look', direction: { decisions: [], options: [], facts: [], references: [] }, problem: [], conventions: [], risks: [], questions: [], changes: [] } as LegacyReport), true)
  assert.equal(paneShowsFact(undefined), true, 'a v1 result without a report keeps its fact')
})
