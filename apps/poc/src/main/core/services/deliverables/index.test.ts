import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceFiles } from '../../clients/workspace-files/index.ts'
import { createDeliverables, slugOf, type Deliverable, type Origin } from './index.ts'

const origin: Origin = { workspaceId: 'w1', folder: 'personal', projectId: 'p1', topicId: 't1', taskId: null }
const slack = { kind: 'slack' as const, target: 'C1', label: 'Slack C1' }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mag-dlv-'))
  const rows: Deliverable[] = []
  let t = 1000
  const dlv = createDeliverables({
    files: createWorkspaceFiles(() => root),
    records: {
      all: () => rows,
      put: (d) => {
        const i = rows.findIndex((x) => x.id === d.id)
        if (i < 0) rows.push(d)
        else rows[i] = d
      },
      remove: (id) => void rows.splice(rows.findIndex((x) => x.id === id), 1),
    },
    now: () => ++t,
  })
  return { root, rows, dlv }
}

test('save: creates a deliverable with v1.md and returns its ref; the next save adds v2', () => {
  const { root, dlv } = setup()
  const first = dlv.save({ kind: 'report', title: 'Weekly DBO report', md: '# W1' }, origin)
  assert.equal(first.ref, 'personal:dlv:weekly-dbo-report')
  assert.equal(first.n, 1)
  assert.equal(first.path, join(root, 'personal', 'deliverables', 'weekly-dbo-report', 'v1.md'))
  assert.equal(first.deliverable.state, 'draft')
  assert.equal(first.deliverable.sensitivity, 'work')
  const second = dlv.save({ ref: 'dlv:weekly-dbo-report', md: '# W1 fixed', labels: ['Aura', ' aura ', ''] }, origin)
  assert.equal(second.n, 2)
  assert.deepEqual(second.deliverable.labels, ['Aura', 'aura'])
  assert.equal(dlv.read(first.deliverable.id), '# W1 fixed\n')
  assert.equal(dlv.read(first.deliverable.id, 1), '# W1\n')
  assert.equal(dlv.list().length, 1)
})

test('save: a second deliverable of the same title gets its own folder; bad input saves nothing', () => {
  const { rows, dlv } = setup()
  dlv.save({ kind: 'report', title: 'Weekly', md: 'a' }, origin)
  assert.equal(dlv.save({ kind: 'report', title: 'Weekly', md: 'b' }, origin).ref, 'personal:dlv:weekly-2')
  assert.throws(() => dlv.save({ kind: 'memo', title: 'X', md: 'a' }, origin), /kind must be one of/)
  assert.throws(() => dlv.save({ kind: 'report', md: 'a' }, origin), /needs a title/)
  assert.throws(() => dlv.save({ kind: 'report', title: 'X', md: '  ' }, origin), /needs its text/)
  assert.throws(() => dlv.save({ ref: 'dlv:weekly', kind: 'reply', md: 'a' }, origin), /its kind stays/)
  assert.throws(() => dlv.save({ ref: 'other:dlv:weekly', md: 'a' }, origin), /No deliverable other:dlv:weekly/)
  assert.throws(() => dlv.save({ ref: 'weekly', md: 'a' }, origin), /Not a deliverable ref/)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].versions.length, 1)
  assert.equal(dlv.save({ kind: 'assessment', title: 'Dev A', md: 'x' }, origin).deliverable.sensitivity, 'people')
})

test('markFinal, then a new version: back to draft; the final pointer stays on the version marked', () => {
  const { dlv } = setup()
  const { deliverable: d } = dlv.save({ kind: 'reply', title: 'Answer', md: 'v1' }, origin)
  dlv.save({ ref: dlv.refOf(d), md: 'v2' }, origin)
  assert.throws(() => dlv.markFinal(d.id, 3), /no version 3/)
  assert.equal(dlv.markFinal(d.id, 1).state, 'final')
  assert.equal(dlv.read(d.id), 'v1\n')
  dlv.save({ ref: dlv.refOf(d), md: 'v3' }, origin)
  assert.equal(dlv.get(d.id).state, 'draft')
  assert.equal(dlv.get(d.id).finalVersion, 1)
  assert.equal(dlv.read(d.id), 'v3\n')
})

test('draft opens v1 with the brief and its refs', () => {
  const { dlv } = setup()
  const d = dlv.draft('agenda', 'DBO sync agenda\nfor Monday', ['personal:dlv:weekly', 'PR #12'], origin)
  assert.equal(d.title, 'DBO sync agenda')
  assert.equal(d.kind, 'agenda')
  assert.equal(d.state, 'draft')
  assert.match(dlv.read(d.id), /^# DBO sync agenda\n\n> Draft\. Brief: DBO sync agenda for Monday\n\n## Sources\n- personal:dlv:weekly\n- PR #12\n$/)
  assert.throws(() => dlv.draft('agenda', ' ', [], origin), /needs a brief/)
  assert.deepEqual(d.labels, [])
  assert.deepEqual(dlv.draft('report', 'Ups & Downs', [], origin, [' Data Removal ', 'Money Problems']).labels, ['Data Removal', 'Money Problems'])
})

test('lastFinal: the latest final or published one of the kind with every label', () => {
  const { dlv } = setup()
  const mk = (title: string, labels: string[], kind: 'report' | 'reply' = 'report') => dlv.save({ kind, title, md: title, labels }, origin).deliverable
  const a = mk('A', ['Aura', 'weekly'])
  const b = mk('B', ['aura', 'weekly'])
  const c = mk('C', ['Aura'])
  const r = mk('R', ['Aura', 'weekly'], 'reply')
  assert.equal(dlv.lastFinal('report', ['Aura']), null)
  dlv.markFinal(a.id, 1)
  dlv.markFinal(c.id, 1)
  dlv.markFinal(r.id, 1)
  assert.equal(dlv.lastFinal('report', ['aura', 'weekly'])?.id, a.id)
  dlv.markFinal(b.id, 1)
  assert.equal(dlv.lastFinal('report', ['Aura', 'weekly'])?.id, b.id)
  assert.equal(dlv.lastFinal('report', [])?.id, b.id)
  dlv.markPublished(a.id, slack)
  assert.equal(dlv.lastFinal('report', ['weekly'])?.id, a.id)
  assert.equal(dlv.lastFinal('report', ['weekly'], 'w2'), null)
  dlv.save({ ref: dlv.refOf(a), md: 'again' }, origin)
  assert.equal(dlv.lastFinal('report', ['weekly'])?.id, b.id)
})

test('publish: only a final one; an allowed write in the session asked publishes it there', () => {
  const { dlv } = setup()
  const { deliverable: d } = dlv.save({ kind: 'reply', title: 'Answer', md: 'v1' }, origin)
  assert.throws(() => dlv.requestPublish(d.id, 's1'), /mark a version final first/)
  assert.throws(() => dlv.markPublished(d.id, slack), /only a final deliverable/)
  dlv.markFinal(d.id, 1)
  dlv.requestPublish(d.id, 's1')
  assert.deepEqual(dlv.writeAllowed('s2', slack), [])
  const [published] = dlv.writeAllowed('s1', slack)
  assert.equal(published.state, 'published')
  assert.deepEqual(published.destination, slack)
  assert.equal(published.publishing, null)
  assert.ok(published.publishedAt)
  assert.deepEqual(dlv.writeAllowed('s1', slack), [])
})

test('a deleted folder drops the deliverable from lists without errors; reading it says it is gone', () => {
  const { root, rows, dlv } = setup()
  const { deliverable: d } = dlv.save({ kind: 'report', title: 'Gone soon', md: 'x' }, origin)
  const kept = dlv.save({ kind: 'report', title: 'Kept', md: 'y' }, origin).deliverable
  dlv.markFinal(d.id, 1)
  rmSync(join(root, 'personal', 'deliverables', 'gone-soon'), { recursive: true })
  assert.equal(dlv.lastFinal('report', []), null)
  assert.deepEqual(dlv.list().map((x) => x.id), [kept.id])
  assert.deepEqual(rows.map((x) => x.id), [kept.id])
  assert.throws(() => dlv.read(d.id), /No deliverable/)
  rmSync(join(root, 'personal', 'deliverables', 'kept'), { recursive: true })
  assert.throws(() => dlv.read(kept.id), /is gone: its folder .* was deleted/)
  assert.deepEqual(dlv.list(), [])
})

test('list filters by project, topics, kind, state and labels', () => {
  const { dlv } = setup()
  const a = dlv.save({ kind: 'report', title: 'A', md: 'a', labels: ['x'] }, origin).deliverable
  const b = dlv.save({ kind: 'reply', title: 'B', md: 'b' }, { ...origin, projectId: 'p2', topicId: 't2' }).deliverable
  assert.deepEqual(dlv.list({ projectId: 'p2' }).map((d) => d.id), [b.id])
  assert.deepEqual(dlv.list({ topicIds: ['t1'] }).map((d) => d.id), [a.id])
  assert.deepEqual(dlv.list({ kind: 'reply' }).map((d) => d.id), [b.id])
  assert.deepEqual(dlv.list({ labels: ['X'] }).map((d) => d.id), [a.id])
  assert.deepEqual(dlv.list({ state: ['final'] }), [])
})

test('slugOf: lowercase, accents and symbols out, ≤ 40 characters', () => {
  assert.equal(slugOf('Café — Q4 plan!'), 'cafe-q4-plan')
  assert.equal(slugOf('Звіт за тиждень'), 'звіт-за-тиждень')
  assert.equal(slugOf('***'), 'deliverable')
  assert.ok(slugOf('a'.repeat(60)).length <= 40)
})

test('a bare ref resolves in the workspace by id: a renamed workspace keeps its deliverables', () => {
  const { dlv } = setup()
  dlv.save({ kind: 'report', title: 'Weekly', md: 'a' }, origin)
  const renamed = { ...origin, folder: 'personal-renamed' }
  const next = dlv.save({ ref: 'dlv:weekly', md: 'b' }, renamed)
  assert.equal(next.ref, 'personal:dlv:weekly')
  assert.equal(next.n, 2)
  assert.throws(() => dlv.resolve('dlv:weekly', 'w2'), /No deliverable dlv:weekly/)
  assert.equal(dlv.resolve('personal:dlv:weekly').id, next.deliverable.id)
})

function withResolver() {
  const s = setup()
  const resolved: string[] = []
  const dlv = createDeliverables({
    files: createWorkspaceFiles(() => s.root),
    records: { all: () => s.rows, put: (d) => void (s.rows.some((x) => x.id === d.id) ? s.rows.splice(s.rows.findIndex((x) => x.id === d.id), 1, d) : s.rows.push(d)), remove: (id) => void s.rows.splice(s.rows.findIndex((x) => x.id === id), 1) },
    resolveRef: (kind, ref) => (resolved.push(`${kind} ${ref}`), ref.includes('gone') ? 'no such meeting' : null),
  })
  return { ...s, dlv, resolved }
}

const MD = 'The team merged 34 PRs. The queue is faster. Olena led the DBR change. It reads well.'

test('setClaims: each claim is checked; missing refs, a count without a query, an unresolved ref and a person claim without a primary source are flagged', () => {
  const { dlv, resolved } = withResolver()
  const d = dlv.save({ kind: 'report', title: 'Q4', md: MD }, origin).deliverable
  dlv.save({ kind: 'report', title: 'Prior', md: 'x' }, origin)
  const check = dlv.setClaims(d.id, 1, [
    { text: 'merged 34 PRs', kind: 'count', refs: ['https://github.com/o/r/pulls'] },
    { text: 'The queue is faster', kind: 'fact', refs: [] },
    { text: 'Olena led the DBR change', kind: 'fact', refs: ['mtg:2026-11-20-dbo'], person: 'Olena' },
    { id: 'tone', text: 'It reads well', kind: 'opinion', refs: ['mtg:gone@10:02', 'nonsense', 'dlv:prior'] },
  ])
  assert.deepEqual(check.claims.map((c) => [c.id, c.check]), [['c1', 'no_query'], ['c2', 'missing_ref'], ['c3', 'weak_source'], ['tone', 'unresolved']])
  assert.match(check.claims[3].why!, /mtg:gone@10:02: no such meeting; nonsense: not a ref/)
  assert.equal(check.failed.length, 4)
  assert.deepEqual(resolved, ['meeting mtg:2026-11-20-dbo', 'transcript mtg:gone@10:02'])

  const ok = dlv.setClaims(d.id, 1, [
    { text: 'merged 34 PRs', kind: 'count', refs: ['https://github.com/o/r/pulls'], query: 'gh pr list --state merged | wc -l' },
    { text: 'Olena led the DBR change', kind: 'fact', refs: ['o/r#301', 'mtg:2026-11-20-dbo'], person: 'Olena' },
  ])
  assert.deepEqual(ok.failed, [])
  assert.deepEqual(dlv.claimsOf(d.id, 1).map((c) => c.id), ['c1', 'c2'], 'set_claims replaces the ledger')
})

test('setClaims: a people-sensitive deliverable needs a primary source for every claim; bad input records nothing', () => {
  const { dlv } = withResolver()
  const d = dlv.save({ kind: 'assessment', title: 'Dev A', md: MD }, origin).deliverable
  const check = dlv.setClaims(d.id, 1, [
    { text: 'The queue is faster', kind: 'fact', refs: ['https://example.com/dashboard'] },
    { text: 'It reads well', kind: 'opinion', refs: ['https://acme.slack.com/archives/C01/p1700000000'] },
    { text: 'merged 34 PRs', kind: 'count', refs: ['PRVP-12'], query: 'project = PRVP' },
  ])
  assert.deepEqual(check.claims.map((c) => c.check), ['weak_source', 'ok', 'ok'])
  assert.throws(() => dlv.setClaims(d.id, 1, [{ text: 'not in it', kind: 'fact', refs: ['PRVP-1'] }]), /not in the version's text/)
  assert.throws(() => dlv.setClaims(d.id, 1, [{ text: 'It reads well', kind: 'vibe', refs: [] }]), /kind must be one of/)
  assert.throws(() => dlv.setClaims(d.id, 1, [{ id: 'a', text: 'It reads well', kind: 'fact' }, { id: 'a', text: 'merged 34 PRs', kind: 'fact' }]), /id a is repeated/)
  assert.throws(() => dlv.setClaims(d.id, 2, []), /has no version 2/)
  assert.equal(dlv.claimsOf(d.id, 1).length, 3)
})

test('setVerdict: only the verifier mag started sets it; the draft goes in review; new claims drop it', () => {
  const { dlv } = withResolver()
  const d = dlv.save({ kind: 'report', title: 'Q4', md: MD }, origin).deliverable
  assert.throws(() => dlv.claimsOf(d.id, 1), /set_claims first/)
  dlv.setClaims(d.id, 1, [{ text: 'merged 34 PRs', kind: 'count', refs: ['o/r#1'], query: 'gh' }])
  assert.throws(() => dlv.setVerdict(d.id, 1, { verdict: 'publish' }, 's1'), /Only the verifier/)
  dlv.beginVerify(d.id, 1, 's1', false)
  assert.throws(() => dlv.setVerdict(d.id, 1, { verdict: 'publish' }, 's2'), /Only the verifier/)
  assert.throws(() => dlv.setVerdict(d.id, 1, { verdict: 'ship' }, 's1'), /verdict must be one of/)
  assert.throws(() => dlv.setVerdict(d.id, 1, { verdict: 'changes', findings: [{ claimId: 'c9', text: 'x', level: 'blocker' }] }, 's1'), /No claim c9/)
  assert.equal(dlv.get(d.id).state, 'draft', 'a refused verdict changes nothing')
  const after = dlv.setVerdict(d.id, 1, { verdict: 'changes', findings: [{ claimId: 'c1', text: 'The query counts open PRs too', level: 'blocker' }] }, 's1')
  assert.equal(after.state, 'in_review')
  assert.deepEqual(after.versions[0].verdict, { verdict: 'changes', findings: [{ claimId: 'c1', text: 'The query counts open PRs too', level: 'blocker' }], verifierSessionId: 's1', fresh: false, at: after.versions[0].verdict!.at })
  assert.equal(after.verifying, null)
  assert.throws(() => dlv.setVerdict(d.id, 1, { verdict: 'publish' }, 's1'), /Only the verifier/, 'one verdict per start')

  dlv.setClaims(d.id, 1, [{ text: 'merged 34 PRs', kind: 'count', refs: ['o/r#1'], query: 'gh pr list --state merged' }])
  assert.equal(dlv.get(d.id).versions[0].verdict, null)
  assert.equal(dlv.get(d.id).state, 'draft')

  // A verdict on an older version keeps the newer draft a draft.
  dlv.beginVerify(d.id, 1, 's3', true)
  dlv.save({ ref: 'dlv:q4', md: MD + ' More.' }, origin)
  const old = dlv.setVerdict(d.id, 1, { verdict: 'publish' }, 's3')
  assert.equal(old.state, 'draft')
  assert.equal(old.versions[0].verdict!.fresh, true)
})
