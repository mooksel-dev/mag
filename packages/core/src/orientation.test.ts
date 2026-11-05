import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODE_CHECKS, DEFAULT_PLAYBOOK, DEVELOPER_BAR, GLOSSARY, PLAYBOOK_SECTIONS, THE_USER, howMagWorks, orientation } from './index.ts'

test('howMagWorks: the lifecycle, the doc as the only handoff, diagram kinds, plan ↔ fact and what mag checks, each with why (prompts-use-the-models-to.5)', () => {
  const h = howMagWorks(2)
  assert.match(h, /mag creates steps only after the user has answered the owner/)
  assert.match(h, /fresh developer session from fresh base/)
  assert.match(h, /the doc is the only handoff between agents, so it has to\s+stand on its own/)
  assert.match(h, /so every PR can be reviewed and merged on its own/)
  assert.match(h, /up to 2 review rounds in a row; after that the user decides/)
  assert.match(h, /Only the user merges/)
  for (const kind of ['component', 'sequence', 'state', 'flowchart', 'data']) assert.match(h, new RegExp(`\\b${kind}\\b`))
  assert.match(h, /plan ↔ fact/)
  assert.match(h, /What mag checks itself, so you spend your judgment on what it cannot/)
  assert.match(howMagWorks(1), /up to 1 review round in a row/)
  assert.match(howMagWorks(0), /this project sends every review to the user/)
})

test('orientation: how mag works, who reads, and the glossary with user for the user\'s own words (prompts-use-the-models-to.5)', () => {
  const o = orientation(2)
  assert.ok(o.includes(THE_USER) && o.includes(GLOSSARY) && o.includes(howMagWorks(2)))
  assert.match(THE_USER, /narrow\s+chat pane/)
  assert.match(GLOSSARY, /- user \(as a source of a claim\): the user's own words/)
  for (const word of ['work:', 'step:', 'owner:', 'the doc:', 'fact:', 'look:', 'idea:', 'canvas:']) assert.ok(GLOSSARY.includes(word), word)
})

test('every text mag sends to agents is calm: no ALL-CAPS emphasis, no "yours" for the user (prompts-use-the-models-to.5, audit F9)', () => {
  const texts: [string, string][] = [...PLAYBOOK_SECTIONS.map((s): [string, string] => [s, DEFAULT_PLAYBOOK[s]]), ['CODE_CHECKS', CODE_CHECKS], ['DEVELOPER_BAR', DEVELOPER_BAR], ['orientation', orientation(2)]]
  for (const [name, text] of texts) {
    assert.doesNotMatch(text, /\b(NEVER|ALWAYS|MUST|IMPORTANT|ONLY|DO NOT|CRITICAL)\b/, name)
    assert.doesNotMatch(text, /\byours\b/, name)
  }
})

test('the plan is a goal: the doc stands alone, draw what a reviewer needs, steps ship on their own (prompts-use-the-models-to.5, audit F6)', () => {
  const p = DEFAULT_PLAYBOOK.plan
  assert.match(p, /a doc a fresh developer and a fresh\s+reviewer can work from alone/)
  assert.match(p, /draw what a reviewer needs to see the design of the chosen option, and skip the levels the change does not\s+touch/)
  assert.match(p, /reviewable and shippable\s+on its own/)
  assert.match(p, /one is fine when it is the only sensible way, with why/)
  assert.doesNotMatch(p, /Draw every level|at least one diagram per\s+repository|^\d\. /m, 'no script of numbered steps and no forced drawing')
})
