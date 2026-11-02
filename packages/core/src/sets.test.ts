import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linksAt, nodeFiles, normalizeDiagram, remapLinks, setKey, setLevels, setOf, setRoot, setTrail, validateDiagram, validateLinks, type Canvas, type Diagram } from './index.ts'

const canvas = (id: string, diagram: Diagram, extra: Partial<Canvas> = {}): Canvas =>
  ({ id, projectId: 'p', taskId: 't', sessionId: null, title: id, kind: 'diagram', diagram, role: 'plan', option: null, stepId: 's1', repo: null, planOf: null, version: 1, updatedAt: 0, ...extra }) as Canvas

const COMPONENT: Diagram = {
  type: 'component',
  summary: 's',
  modules: [
    {
      id: 'api', name: 'api', description: '', diff: 'mod',
      links: [{ to: 'data', node: 'users', kind: 'data' }],
      interface: [{ text: 'list(): User[]', diff: 'mod', links: [{ to: 'flow', kind: 'logic' }] }],
      uses: [{ to: 'db', calls: [], links: [{ to: 'seq', kind: 'scenario' }] }],
    },
    { id: 'db', name: 'db', description: '', uses: [] },
  ],
}
const DATA: Diagram = { type: 'data', entities: [{ id: 'users', name: 'users', kind: 'table', fields: [{ name: 'id', type: 'uuid' }] }], relations: [] }
const FLOW: Diagram = { type: 'flowchart', nodes: [{ id: 'a', label: 'a', shape: 'start' }], edges: [] }
const SEQ: Diagram = { type: 'sequence', participants: [{ id: 'api', label: 'api' }], messages: [] }

test('setOf: the diagrams of one place, an option, a step plan or fact, a review fact; an unplaced one alone (povnyi-diff-nabir-pov-iazanykh.1)', () => {
  const plan = [canvas('c', COMPONENT), canvas('data', DATA)]
  const other = canvas('x', DATA, { stepId: 's2' })
  const fact = canvas('f', DATA, { role: 'fact' })
  const review = canvas('r', DATA, { role: 'fact', stepId: null, taskId: 'review' })
  const loose = canvas('l', DATA, { role: null, stepId: null })
  const all = [...plan, other, fact, review, loose]
  assert.deepEqual(setOf(plan[1], all).map((c) => c.id), ['c', 'data'])
  assert.deepEqual(setOf(fact, all).map((c) => c.id), ['f'])
  assert.deepEqual(setOf(review, all).map((c) => c.id), ['r'])
  assert.deepEqual(setOf(loose, all).map((c) => c.id), ['l'])
  assert.equal(setKey(canvas('o', DATA, { role: 'option', option: 'A', stepId: null })), 't:option:A')
  assert.equal(setRoot(plan), null)
  assert.equal(setRoot([plan[1]])?.id, 'data', 'a set of one is its own root')
})

test('validateLinks: a linked set from its root hangs together; a flowchart of a drawn method is reached by its of', () => {
  const set = [canvas('c', COMPONENT, { root: true }), canvas('data', DATA), canvas('flow', FLOW), canvas('seq', SEQ), canvas('of', { ...FLOW, of: 'db#query' })]
  assert.deepEqual(validateLinks(set), [])
})

test('validateLinks: no root, several roots, links outside the set or to no node, orphans with a hint', () => {
  const linked = (to: string, node?: string): Diagram => ({ ...COMPONENT, modules: [{ ...COMPONENT.modules[0], links: [{ to, kind: 'data', ...(node && { node }) }], interface: [], uses: [] }, COMPONENT.modules[1]] })
  assert.match(validateLinks([canvas('c', COMPONENT), canvas('data', DATA)]).join('\n'), /The set has no root/)
  assert.match(validateLinks([canvas('c', COMPONENT, { root: true }), canvas('data', DATA, { root: true })]).join('\n'), /The set has 2 roots/)
  const warnings = validateLinks([canvas('c', linked('gone'), { root: true }), canvas('data', DATA), canvas('flow', { ...FLOW, of: 'nowhere#run' })])
  assert.deepEqual(warnings, [
    '"c" (c): api links to gone, not a diagram of this set.',
    '"data" (data) is not reached from the root: give the module that owns these tables links: [{ to: "data", kind: "data" }].',
    '"flow" (flow) is not reached from the root: no diagram of the set draws nowhere: add the module with its method line.',
  ])
  assert.deepEqual(validateLinks([canvas('c', linked('data', 'orders'), { root: true }), canvas('data', DATA)]), ['"c" (c): api links to node "orders" of "data" (data), which has no such node.'])
})

test('remapLinks: a copy of a set links its own diagrams', () => {
  const copy = remapLinks(COMPONENT, new Map([['data', 'D'], ['flow', 'F']]))
  assert.ok(copy.type === 'component')
  assert.deepEqual([copy.modules[0].links![0].to, copy.modules[0].interface![0].links![0].to, copy.modules[0].uses[0].links![0].to], ['D', 'F', 'seq'])
  assert.equal((COMPONENT as { modules: { links?: { to: string }[] }[] }).modules[0].links![0].to, 'data', 'the original stays')
})

test('validateDiagram: links need to and a kind; trivialLogic is one line', () => {
  const bad = normalizeDiagram({
    ...COMPONENT,
    modules: [{ ...COMPONENT.modules[0], links: [{ to: '', kind: 'data' }], interface: [{ text: 'list()', trivialLogic: ' ' }], uses: [{ to: 'db', calls: [], links: [{ to: 'x', kind: 'other' }] }] }, COMPONENT.modules[1]],
  })
  assert.deepEqual(validateDiagram(bad), [
    'Module api: a link needs to, the id of a diagram of the set',
    'Interface line "list()" of api: trivialLogic is one line on why the changed logic needs no flowchart',
    'Use api → db: link to x: kind must be one of detail, data, scenario, logic',
  ])
  assert.deepEqual(validateDiagram(normalizeDiagram({ ...DATA, entities: [{ ...(DATA as { entities: object[] }).entities[0], links: 'api' }] })), ['Entity users: links must be a list of { to, node?, kind }'])
  assert.deepEqual(validateDiagram(normalizeDiagram(COMPONENT)), [])
})

test('setLevels: root as the system, then modules, data, scenarios, logic; unchanged diagrams but the root hidden (povnyi-diff-nabir-pov-iazanykh.2)', () => {
  const MOD: Diagram = { type: 'component', summary: 's', modules: [{ id: 'db', name: 'db', description: '', diff: 'add', uses: [] }] }
  const QUIET: Diagram = { type: 'component', summary: 's', modules: [{ id: 'x', name: 'x', description: '', uses: [] }] }
  const flow: Diagram = { ...FLOW, nodes: [{ id: 'a', label: 'a', shape: 'start', diff: 'add' }] }
  const data: Diagram = { ...DATA, entities: [{ ...(DATA as Extract<Diagram, { type: 'data' }>).entities[0], diff: 'add' }] }
  const seq: Diagram = { ...SEQ, messages: [{ from: 'api', to: 'api', text: 'x', kind: 'call', diff: 'add' }] }
  const set = [canvas('flow', flow), canvas('c', COMPONENT, { root: true }), canvas('m', MOD), canvas('q', QUIET), canvas('data', data), canvas('seq', seq)]
  assert.deepEqual(setLevels(set).map((l) => [l.level, l.diagrams.map((d) => d.canvas.id)]), [['system', ['c']], ['modules', ['m']], ['data', ['data']], ['scenarios', ['seq']], ['logic', ['flow']]])
  // Reached ones first: the root links data before the flow, so with two flows the linked one leads.
  const two = [canvas('flow2', flow), ...set]
  assert.deepEqual(setLevels(two).find((l) => l.level === 'logic')!.diagrams.map((d) => d.canvas.id), ['flow', 'flow2'])
})

test('setTrail: the root, then each diagram with the node whose link led there; an orphan alone', () => {
  const MOD: Diagram = { type: 'component', summary: 's', modules: [{ id: 'db', name: 'db', description: '', uses: [], links: [{ to: 'flow', kind: 'logic' }] }] }
  const ROOT: Diagram = { type: 'component', summary: 's', modules: [{ id: 'api', name: 'api', description: '', uses: [], links: [{ to: 'm', kind: 'detail' }] }] }
  const set = [canvas('r', ROOT, { root: true }), canvas('m', MOD), canvas('flow', FLOW), canvas('lost', DATA)]
  assert.deepEqual(setTrail(set, 'flow'), [{ id: 'r' }, { id: 'm', via: 'api' }, { id: 'flow', via: 'db' }])
  assert.deepEqual(setTrail(set, 'r'), [{ id: 'r' }])
  assert.deepEqual(setTrail(set, 'lost'), [{ id: 'lost' }])
})

test('linksAt: a module opens its own, its lines\' and its uses\' links, and the flowcharts of its methods by of', () => {
  const of: Diagram = { ...FLOW, of: 'api#create' }
  const set = [canvas('c', COMPONENT, { root: true }), canvas('data', DATA), canvas('flow', FLOW), canvas('seq', SEQ), canvas('of', of)]
  assert.deepEqual(linksAt(set, 'c', 'api').map((l) => [l.from, l.link.to, l.link.kind, !!l.implicit]), [
    ['api', 'data', 'data', false],
    ['api#list', 'flow', 'logic', false],
    ['api -> db', 'seq', 'scenario', false],
    ['api#create', 'of', 'logic', true],
  ])
  assert.deepEqual(linksAt(set, 'c', 'db'), [])
  assert.equal(linksAt(set, 'c').length, 4)
  assert.deepEqual(linksAt(set, 'nope', 'api'), [])
})

test('nodeFiles: the files of a module\'s lines, uses and calls, once each', () => {
  const d: Diagram = {
    type: 'component', summary: 's',
    modules: [{ id: 'api', name: 'api', description: '', interface: [{ text: 'a()', diff: 'add', files: ['a.ts'] }], uses: [{ to: 'db', calls: [{ text: 'q()', files: ['b.ts', 'a.ts'] }], files: ['c.ts'] }] }],
  }
  assert.deepEqual(nodeFiles(d, 'api'), ['a.ts', 'c.ts', 'b.ts'])
  assert.deepEqual(nodeFiles(d, 'db'), [])
})
