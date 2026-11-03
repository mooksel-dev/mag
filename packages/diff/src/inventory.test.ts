import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChangeInventory, InventoryUnit } from '@mag/core'
import { formatHunks } from './format.ts'
import { checkInventory, formatInventoryCheck, hunkBlocks, inventoryBlockers, numberHunks } from './inventory.ts'
import type { FileChange, Hunk } from './types.ts'

const hunk = (header: string, lines: string[]): Hunk => ({ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, header, lines })
const file = (path: string, module: string | null, hunks: Hunk[], extra: Partial<FileChange> = {}): FileChange => ({ path, status: 'mod', repo: 'mag', module, kind: 'code', hunks, ...extra })

// Two files of two modules: a method whose body changes (named only by the context), a new function, a prompt
// constant, a test.
const FILES = numberHunks([
  file('apps/poc/src/main/orchestrator.ts', 'orchestrator', [
    hunk('export class Orchestrator {', ['   async factOf(stepId: string) {', '     const step = this.store.task(stepId)', '-    return old(step)', '+    return check(step)', '   }', '+  // a comment', ' ']),
    hunk('export class Orchestrator {', ['+export function seedless(of: string): void {', '+  return', '+}']),
  ]),
  file('packages/core/src/playbook.ts', 'core-playbook', [hunk('export const DEFAULT_PLAYBOOK: Playbook = {', ['   fact: `The fact is', '-the old text', '+the new text', ' and more'])]),
  file('apps/poc/src/main/orchestrator.test.ts', 'orchestrator', [hunk('', ['+test()'])], { kind: 'test' }),
])

// A changed method says its old and new signature and what changes in it (diff-iak-inventar-zmin-ai.2): `…` adds no name.
const unit = (u: Partial<InventoryUnit> & Pick<InventoryUnit, 'id' | 'name' | 'hunks'>): InventoryUnit => ({ kind: 'method', module: 'orchestrator', change: 'mod', logic: 'nontrivial', before: '…', after: '…', note: 'n', ...u })
const inv = (units: InventoryUnit[], noise: ChangeInventory['noise'] = []): ChangeInventory => ({ summary: ['s'], units, noise })

test('numberHunks / hunkBlocks: hunk ids in diff order across files, a block per run of changed lines', () => {
  assert.deepEqual(FILES.flatMap((f) => f.hunks.map((h) => h.id)), ['H1', 'H2', 'H3', 'H4'])
  assert.deepEqual(hunkBlocks(FILES).map((b) => [b.id, b.lines.length, b.module, b.kind]), [
    ['H1.1', 2, 'orchestrator', 'code'],
    ['H1.2', 1, 'orchestrator', 'code'],
    ['H2.1', 3, 'orchestrator', 'code'],
    ['H3.1', 2, 'core-playbook', 'code'],
    ['H4.1', 1, 'orchestrator', 'test'],
  ])
})

test('checkInventory: a full inventory has no blockers; context, a config constant and a hunk id ground its units', () => {
  const full = inv(
    [
      unit({ id: 'u1', name: 'Orchestrator.factOf', hunks: ['H1.1'] }),
      unit({ id: 'u2', name: 'seedless', change: 'add', hunks: ['H2'], logic: 'trivial' }),
      unit({ id: 'u3', kind: 'config', module: 'core-playbook', name: 'DEFAULT_PLAYBOOK.fact', hunks: ['H3.1'] }),
    ],
    [{ hunks: ['H1.2'], reason: 'comment' }],
  )
  const check = checkInventory(full, FILES)
  assert.deepEqual(inventoryBlockers(check), [])
  assert.deepEqual([check.blocks, check.codeBlocks, check.units], [5, 4, 3])
  assert.deepEqual(check.noiseClaims, [], 'a comment is noise')
  assert.deepEqual(check.undeclared, [])
  assert.match(formatInventoryCheck(check), /Every block of changed code is in a unit or noise/)
})

test('checkInventory: blocks in no unit, unknown ids, names the hunks do not bear out, units on another module', () => {
  const check = checkInventory(
    inv([
      unit({ id: 'u1', name: 'review', hunks: ['H1.1', 'H9.1'] }),
      unit({ id: 'u2', name: 'seedless', module: 'core-playbook', change: 'add', hunks: ['H2.1'] }),
      unit({ id: 'u3', name: 'fact', kind: 'config', module: 'core-playbook', hunks: ['H7'] }),
      unit({ id: 'u4', kind: 'dependency', name: 'git', hunks: ['H1.1'] }),
    ]),
    FILES,
  )
  assert.deepEqual(check.unaccounted.map((b) => b.id), ['H1.2', 'H3.1'], 'a test block need not be cited')
  assert.deepEqual(check.unknown, [{ id: 'H9.1', by: 'u1' }, { id: 'H7', by: 'u3' }])
  assert.deepEqual(check.ungrounded.map((u) => [u.unit, u.why]), [['u1', 'review is not in its hunks'], ['u3', 'none of its hunks exists']], 'a dependency is checked for its blocks only')
  assert.deepEqual(check.otherModule.map((u) => [u.unit, u.module, u.hunkModules]), [['u2', 'core-playbook', ['orchestrator']]])
  assert.deepEqual(check.undeclared.map((d) => [d.block, d.name]), [['H2.1', 'seedless']], 'a unit of another module does not name it')
  assert.equal(inventoryBlockers(check).length, 7)
  assert.match(inventoryBlockers(check)[0], /^H1\.2 \(mag:apps\/poc\/src\/main\/orchestrator\.ts, orchestrator\) is changed code in no unit/)
})

test('checkInventory: a rename needs both names; the base name of its file grounds a template; code called noise warns', () => {
  const files = numberHunks([
    file('src/a.go', 'jobs', [hunk('func (r *Repo) Send(ctx context.Context) error {', ['-\tsendNow(ctx)', '+\tdeliver(ctx)'])]),
    file('prompts/review.md.tmpl', 'prompts', [hunk('', ['+Review it.'])]),
  ])
  const rename = (from: string) => unit({ id: 'u1', module: 'jobs', name: 'deliver', change: 'rename', from, hunks: ['H1.1'] })
  assert.deepEqual(checkInventory(inv([rename('sendNow')]), files).ungrounded, [])
  assert.deepEqual(checkInventory(inv([rename('push')]), files).ungrounded.map((u) => u.why), ['push is not in its hunks'])
  const tmpl = (name: string) => unit({ id: 'u2', kind: 'template', module: 'prompts', name, hunks: ['H2.1'] })
  assert.deepEqual(checkInventory(inv([rename('sendNow'), tmpl('review')]), files).ungrounded, [])
  assert.deepEqual(checkInventory(inv([rename('sendNow'), tmpl('prompts/review')]), files).ungrounded, [], 'by the last segment of its name')
  assert.deepEqual(checkInventory(inv([rename('sendNow'), tmpl('view')]), files).ungrounded.map((u) => u.why), ['view is not in its hunks'], 'a substring of the path is not its file')
  assert.deepEqual(checkInventory(inv([rename('sendNow'), tmpl('prompts')]), files).ungrounded.map((u) => u.why), ['prompts is not in its hunks'], 'a folder is not its file')
  const noisy = checkInventory(inv([], [{ hunks: ['H1', 'H2'], reason: 'formatting' }]), files)
  assert.deepEqual(noisy.unaccounted, [])
  assert.deepEqual(noisy.noiseClaims.map((n) => [n.block, n.lines]), [['H1.1', 2], ['H2.1', 1]])
})

test('checkInventory: declarations in changed lines no unit of their module names are warnings', () => {
  const files = numberHunks([
    file('svc/a.go', 'jobs', [hunk('', ['+func (r *Repo) Save(ctx context.Context) error {', '+type Job struct {', '+\tSentAt time.Time `bson:"sent_at"`'])]),
    file('app/b.py', 'api', [hunk('class Api:', ['+    def save(self):', '+    async def load(self):'])]),
    file('web/c.ts', 'web', [hunk('', ['+export const useJobs = (id: string) => {', '+  render(): void', '+export interface Jobs {'])]),
  ])
  const units = [unit({ id: 'u1', module: 'jobs', name: 'Save', change: 'add', hunks: ['H1.1'] }), unit({ id: 'u2', module: 'web', name: 'save', change: 'add', hunks: ['H3.1'] })]
  const check = checkInventory(inv(units), files)
  assert.deepEqual(check.undeclared.map((d) => [d.block, d.name]), [['H1.1', 'Job'], ['H2.1', 'save'], ['H2.1', 'load'], ['H3.1', 'useJobs'], ['H3.1', 'render'], ['H3.1', 'Jobs']], 'save of web does not cover api')
  assert.deepEqual(inventoryBlockers(check), ['H2.1 (mag:app/b.py, api) is changed code in no unit and not in noise', 'unit u2 (save): save is not in its hunks'], 'warnings never block')
})

test('formatHunks: code hunks with ids, blocks marked before their lines, context kept; other files only named', () => {
  const text = formatHunks(FILES)
  assert.match(text, /^### H1 {2}mag:apps\/poc\/src\/main\/orchestrator\.ts {2}\[module: orchestrator\] {2}@@ -10,3 \+10,3 @@ export class Orchestrator \{\n {3}async factOf/)
  assert.match(text, /\n {5}const step = this\.store\.task\(stepId\)\n\[H1\.1\]\n- {4}return old\(step\)\n\+ {4}return check\(step\)\n {3}\}\n\[H1\.2\]\n\+ {2}\/\/ a comment/)
  assert.match(text, /\nNot code, need not be cited: mag:apps\/poc\/src\/main\/orchestrator\.test\.ts \(test: H4\)$/)
  assert.doesNotMatch(text, /test\(\)/)
})

test('checkInventory: a config unit deep in a long constant is borne out by the constant named in a hunk of its file', () => {
  const files = numberHunks([
    file('packages/core/src/playbook.ts', 'core-playbook', [
      hunk('', ['+import { X } from "./x"', ' export const DEFAULT_PLAYBOOK: Playbook = {']),
      hunk('have done it: no diagram of your own design', ['   and the agreement it is about', '-otherwise.', '+otherwise, with CODE_CHECKS.']),
    ]),
    file('packages/core/src/other.ts', 'core-playbook', [hunk('', ['+prose'])]),
  ])
  const unit_ = (name: string, hunks: string[]) => unit({ id: 'u1', kind: 'config', module: 'core-playbook', name, hunks })
  assert.deepEqual(checkInventory(inv([unit_('DEFAULT_PLAYBOOK.prReview', ['H2.1'])]), files).ungrounded, [])
  assert.deepEqual(checkInventory(inv([unit_('OTHER.prReview', ['H2.1'])]), files).ungrounded.map((u) => u.why), ['prReview is not in its hunks'])
  assert.deepEqual(checkInventory(inv([unit_('DEFAULT_PLAYBOOK.x', ['H3.1'])]), files).ungrounded.map((u) => u.why), ['x is not in its hunks'], 'another file does not count')
})

test('formatHunks: at most about maxChars of whole hunks, then the ids of the rest; lock and generated files left out', () => {
  const files = numberHunks([
    file('src/a.ts', 'a', [hunk('', ['+'.padEnd(60, 'a')]), hunk('', ['+'.padEnd(60, 'b')]), hunk('', ['+'.padEnd(60, 'c')])]),
    file('pnpm-lock.yaml', null, [hunk('', ['+x'])], { kind: 'lock' }),
    file('dist/a.js', null, [hunk('', ['+x'])], { kind: 'generated' }),
    file('README.md', null, [hunk('', ['+x'])], { kind: 'docs' }),
  ])
  const all = formatHunks(files)
  assert.match(all, /### H3 /)
  assert.match(all, /\nNot code, need not be cited: mag:README\.md \(docs: H6\)$/)
  assert.doesNotMatch(all, /pnpm-lock|dist\/a\.js/)
  const cut = formatHunks(files, 250)
  assert.match(cut, /### H2 /)
  assert.doesNotMatch(cut, /### H3 /)
  assert.match(cut, /\n1 more hunk\(s\) not listed here \(H3\): get_pr_changes lists them all\./)
  assert.match(formatHunks(files, 10), /^### H1 [\s\S]*2 more hunk\(s\) not listed here \(H2…H3\)/, 'one hunk at least')
})

test('checkInventory: a renamed template is its file, with or without the extension; its old name the old path\'s', () => {
  const files = numberHunks([
    file('templates/removal-request.tpl', 'templates', [hunk('', ['-Dear {{.Name}},', '+Hello {{.Name}},'])], { status: 'rename', oldPath: 'templates/cleanup-request.tpl' }),
    file('mail/notice.tpl', 'mail', [hunk('', ['+Hi'])], { status: 'rename', oldPath: 'mail/letter.tpl' }),
  ])
  const rename = (name: string, from: string, module = 'templates', hunks = ['H1.1']) => unit({ id: 'u1', kind: 'template', module, name, change: 'rename', from, hunks })
  const why = (u: InventoryUnit) => checkInventory(inv([u]), files).ungrounded.map((x) => x.why)
  assert.deepEqual(why(rename('removal-request.tpl', 'cleanup-request.tpl')), [])
  assert.deepEqual(why(rename('removal-request', 'cleanup-request')), [], 'without the extension')
  assert.deepEqual(why(rename('templates/removal-request.tpl', 'templates/cleanup-request.tpl')), [], 'with its folder')
  assert.deepEqual(why(rename('notice.tpl', 'letter.tpl', 'mail', ['H2.1'])), [], 'a name without a dash is a file when it is the file')
  assert.deepEqual(why(rename('removal-request.tpl', 'other-request.tpl')), ['other-request.tpl is not in its hunks'], 'the old name is the old path\'s')
  assert.deepEqual(why(rename('cleanup-request.tpl', 'removal-request.tpl')), ['cleanup-request.tpl, removal-request.tpl is not in its hunks'], 'not the other way round')
})

test('checkInventory: a call is borne out by its method in its hunks; its target is a module unless it says external (diff-iak-inventar-zmin-ai.2)', () => {
  const files = numberHunks([
    file('svc/accounts.go', 'digital_accounts', [hunk('func (s *Service) RequestRemoval(ctx context.Context, id string) error {', ['+\tif err := s.jobs.Ensure(ctx, key); err != nil {', '+\t\treturn err', '+\t}', '+\ts.mail.SendEmail(ctx, p)'])]),
  ])
  const call = (id: string, name: string, extra: Partial<InventoryUnit> = {}) => unit({ id, kind: 'call', module: 'digital_accounts', name, change: 'add', hunks: ['H1.1'], ...extra })
  const ok = inv([
    unit({ id: 'u1', module: 'digital_accounts', name: 'RequestRemoval', before: 'RequestRemoval(ctx, id) error', after: 'RequestRemoval(ctx, id) error', note: 'ensures the job, emails it', hunks: ['H1.1'] }),
    call('c1', 'dar_jobs#Ensure'),
    call('c2', 'github.com/sendgrid/sendgrid-go#SendEmail', { external: true }),
  ])
  assert.deepEqual(inventoryBlockers(checkInventory(ok, files, { modules: ['dar_jobs'] })), [])
  const bad = inv([...ok.units.slice(0, 1), call('c1', 'dar_jobs#MarkSent'), call('c2', 'sendgrid#SendEmail'), call('c3', 'templates#Render', { hunks: ['H1.1'] })])
  assert.deepEqual(checkInventory(bad, files, { modules: ['dar_jobs', 'templates'] }).ungrounded.map((u) => [u.unit, u.why]), [
    ['c1', 'MarkSent is not in its hunks'],
    ['c2', 'sendgrid is no module of the project: name the module it calls, or say external: true'],
    ['c3', 'Render is not in its hunks'],
  ])
  assert.deepEqual(checkInventory(bad, files, { modules: ['dar_jobs', 'templates', 'sendgrid'] }).ungrounded.map((u) => u.unit), ['c1', 'c3'])
  assert.deepEqual(checkInventory(inv([call('c1', 'digital_accounts#Ensure')]), files, { modules: [] }).ungrounded, [], 'a module of the hunks is known')
  assert.deepEqual(checkInventory(inv([call('c2', 'sendgrid#SendEmail')]), files).ungrounded, [], 'without modules (outside the project) the target is not checked')
})

test('checkInventory: a changed method without before, after or note and a unit with several names block (diff-iak-inventar-zmin-ai.2)', () => {
  const units = [
    unit({ id: 'u1', name: 'Orchestrator.factOf', before: undefined, note: undefined, hunks: ['H1.1'] }),
    unit({ id: 'u2', kind: 'model', name: 'seedless, factOf', change: 'add', hunks: ['H2'] }),
    unit({ id: 'u3', kind: 'config', module: 'core-playbook', name: 'DEFAULT_PLAYBOOK.fact', before: undefined, after: undefined, note: undefined, hunks: ['H3.1'] }),
  ]
  const check = checkInventory(inv(units, [{ hunks: ['H1.2'], reason: 'comment' }]), FILES)
  assert.deepEqual(inventoryBlockers(check), [
    'unit u1 (Orchestrator.factOf): a changed method needs before, note: its old and new signature and what changes in it',
    'unit u2 (seedless, factOf): one name per unit: give each its own unit',
  ], 'a config needs no signature')
})
