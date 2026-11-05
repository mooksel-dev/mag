import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffByChange, hunksOf, markBlocks, nodeUnits, type ChangeInventory, type ComponentDiagram, type DataDiagram, type FlowchartDiagram, type PrFile } from './index.ts'

// Two files, three hunks: H1, H2 in api.ts, H3 in store.ts; a test file's H4 nobody cites.
const files: PrFile[] = [
  { repo: 'mag', path: 'src/api.ts', hunks: [{ id: 'H1', oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 }, { id: 'H2', oldStart: 40, oldLines: 2, newStart: 42, newLines: 6 }] },
  { repo: 'mag', path: 'src/store.ts', hunks: [{ id: 'H3', oldStart: 10, oldLines: 0, newStart: 10, newLines: 8 }] },
  { repo: 'mag', path: 'src/api.test.ts', hunks: [{ id: 'H4', oldStart: 1, oldLines: 0, newStart: 1, newLines: 20 }] },
]

const inventory: ChangeInventory = {
  summary: ['saves a review'],
  units: [
    { id: 'u1', kind: 'method', module: 'api', name: 'Api.save', change: 'add', logic: 'nontrivial', hunks: ['H2.2'] },
    { id: 'u2', kind: 'method', module: 'api', name: 'Api.load', change: 'mod', logic: 'trivial', hunks: ['H1', 'H2.1'] },
    { id: 'u3', kind: 'field', module: 'store', name: 'reviews.key', stored: true, change: 'add', after: 'string', hunks: ['H3.1'] },
  ],
  noise: [{ hunks: ['H3.2'], reason: 'formatting' }],
}

const ids = (picks: { hunk: { id?: string }; blocks: number[] | null }[]) => picks.map((p) => `${p.hunk.id}${p.blocks ? `.${p.blocks.join('+')}` : ''}`)

test('a claim expands its unit cites to their blocks and its file:line cites to the hunk with the line', () => {
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['u1'] }, inventory, files)), ['H2.2'])
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['src/api.ts:44'] }, inventory, files)), ['H2'], 'the hunk containing line 44')
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['api.ts:300'] }, inventory, files)), ['H1', 'H2'], 'no hunk has the line: the file')
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['mag:src/store.ts:12-13'] }, inventory, files)), ['H3'])
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['decision:d1', 'a PR comment'] }, inventory, files)), [], 'no code behind it')
})

test('blocks of one hunk merge and a whole-hunk ref wins; the picks keep diff order without repeats', () => {
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['u1', 'u2'] }, inventory, files)), ['H1', 'H2.1+2'])
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['u1', 'src/api.ts:43', 'u1'] }, inventory, files)), ['H2'])
  assert.deepEqual(ids(hunksOf({ kind: 'claim', cites: ['u3', 'H1'] }, inventory, files)), ['H1', 'H3.1'])
})

test('a change row expands its units', () => {
  assert.deepEqual(ids(hunksOf({ kind: 'change', units: ['u3', 'u1'] }, inventory, files)), ['H2.2', 'H3.1'])
})

test('a diagram node expands the units of its module, entity or method', () => {
  const component: ComponentDiagram = { type: 'component', modules: [{ id: 'api', name: 'API', uses: [] }] }
  const data: DataDiagram = { type: 'data', entities: [{ id: 'reviews', name: 'reviews', fields: [] }], relations: [] }
  const flow: FlowchartDiagram = { type: 'flowchart', of: 'api#save', nodes: [{ id: 's', label: 'start' }], edges: [] }
  assert.deepEqual(nodeUnits(component, 'api', inventory), ['u1', 'u2'])
  assert.deepEqual(ids(hunksOf({ kind: 'node', diagram: component, node: 'api' }, inventory, files)), ['H1', 'H2.1+2'])
  assert.deepEqual(ids(hunksOf({ kind: 'node', diagram: data, node: 'reviews' }, inventory, files)), ['H3.1'])
  assert.deepEqual(ids(hunksOf({ kind: 'node', diagram: flow, node: 's' }, inventory, files)), ['H2.2'])
  assert.deepEqual(hunksOf({ kind: 'node', diagram: component, node: 'api' }, null, files), [], 'no inventory: no units')
})

test('the full diff goes by change: routine after the important ones, then noise, then what nobody cites', () => {
  const report = {
    changes: [
      { title: 'Routine', why: 'loading', units: ['u2'], routine: true },
      { title: 'Save a review', why: 'the point', units: ['u1', 'u3'] },
    ],
  }
  const groups = diffByChange(report, inventory, files)
  assert.deepEqual(groups.map((g) => [g.kind, g.title, g.files.map((f) => `${f.file.path}:${ids(f.hunks).join(',')}`)]), [
    ['change', 'Save a review', ['src/api.ts:H2.2', 'src/store.ts:H3.1']],
    ['routine', 'Routine', ['src/api.ts:H1,H2.1']],
    ['noise', 'Noise', ['src/store.ts:H3.2']],
    ['rest', 'Not in the inventory', ['src/api.test.ts:H4']],
  ])
  const flat = diffByChange(null, inventory, files)
  assert.equal(flat.length, 1, 'no report: one group')
  assert.equal(flat[0].files.length, 3)
  assert.deepEqual(diffByChange(report, inventory, []), [
    { title: 'Save a review', why: 'the point', kind: 'change', files: [] },
    { title: 'Routine', why: 'loading', kind: 'routine', files: [] },
  ])
})

test('markBlocks marks the lines of the cited blocks only', () => {
  const lines = [' a', '-b', '+c', ' d', '+e', ' f']
  assert.deepEqual(markBlocks(lines, [2]).map((l) => l.cited), [false, false, false, false, true, false])
  assert.deepEqual(markBlocks(lines, null).map((l) => l.cited), [false, true, true, false, true, false])
})
