import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentInfo } from '@mag/core'
import { choiceLabel, effortLabel, effortsFor, fillPercent, formatTokens, gaugeLevel, keptEffort } from './modelChoice.ts'

const claude: AgentInfo = {
  id: 'claude-code',
  displayName: 'Claude Code',
  detected: true,
  models: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', version: '5.5', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], alias: 'opus' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', version: '5.5', contextWindow: 200_000, efforts: [] },
  ],
}
const codex: AgentInfo = {
  id: 'codex',
  displayName: 'Codex',
  detected: false,
  models: [{ id: 'gpt-6', label: 'GPT-6', version: '6', contextWindow: null, efforts: ['low', 'medium', 'high', 'xhigh'] }],
}
const agents = [claude, codex]

test('formatTokens: as is below 1k, then k, then M with one decimal', () => {
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(45_231), '45k')
  assert.equal(formatTokens(200_000), '200k')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(1_540_000), '1.5M')
})

test('gaugeLevel: neutral below 70, amber 70 to 90, red above 90', () => {
  assert.equal(gaugeLevel(0), 'ok')
  assert.equal(gaugeLevel(69), 'ok')
  assert.equal(gaugeLevel(70), 'warn')
  assert.equal(gaugeLevel(90), 'warn')
  assert.equal(gaugeLevel(91), 'full')
  assert.equal(gaugeLevel(100), 'full')
})

test('fillPercent: whole percent capped at 100; an unknown or zero window has none', () => {
  assert.equal(fillPercent(620_000, 1_000_000), 62)
  assert.equal(fillPercent(1_200_000, 1_000_000), 100)
  assert.equal(fillPercent(5000, null), null)
  assert.equal(fillPercent(5000, 0), null)
})

test('effortsFor: the model\'s own; the default or an unknown model takes any its provider\'s models take', () => {
  assert.deepEqual(effortsFor(claude, 'claude-haiku-5-5'), [])
  assert.deepEqual(effortsFor(claude, 'opus'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(effortsFor(codex, null), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(effortsFor(codex, 'gpt-legacy'), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(effortsFor(undefined, null), [])
})

test('keptEffort: kept when the new model takes it, else the default', () => {
  assert.equal(keptEffort(claude, 'claude-opus-5-5', 'max'), 'max')
  assert.equal(keptEffort(claude, 'claude-haiku-5-5', 'high'), null)
  assert.equal(keptEffort(codex, 'gpt-6', 'max'), null)
  assert.equal(keptEffort(codex, null, 'high'), 'high')
  assert.equal(keptEffort(claude, 'claude-opus-5-5', null), null)
})

test('choiceLabel: model label (an alias shows its model), the effort when set; the default names the last run', () => {
  assert.equal(choiceLabel(agents, { agent: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }), 'Opus 5.5 · High')
  assert.equal(choiceLabel(agents, { agent: 'claude-code', model: 'opus', effort: null }), 'Opus 5.5')
  assert.equal(choiceLabel(agents, { agent: 'claude-code', model: null, effort: null }, 'claude-haiku-5-5'), 'Default (Haiku 5.5)')
  assert.equal(choiceLabel(agents, { agent: 'claude-code', model: null, effort: 'low' }), 'Claude Code default · Low')
  assert.equal(choiceLabel(agents, { agent: 'codex', model: 'gpt-legacy', effort: null }), 'gpt-legacy')
  assert.equal(choiceLabel([], { agent: 'codex', model: null, effort: null }), 'codex default')
})

test('effortLabel: capitalised; no effort is Auto', () => {
  assert.equal(effortLabel(null), 'Auto')
  assert.equal(effortLabel('xhigh'), 'XHigh')
  assert.equal(effortLabel('max'), 'Max')
})
