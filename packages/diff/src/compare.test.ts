import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDiagram, type ArchNode, type ComponentDiagram, type DNode } from '@mag/core'
import { compare, coverage, formatComparison, mergeBlockers } from './compare.ts'
import { factDiagram } from './fact.ts'
import { planChanges } from './plan.ts'
import { parseSignificance, significance, withLevels } from './significance.ts'
import { planVocabulary, vocabularyOf } from './vocabulary.ts'
import type { Change, ChangeSet } from './types.ts'

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({ id, name: id, description: '', uses: [], ...extra })
const architecture: ArchNode[] = [
  node('app', {
    level: 'system',
    paths: ['apps/app'],
    children: [
      node('orchestrator', { layer: 'service', paths: ['apps/app/src/orchestrator.ts'] }),
      node('git', { layer: 'client', paths: ['apps/app/src/git.ts'] }),
      node('tools', { layer: 'app', paths: ['apps/app/src/tools.ts', 'apps/app/src/tool-defs.ts'] }),
    ],
  }),
  node('github', { level: 'system', kind: '3rd-party API' }),
]

const ORCH = 'apps/app/src/orchestrator.ts'
const el = (module: string | null, path: string, name: string, diff: Change['diff'], extra: Partial<Change> = {}): Change => ({
  key: `r:${path}#${name}`, kind: 'element', diff, module, path, line: 3, name, elementKind: 'symbol', decl: 'method', exported: true, hunks: [{ path, oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }], ...extra,
})
const edge = (from: string, to: string, diff: Change['diff']): Change => ({ key: `${from} -> ${to}`, kind: 'edge', diff, module: from, name: to, hunks: [] })
const file = (module: string | null, path: string, diff: Change['diff'], extra: Partial<Change> = {}): Change => ({ key: `r:${path}`, kind: 'file', diff, module, path, hunks: [], ...extra })
const set = (changes: Change[], extra: Partial<ChangeSet> = {}): ChangeSet => withLevels({ repo: 'r', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), changes, deterministic: true, unparsed: [], ...extra }, [])

const dnode = (id: string, extra: Partial<DNode> = {}): DNode => ({ id, name: id, description: '', uses: [], ...extra })
const diagram = (modules: DNode[]): ComponentDiagram => ({ type: 'component', summary: 's', modules })
const planOf = (d: ComponentDiagram) => planChanges(d, [], architecture).changes

test('significance: defaults by kind, the project rules first', () => {
  const lvl = (c: Change, rules = '') => significance(c, parseSignificance(rules))
  assert.equal(lvl(el('orchestrator', ORCH, 'Orchestrator.review', 'mod', { part: 'signature' })), 'high')
  assert.equal(lvl(el('orchestrator', ORCH, 'Orchestrator.review', 'mod', { part: 'body' })), 'medium')
  assert.equal(lvl(el('orchestrator', ORCH, 'helper', 'add', { exported: false })), 'low')
  assert.equal(lvl(el('tools', 'apps/app/src/tool-defs.ts', 'TOOL_DEFS[x]', 'mod', { elementKind: 'contract', part: 'body' })), 'high')
  assert.equal(lvl(el('orchestrator', ORCH, 'User', 'add', { elementKind: 'entity' })), 'critical')
  assert.equal(lvl(edge('orchestrator', 'git', 'add')), 'high')
  assert.equal(lvl(edge('orchestrator', 'ext:zod', 'add')), 'medium')
  assert.equal(lvl(file('app', 'README.md', 'mod')), 'noise')
  assert.equal(lvl(file('app', 'apps/app/main.py', 'mod')), 'high', 'a language without an adapter')
  assert.equal(lvl(file('app', 'apps/app/src/a.test.ts', 'mod', { test: true }), 'high: apps'), 'noise', 'tests stay noise')
  // A prompt body is high by a rule; rules go first-match, by path and name, any case.
  const rules = 'Prose is ignored.\nhigh: #*prompt*\nnoise: apps/app/src/git.ts\nlow: apps/app/src/tools.ts#run'
  assert.equal(lvl(el('orchestrator', ORCH, 'reviewPrompt', 'mod', { part: 'body', decl: 'const' }), rules), 'high')
  assert.equal(lvl(el('git', 'apps/app/src/git.ts', 'treeAt', 'mod', { part: 'signature' }), rules), 'noise')
  assert.equal(lvl(el('tools', 'apps/app/src/tools.ts', 'run', 'add'), rules), 'low')
  assert.equal(lvl(el('tools', 'apps/app/src/tools.ts', 'other', 'add'), rules), 'high')
  assert.deepEqual(parseSignificance('high: #*PROMPT*\nhuge: x\nlow: a/b'), [
    { level: 'high', path: null, name: '*PROMPT*' },
    { level: 'low', path: 'a/b', name: null },
  ])
})

test('compare: match, differs, missing, unplanned and unchecked', () => {
  const plan = planOf(
    diagram([
      dnode('orchestrator', {
        diff: 'mod',
        interface: [
          { text: 'review(stepId): void', diff: 'del' },
          { text: 'review(stepId, heads): void', diff: 'add' },
          { text: 'factOf(stepId): Fact', diff: 'add' },
          { text: 'groom(taskId): void', diff: 'mod' },
          { text: 'cancel(taskId): void', diff: 'del' },
        ],
        uses: [{ to: 'git', calls: [], diff: 'add' }, { to: 'github', calls: [], diff: 'add' }],
      }),
      dnode('git'),
      dnode('github'),
      dnode('fact', { diff: 'add', layer: 'app', path: 'apps/app/src/fact.ts', interface: [{ text: 'stepFact(step): Fact' }] }),
    ]),
  )
  const fact = set([
    el('orchestrator', ORCH, 'Orchestrator.review', 'mod', { part: 'body' }),
    el('orchestrator', ORCH, 'Orchestrator.factOf', 'add'),
    el('orchestrator', ORCH, 'Orchestrator.groom', 'mod', { part: 'body' }),
    el('orchestrator', ORCH, 'Orchestrator.develop', 'mod', { part: 'signature' }),
    el('orchestrator', ORCH, 'helper', 'add', { exported: false }),
    edge('orchestrator', 'git', 'add'),
    file('orchestrator', ORCH, 'mod'),
    file('fact', 'apps/app/src/fact.ts', 'add'),
    el('fact', 'apps/app/src/fact.ts', 'stepFact', 'add'),
    file('app', 'apps/app/src/fact.test.ts', 'add', { test: true }),
    file('app', 'docs/notes.md', 'mod'),
  ])
  const { items } = compare(plan, fact, architecture)
  const row = (s: string) => items.filter((i) => i.status === s).map((i) => (i.plan ?? i.fact[0]).name ?? i.plan?.key)
  assert.deepEqual(row('differs'), ['review'], 'a planned signature change that only touched the body')
  assert.equal(items.find((i) => i.status === 'differs')!.note, 'planned mod (signature), the code: mod (body)')
  assert.deepEqual(row('missing'), ['cancel'])
  assert.deepEqual(row('unplanned'), ['Orchestrator.develop', 'helper'], 'by level; tests, noise and files with element changes left out')
  assert.deepEqual(row('unchecked'), ['github'], 'github has no code')
  assert.deepEqual(row('match').sort(), ['factOf', 'fact', 'git', 'groom', 'stepFact'].sort(), 'lines of an added module are planned adds')
  assert.deepEqual(items.filter((i) => i.status === 'unplanned').map((i) => i.level), ['high', 'low'])

  const blockers = mergeBlockers({ items }, [fact])
  assert.equal(blockers.length, 1)
  assert.match(blockers[0], /^high: orchestrator method Orchestrator\.develop \(apps\/app\/src\/orchestrator\.ts:3\) is not on the plan$/)
  const text = formatComparison({ items }, blockers)
  assert.match(text, /merge is NOT allowed/)
  assert.match(text, /Done otherwise than planned \(1\):\n {2}- \[high\] mod \(signature\) orchestrator review; the code: mod \(body\) orchestrator method Orchestrator\.review \(apps\/app\/src\/orchestrator\.ts:3\)\n/)
  assert.match(text, /Planned, not in the code \(1\)/)
})

test('compare: an outer plan module stands for its inner ones; moves match moves', () => {
  const plan = planOf(diagram([dnode('app', { interface: [{ text: 'treeAt(repo, sha): Tree', diff: 'move', from: 'tools' }] }), dnode('tools')]))
  const fact = set([el('git', 'apps/app/src/git.ts', 'treeAt', 'move', { from: 'r:apps/app/src/tools.ts#treeAt' })])
  assert.deepEqual(compare(plan, fact, architecture).items.map((i) => i.status), ['match'])
})

test('compare and factDiagram: members of a new interface go with it', () => {
  const T = 'apps/app/src/types.ts'
  const fact = set([
    el('orchestrator', T, 'Fact', 'add', { decl: 'interface', after: 'interface Fact' }),
    el('orchestrator', T, 'Fact.heads', 'add', { decl: 'property', after: 'heads: Heads' }),
    el('orchestrator', T, 'Fact.at', 'add', { decl: 'property', after: 'at: number' }),
    el('orchestrator', T, 'Other.x', 'add', { decl: 'property', after: 'x: number' }),
  ])
  const { items } = compare([], fact, architecture)
  assert.deepEqual(items.map((i) => i.fact.map((c) => c.name)), [['Fact', 'Fact.heads', 'Fact.at'], ['Other.x']])
  assert.equal(mergeBlockers({ items }, [fact]).length, 2)
  const d = factDiagram([fact], architecture, vocabularyOf(architecture))!
  assert.deepEqual(d.modules[0].interface, [{ text: 'Fact', diff: 'add' }, { text: 'x: number', diff: 'add' }])
  // A diagram that shows the interface shows its members.
  assert.deepEqual(coverage(fact, [d], architecture).unshown, [])
  const plan = planOf(diagram([dnode('orchestrator', { interface: [{ text: 'Fact', diff: 'add' }, { text: 'at: number', diff: 'add' }] })]))
  assert.deepEqual(compare(plan, fact, architecture).items.map((i) => [i.status, i.fact.map((c) => c.name)]), [
    ['unplanned', ['Other.x']],
    ['match', ['Fact', 'Fact.heads']],
    ['match', ['Fact.at']],
  ])
})

test('mergeBlockers: a fact no adapter reads blocks merge; a fully planned one does not', () => {
  const plan = planOf(diagram([dnode('orchestrator', { interface: [{ text: 'factOf(stepId): Fact', diff: 'add' }] })]))
  const fact = set([el('orchestrator', ORCH, 'Orchestrator.factOf', 'add')])
  assert.deepEqual(mergeBlockers(compare(plan, fact, architecture), [fact]), [])
  const py = set([file('app', 'apps/app/x.py', 'mod')], { deterministic: false, unparsed: ['apps/app/x.py'] })
  assert.deepEqual(mergeBlockers(compare(plan, [fact, py], architecture), [fact, py]), ['high: file apps/app/x.py is not on the plan', 'r: no adapter reads apps/app/x.py'])
  assert.match(formatComparison(compare(plan, fact, architecture), []), /^Threshold: merge is allowed/)
})

test('factDiagram: a valid draft that covers the significant fact', () => {
  const vocabulary = planVocabulary(architecture, [])
  const fact = set([
    el('orchestrator', ORCH, 'Orchestrator.review', 'mod', { part: 'signature', before: 'async review(stepId: string)', after: 'async review(stepId: string, heads: Heads)' }),
    el('orchestrator', ORCH, 'Orchestrator.factOf', 'add', { after: 'factOf(stepId: string): Promise<Fact>' }),
    el('orchestrator', ORCH, 'Orchestrator.groom', 'mod', { part: 'body', after: 'groom(taskId)' }),
    el('orchestrator', ORCH, 'helper', 'add', { exported: false, after: 'helper()' }),
    el('git', 'apps/app/src/git.ts', 'treeAt', 'move', { from: 'r:apps/app/src/tools.ts#treeAt', after: 'treeAt(repo: string, sha: string)' }),
    el(null, 'scripts/x.ts', 'run', 'add', { after: 'run()' }),
    edge('orchestrator', 'git', 'add'),
    edge('orchestrator', 'ext:@octokit/rest', 'add'),
  ])
  const d = factDiagram([fact], architecture, vocabulary)!
  assert.deepEqual(validateDiagram(d), [])
  assert.deepEqual(d.modules.map((m) => m.id), ['orchestrator', 'git', 'tools', 'ext-octokit-rest', 'unowned'])
  assert.deepEqual(d.modules[0].interface, [
    { text: 'review(stepId: string)', diff: 'del' },
    { text: 'review(stepId: string, heads: Heads)', diff: 'add' },
    { text: 'factOf(stepId: string): Promise<Fact>', diff: 'add' },
    { text: 'groom(taskId)', diff: 'mod' },
  ], 'internal helpers are left out')
  assert.deepEqual(d.modules[0].uses.map((u) => [u.to, u.diff]), [['git', 'add'], ['ext-octokit-rest', 'add']])
  assert.deepEqual(d.modules[1].interface, [{ text: 'treeAt(repo: string, sha: string)', diff: 'move', from: 'tools' }])
  // The draft shows every significant change of the fact.
  const cov = coverage(fact, [d], architecture)
  assert.deepEqual(cov.unshown.map((c) => c.name), ['helper'])
  // A reviewer's revision that drops a change no longer covers it.
  const dropped = { ...d, modules: d.modules.map((m) => (m.id === 'orchestrator' ? { ...m, interface: m.interface!.slice(2) } : m)) }
  assert.deepEqual(coverage(fact, [dropped], architecture).unshown.map((c) => c.name).sort(), ['Orchestrator.review', 'helper'])
})

test('planVocabulary: a module the plan adds with a path joins the vocabulary', () => {
  const d = diagram([dnode('app', { children: [dnode('fact', { diff: 'add', path: 'apps/app/src/fact.ts' })] }), dnode('orchestrator')])
  assert.deepEqual(planVocabulary(architecture, [d]).modules.map((m) => m.id), [...vocabularyOf(architecture).modules.map((m) => m.id), 'fact'])
})
