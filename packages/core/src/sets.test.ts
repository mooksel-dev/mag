import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDiagram, remapLinks, setKey, setOf, setRoot, validateDiagram, validateLinks, type Canvas, type Diagram } from './index.ts'

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
