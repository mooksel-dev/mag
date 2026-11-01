import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ArchNode, ComponentDiagram, DNode } from '@mag/core'
import { formatPlanWarnings, planChanges, planDrift } from './plan.ts'
import type { Element, Skeleton } from './types.ts'

const node = (id: string, extra: Partial<ArchNode> = {}): ArchNode => ({ id, name: id, description: '', uses: [], ...extra })

const architecture: ArchNode[] = [
  node('app', {
    level: 'system',
    paths: ['apps/app'],
    children: [
      node('orchestrator', { layer: 'service', paths: ['apps/app/src/orchestrator.ts'], uses: [{ to: 'renderer', calls: [] }] }),
      node('git', { layer: 'client', paths: ['apps/app/src/git.ts'] }),
      node('tools', { layer: 'app', paths: ['apps/app/src/tools.ts', 'apps/app/src/tool-defs.ts'] }),
      node('renderer', { layer: 'app', paths: ['apps/app/src/renderer'] }),
    ],
  }),
  node('core', { level: 'system', paths: ['packages/core'] }),
  node('github', { level: 'system', kind: '3rd-party API' }),
]

const el = (module: string, path: string, name: string): Element => ({
  ref: `r:${path}#${name}`, path, name, module, kind: 'symbol', decl: 'function', exported: true, signature: name, bodyHash: name, lines: [[1, 1]],
})

const base: Skeleton = {
  repo: 'r',
  sha: 'abcdef1234567890',
  elements: [
    el('orchestrator', 'apps/app/src/orchestrator.ts', 'Orchestrator.groom'),
    el('orchestrator', 'apps/app/src/orchestrator.ts', 'Orchestrator.develop'),
    el('git', 'apps/app/src/git.ts', 'revParse'),
    el('git', 'apps/app/src/git.ts', 'treeAt'),
    el('tools', 'apps/app/src/tool-defs.ts', 'TOOL_DEFS[show_diagram]'),
    el('renderer', 'apps/app/src/renderer/App.tsx', 'App'),
    el('core', 'packages/core/src/index.ts', 'Task'),
  ],
  imports: [],
  edges: [{ from: 'orchestrator', to: 'git', files: ['apps/app/src/orchestrator.ts'] }],
  unparsed: [],
}

const dnode = (id: string, extra: Partial<DNode> = {}): DNode => ({ id, name: id, description: '', uses: [], ...extra })
const diagram = (modules: DNode[]): ComponentDiagram => ({ type: 'component', summary: 's', modules })

const codes = (d: ComponentDiagram) => planChanges(d, base, architecture).warnings.map((w) => `${w.code} ${w.module}${w.item ? ` ${w.item}` : ''}`)

test('planChanges: a plan that matches base has no warnings and lists its changes', () => {
  const d = diagram([
    dnode('orchestrator', {
      diff: 'mod',
      interface: [{ text: 'groom(taskId): void' }, { text: 'develop(taskId): void', diff: 'del' }, { text: 'develop(taskId, local?): void', diff: 'add' }, { text: 'checkPlan(stepId): void', diff: 'add' }],
      uses: [{ to: 'git', calls: [{ text: 'revParse(repo, ref)' }, { text: 'mergeBase(repo, a, b)', diff: 'add' }] }, { to: 'tools', calls: [], diff: 'add' }],
    }),
    dnode('git', { diff: 'mod', interface: [{ text: 'mergeBase(repo, a, b): sha', diff: 'add' }] }),
    dnode('tools', { interface: [{ text: 'show_diagram(diagram)' }] }),
    dnode('plan-check', { diff: 'add', layer: 'app', path: 'apps/app/src/plan-check.ts', interface: [{ text: 'checkPlan(canvas)' }], uses: [{ to: 'github', calls: [] }] }),
    dnode('github'),
  ])
  const check = planChanges(d, base, architecture)
  assert.deepEqual(check.warnings, [])
  assert.deepEqual(check.base, [{ repo: 'r', sha: 'abcdef1234567890' }])
  assert.deepEqual(
    check.changes.map((c) => `${c.kind} ${c.diff} ${c.key}`),
    [
      'module mod orchestrator',
      'element del r:apps/app/src/orchestrator.ts#Orchestrator.develop',
      'element add r:apps/app/src/orchestrator.ts#Orchestrator.develop',
      'element add orchestrator#checkPlan',
      'edge mod orchestrator -> git',
      'edge add orchestrator -> tools',
      'module mod git',
      'element add git#mergeBase',
      'module add plan-check',
      'element add plan-check#checkPlan',
      'edge add plan-check -> github',
    ],
  )
  assert.equal(check.changes.find((c) => c.key === 'orchestrator#checkPlan')!.after, 'checkPlan(stepId): void')
})

test('planChanges: unknown ids, new modules without a path, adds of what exists', () => {
  assert.deepEqual(
    codes(diagram([dnode('orchestrater', { interface: [{ text: 'groom()' }] }), dnode('git', { diff: 'add' }), dnode('store', { diff: 'add', layer: 'service' }), dnode('slack', { diff: 'add' })])),
    ['unknown-module orchestrater', 'exists git', 'no-path store'],
  )
  assert.deepEqual(
    codes(
      diagram([
        dnode('git', { interface: [{ text: 'treeAt(repo, sha)', diff: 'add' }] }),
        dnode('orchestrator', { uses: [{ to: 'git', calls: [], diff: 'add' }, { to: 'renderer', calls: [], diff: 'add' }] }),
      ]),
    ),
    ['exists git treeAt(repo, sha)', 'exists orchestrator -> git', 'exists orchestrator -> renderer'],
  )
})

test('planChanges: methods, calls and dependencies base does not have', () => {
  const check = planChanges(
    diagram([
      dnode('git', { interface: [{ text: 'blobs(repo, shas)' }, { text: 'diffHunks(repo)', diff: 'mod' }, { text: 'Some prose without a method' }] }),
      dnode('tools', { uses: [{ to: 'git', calls: [{ text: 'treeAt(repo, sha)' }, { text: 'fetch(repo)', diff: 'add' }] }, { to: 'core', calls: [] }] }),
      dnode('core', { interface: [{ text: 'groom(id)', diff: 'move', from: 'orchestrator' }, { text: 'nope(id)', diff: 'move', from: 'git' }] }),
    ]),
    base,
    architecture,
  )
  assert.deepEqual(
    check.warnings.map((w) => `${w.code} ${w.module} ${w.item}`),
    [
      'not-in-base git blobs(repo, shas)',
      'not-in-base git diffHunks(repo)',
      'not-in-base git Some prose without a method',
      'not-in-base tools -> git',
      'not-in-base tools -> git#fetch',
      'not-in-base tools -> core',
      'not-in-base core nope(id)',
    ],
  )
  assert.match(formatPlanWarnings(check.warnings), /^- git: "blobs" is not in its code at base abcdef12: mark it add/)
})

test('planChanges: modules without parsed code and other diagram types are taken as drawn', () => {
  const noCode = { ...base, elements: [] }
  assert.deepEqual(planChanges(diagram([dnode('git', { interface: [{ text: 'anything()' }] })]), noCode, architecture).warnings, [])
  assert.deepEqual(planChanges({ type: 'sequence', participants: [], messages: [] }, base, architecture), { base: [{ repo: 'r', sha: base.sha }], changes: [], warnings: [] })
})

test('planDrift: the warnings a newer base adds', () => {
  const d = diagram([dnode('git', { interface: [{ text: 'treeAt(repo, sha)' }, { text: 'revParse(repo, ref)' }] })])
  const before = planChanges(d, base, architecture)
  const moved = { ...base, sha: 'fedcba', elements: base.elements.filter((e) => e.name !== 'treeAt') }
  const drift = planDrift(before, planChanges(d, moved, architecture))
  assert.deepEqual(drift.map((w) => `${w.code} ${w.item}`), ['not-in-base treeAt(repo, sha)'])
  assert.deepEqual(planDrift(before, before), [])
})
