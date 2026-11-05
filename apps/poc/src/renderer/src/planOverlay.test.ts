import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DNode } from '@mag/core'
import { paintPlan } from './planOverlay.ts'

const node = (id: string, extra: Partial<DNode> = {}): DNode => ({ id, name: id, description: '', uses: [], ...extra })

test('paintPlan: plan modules and dependencies by their status; unplanned modules go in their ancestor, unplanned dependencies join their caller', () => {
  const plan = [node('app', { children: [node('orchestrator', { diff: 'mod', uses: [{ to: 'git', calls: [] }] }), node('git')] }), node('store', { diff: 'mod' })]
  const p = paintPlan(plan, {
    modules: { orchestrator: 'match', store: 'missing' },
    edges: { 'orchestrator -> git': 'differs' },
    unplanned: { modules: [{ id: 'cache', name: 'Cache', layer: 'client', within: ['app'] }, { id: 'web', name: 'web', within: [] }], edges: [{ from: 'cache', to: 'git' }, { from: 'cache', to: 'nowhere' }] },
  })
  const app = p.modules[0]
  assert.deepEqual(app.children!.map((c) => c.id), ['orchestrator', 'git', 'cache'])
  assert.deepEqual(app.children![2].uses.map((u) => u.to), ['git'], 'a dependency to a module not drawn is left out')
  assert.deepEqual(p.modules.map((m) => m.id), ['app', 'store', 'web'])
  assert.deepEqual(['orchestrator', 'store', 'cache', 'git'].map(p.module), ['match', 'missing', 'unplanned', undefined])
  assert.deepEqual([p.edge('orchestrator', 'git'), p.edge('cache', 'git'), p.edge('git', 'x')], ['differs', 'unplanned', undefined])
  assert.equal(plan[0].children!.length, 2, 'the plan itself is not changed')
})
