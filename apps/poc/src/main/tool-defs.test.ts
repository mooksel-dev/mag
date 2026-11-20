import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CANVAS_CLASSES, CODE_CHECKS, DEFAULT_PLAYBOOK, DEVELOPER_BAR, PLAYBOOK_SECTIONS, orientation } from '@mag/core'
import { TOOL_DEFS } from './tool-defs.ts'

/** Every description string of the tools, nested schema fields included. */
const descriptions = (o: unknown, out: string[] = []): string[] => {
  if (Array.isArray(o)) for (const x of o) descriptions(x, out)
  else if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) {
      if (k === 'description' && typeof v === 'string') out.push(v)
      else descriptions(v, out)
    }
  return out
}

/** Runs of `n` words, lower case without punctuation: a sentence said twice shares them, a shared term does not. */
const phrases = (text: string, n = 7) => {
  const words = text.toLowerCase().replace(/[^a-z0-9<>#_]+/g, ' ').split(' ').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '))
  return out
}

test('each contract is said once: no sentence of the playbook or mag\'s bar repeats a tool description (prompts-use-the-models-to.4)', () => {
  const tools = phrases(descriptions(TOOL_DEFS).join(' | '))
  const texts: [string, string][] = [...PLAYBOOK_SECTIONS.map((s): [string, string] => [s, DEFAULT_PLAYBOOK[s]]), ['CODE_CHECKS', CODE_CHECKS], ['DEVELOPER_BAR', DEVELOPER_BAR], ['orientation', orientation(2)]]
  for (const [name, text] of texts) {
    const twice = [...phrases(text)].filter((p) => tools.has(p))
    assert.deepEqual(twice, [], `${name} repeats a tool description`)
  }
})

test('the contracts the playbook used to state live in the tool schemas (prompts-use-the-models-to.4)', () => {
  const all = (name: string) => descriptions(TOOL_DEFS.find((t) => t.name === name)).join('\n') + TOOL_DEFS.find((t) => t.name === name)!.description
  const review = all('set_review')
  assert.match(review, /approve: you would merge it yourself; look: the user should decide/)
  assert.match(review, /mag keeps its own floor[\s\S]*attaches those blockers itself/)
  assert.match(review, /never give it/)
  assert.match(review, /routine: true, last/)
  assert.match(review, /request_changes → changes, look → look, approve → merge/)
  const inventory = all('set_inventory')
  assert.match(inventory, /change rename with from, never a del and an add/)
  assert.match(inventory, /also when only its body changes/)
  assert.match(inventory, /not imports inside a module/)
  assert.match(all('set_pr_review'), /v1 only: request_changes with any blocker/)
  assert.match(all('show_diagram'), /each in the module that owns it/)
})

test('show_canvas tells agents to build on mag\'s classes and bring no palette or fonts, with the reason (prompts-use-the-models-to.7)', () => {
  const d = TOOL_DEFS.find((t) => t.name === 'show_canvas')!.description
  assert.ok(d.includes(CANVAS_CLASSES))
  assert.match(d, /so the user sees one product/)
  assert.match(d, /Bring no palette, fonts or background of your own/)
  assert.doesNotMatch(d, /inline CSS/)
})

test('show_canvas tells agents to embed a diagram or another canvas by id at the top level, never redraw it (one-canvas-with-real-diagrams.1)', () => {
  const d = TOOL_DEFS.find((t) => t.name === 'show_canvas')!.description
  assert.ok(d.includes('<mag-canvas id="<its id>"></mag-canvas> at the top level of the page'))
  assert.match(d, /Never redraw a diagram in the page \(no Mermaid/)
})
