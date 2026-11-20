import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { diagramWarnings, edgesAt, inApp, normalizeDiagram, validateDiagram, type ComponentDiagram } from './index.ts'

// docs/examples/money-hub-architecture.json: the system view of a change drawn well, with boundaries, numbered flows
// and the inside of the new app one click down.
const EXAMPLE = () => normalizeDiagram(JSON.parse(readFileSync(new URL('../../../docs/examples/money-hub-architecture.json', import.meta.url), 'utf8'))) as ComponentDiagram

const SMALL = (): ComponentDiagram => ({
  type: 'component',
  summary: 'The app calls the API.',
  boundaries: [{ id: 'aws', name: 'AWS' }, { id: 'vpc', name: 'VPC', parent: 'aws' }],
  flows: [{ id: 'read', name: 'Read' }],
  modules: [
    { id: 'app', name: 'app', description: '', uses: [{ to: 'api', calls: [{ text: 'GET /x' }], flow: 'read', step: '1' }] },
    { id: 'api', name: 'api', description: '', boundary: 'vpc', uses: [], children: [{ id: 'handler', name: 'handler', description: '', layer: 'app', uses: [{ to: 'db', calls: [], flow: 'read', step: '2', async: true }] }] },
    { id: 'db', name: 'db', description: '', boundary: 'vpc', uses: [] },
  ],
})

test('the example system view validates without errors or warnings', () => {
  const d = EXAMPLE()
  assert.deepEqual(validateDiagram(d), [])
  assert.deepEqual(diagramWarnings(d), [])
})

test('boundaries and flows: unknown ids, cycles, a step without flow, a taken step', () => {
  const d = SMALL()
  assert.deepEqual(validateDiagram(d), [])
  d.boundaries!.push({ id: 'a', name: 'a', parent: 'b' }, { id: 'b', name: 'b', parent: 'a' }, { id: 'c', name: 'c', parent: 'nope' })
  d.modules[2].boundary = 'gone'
  d.modules[2].uses.push({ to: 'app', calls: [], step: '3' }, { to: 'api', calls: [], flow: 'read', step: '1' }, { to: 'app', calls: [], flow: 'other', step: '4' })
  const errors = validateDiagram(d).join('\n')
  assert.match(errors, /Boundary a: its parents form a cycle/)
  assert.match(errors, /Boundary c: parent "nope", no such boundary/)
  assert.match(errors, /Module db: boundary "gone", no such boundary/)
  assert.match(errors, /Use db → app: step needs flow/)
  assert.match(errors, /Use db → api: step "1" of flow read is taken/)
  assert.match(errors, /Use db → app: flow "other", no such flow/)
})

test('normalizeDiagram keeps boundaries and flows, a numeric step becomes a label', () => {
  const d = normalizeDiagram({ ...SMALL(), modules: [{ id: 'app', name: 'app', uses: [{ to: 'db', calls: [], flow: 'read', step: 1 }] }, { id: 'db', name: 'db', uses: [] }] }) as ComponentDiagram
  assert.equal(d.boundaries!.length, 2)
  assert.equal(d.flows![0].name, 'Read')
  assert.equal(d.modules[0].uses[0].step, '1')
})

test('edgesAt carries the steps of the uses behind an arrow; inner steps fold into their module', () => {
  const top = edgesAt(SMALL().modules, null)
  assert.deepEqual(top.find((e) => e.from === 'app')?.steps, [{ flow: 'read', step: '1', calls: ['GET /x'] }])
  const db = top.find((e) => e.from === 'api' && e.to === 'db')!
  assert.deepEqual(db.steps, [{ flow: 'read', step: '2', calls: [] }])
  assert.equal(db.async, true)
  assert.equal(top.find((e) => e.from === 'app')?.async, undefined)
})

test('edgesAt: two steps on one arrow keep their own calls', () => {
  const d = SMALL()
  d.modules[0].uses.push({ to: 'api', calls: [{ text: 'POST /y' }], flow: 'read', step: '3' })
  assert.deepEqual(edgesAt(d.modules, null).find((e) => e.from === 'app')?.steps, [
    { flow: 'read', step: '1', calls: ['GET /x'] },
    { flow: 'read', step: '3', calls: ['POST /y'] },
  ])
})

test('diagramWarnings: layered modules beside systems on the top level, many systems without boundaries, a flow with no step', () => {
  const mixed: ComponentDiagram = { ...SMALL(), modules: [...SMALL().modules, { id: 'svc', name: 'svc', description: '', layer: 'service', uses: [] }] }
  assert.match(diagramWarnings(mixed).join('\n'), /Top-level modules svc have a layer next to systems/)
  const flat: ComponentDiagram = {
    type: 'component',
    summary: 's',
    modules: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id, description: '', uses: [] })),
    flows: [{ id: 'f', name: 'f' }],
  }
  const w = diagramWarnings(flat).join('\n')
  assert.match(w, /The top level has 5 systems and no boundary/)
  assert.match(w, /Flow f has no step/)
})

test('diagramWarnings: layered modules in a boundary of kind app are an expanded app on the system level; outside one they are still flagged', () => {
  const expanded = (): ComponentDiagram => ({
    type: 'component',
    summary: 's',
    boundaries: [{ id: 'aws', name: 'AWS' }, { id: 'hub', name: 'money-hub', kind: 'App', parent: 'aws' }, { id: 'jobs', name: 'jobs', parent: 'hub' }],
    modules: [
      { id: 'web', name: 'web', description: '', uses: [{ to: 'handler', calls: [{ text: 'GET /x' }] }] },
      { id: 'handler', name: 'handler', description: '', layer: 'app', boundary: 'hub', uses: [{ to: 'svc', calls: [{ text: 'list()' }] }] },
      { id: 'worker', name: 'worker', description: '', layer: 'app', boundary: 'jobs', uses: [{ to: 'svc', calls: [] }] },
      { id: 'svc', name: 'svc', description: '', layer: 'service', boundary: 'hub', uses: [{ to: 'db', calls: [] }] },
      { id: 'db', name: 'db', description: '', boundary: 'aws', uses: [] },
    ],
  })
  assert.deepEqual(validateDiagram(expanded()), [])
  assert.deepEqual(diagramWarnings(expanded()), [])
  const d = expanded()
  d.modules.push({ id: 'loose', name: 'loose', description: '', layer: 'client', boundary: 'aws', uses: [] })
  assert.match(diagramWarnings(d).join('\n'), /Top-level modules loose have a layer/)
  assert.doesNotMatch(diagramWarnings(d).join('\n'), /handler|svc/)
  assert.equal(inApp(d, 'jobs'), true)
  assert.equal(inApp(d, 'aws'), false)
  assert.equal(inApp(d, undefined), false)
})
