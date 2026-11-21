import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Hit, QueryOptions } from './core/services/search/index.ts'
import { PALETTE_LIMIT, SEARCH_KINDS, paletteSearch } from './search-tools.ts'

test('paletteSearch: one ranking across kinds and one per kind; scope, labels and people as the palette asks, malformed ones dropped', () => {
  const asked: QueryOptions[] = []
  const hit = (kind: Hit['kind']): Hit => ({ ref: `w:${kind}`, kind, title: kind, snippet: '', at: 0, labels: [] })
  const search = { query: (_q: string, o: QueryOptions) => (asked.push(o), o.kinds ? [hit(o.kinds[0])] : [hit('topic'), hit('doc')]) }
  const r = paletteSearch(search, 'queue', { workspaceId: 'w', scope: 'all', labels: [['l1', 7 as never], []], people: true })
  assert.deepEqual(r.all.map((h) => h.kind), ['topic', 'doc'])
  assert.equal(r.limit, PALETTE_LIMIT)
  assert.deepEqual(Object.keys(r.byKind), SEARCH_KINDS)
  assert.deepEqual(r.byKind.person.map((h) => h.ref), ['w:person'])
  assert.deepEqual(asked.map((o) => o.kinds?.[0] ?? 'all'), [...SEARCH_KINDS, 'all'])
  assert.ok(asked.every((o) => o.workspaceId === 'w' && o.scope === 'all' && o.people === true && o.limit === PALETTE_LIMIT && JSON.stringify(o.labels) === '[["l1"]]'))
  asked.length = 0
  paletteSearch(search, 'queue', { workspaceId: 'w', scope: 'other' as never })
  assert.ok(asked.every((o) => o.scope === undefined && o.people === false && o.labels === undefined), 'this workspace, people off by default')
})
