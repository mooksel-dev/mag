import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHOICE, DEFAULT_TEMPLATES, TASK_KEY_RE, agentAllowed, findModel, resolveChoice, rewriteKeys, sessionChoice, sessionJob, subtaskKey, type AgentModel, type ModelChoice } from './index.ts'

const opus: ModelChoice = { agent: 'claude-code', model: 'opus', effort: null }
const haiku: ModelChoice = { agent: 'claude-code', model: 'haiku', effort: 'low' }

test('resolveChoice returns the role choice', () => {
  assert.deepEqual(resolveChoice({ agents: { chat: opus } }, 'chat'), opus)
})

test('resolveChoice falls back to the default', () => {
  assert.deepEqual(resolveChoice({ agents: { chat: opus } }, 'groomer'), DEFAULT_CHOICE)
  assert.deepEqual(resolveChoice({ agents: {} }, 'architect'), DEFAULT_CHOICE)
})

test('reviewer follows developer unless set', () => {
  assert.deepEqual(resolveChoice({ agents: { developer: opus } }, 'reviewer'), opus)
  assert.deepEqual(resolveChoice({ agents: { developer: opus, reviewer: haiku } }, 'reviewer'), haiku)
  assert.deepEqual(resolveChoice({ agents: {} }, 'reviewer'), DEFAULT_CHOICE)
})

test('Codex never reviews: refused for the reviewer and a PR review, allowed elsewhere (prompts-use-the-models-to.2)', () => {
  for (const job of ['reviewer', 'pr-review'] as const) {
    const r = agentAllowed(job, 'codex')
    assert.equal(r.ok, false)
    assert.match(r.why, /no deny rules[\s\S]*writing to the PR/)
    assert.equal(agentAllowed(job, 'claude-code').ok, true)
  }
  for (const role of ['chat', 'groomer', 'developer', 'architect'] as const) assert.equal(agentAllowed(role, 'codex').ok, true, role)
})

test('a Codex developer reviews on Claude Code; a Codex reviewer set by hand is refused the same way', () => {
  const gpt: ModelChoice = { agent: 'codex', model: 'gpt-6-luna', effort: 'high' }
  assert.deepEqual(resolveChoice({ agents: { developer: gpt } }, 'reviewer'), DEFAULT_CHOICE)
  assert.deepEqual(resolveChoice({ agents: { developer: opus, reviewer: gpt } }, 'reviewer'), opus)
  assert.deepEqual(resolveChoice({ agents: { developer: gpt } }, 'developer'), gpt)
  assert.deepEqual(resolveChoice({ agents: { chat: gpt } }, 'chat'), gpt)
})

test('a choice stored before effort resolves with effort null', () => {
  const old = { agent: 'claude-code', model: 'opus' } as ModelChoice
  assert.deepEqual(resolveChoice({ agents: { chat: old } }, 'chat'), { agent: 'claude-code', model: 'opus', effort: null })
})

test("sessionChoice: the session's own choice wins over its role's default", () => {
  const max: ModelChoice = { agent: 'claude-code', model: 'claude-opus-5-5', effort: 'max' }
  const project = { agents: { chat: opus, developer: haiku } }
  assert.deepEqual(sessionChoice(project, { role: 'chat', choice: max }), max)
  assert.deepEqual(sessionChoice(project, { role: 'developer', choice: max }), max)
  // Missing or null: the role's default; a general child (role null) runs as chat.
  assert.deepEqual(sessionChoice(project, { role: 'chat' }), opus)
  assert.deepEqual(sessionChoice(project, { role: 'developer', choice: null }), haiku)
  assert.deepEqual(sessionChoice(project, { role: null }), opus)
  assert.deepEqual(sessionChoice(project, { role: 'reviewer' }), haiku)
})

test('sessionChoice: a Codex choice on a reviewer session is skipped, so Codex never reviews', () => {
  const gpt: ModelChoice = { agent: 'codex', model: 'gpt-6-luna', effort: null }
  assert.deepEqual(sessionChoice({ agents: { developer: opus } }, { role: 'reviewer', choice: gpt }), opus)
  assert.deepEqual(sessionChoice({ agents: { developer: gpt } }, { role: 'reviewer', choice: gpt }), DEFAULT_CHOICE)
  assert.deepEqual(sessionChoice({ agents: {} }, { role: 'developer', choice: gpt }), gpt)
})

test('sessionChoice for a pr-review job: Codex is skipped, its own and the role default', () => {
  const gpt: ModelChoice = { agent: 'codex', model: 'gpt-6-luna', effort: null }
  assert.deepEqual(sessionChoice({ agents: { chat: opus } }, { role: 'chat', choice: gpt }, 'pr-review'), opus)
  assert.deepEqual(sessionChoice({ agents: { chat: gpt } }, { role: 'chat', choice: gpt }, 'pr-review'), DEFAULT_CHOICE)
  assert.deepEqual(sessionChoice({ agents: { chat: gpt } }, { role: 'chat', choice: haiku }, 'pr-review'), haiku)
  assert.deepEqual(sessionChoice({ agents: { chat: gpt } }, { role: 'chat' }), gpt, 'any other job: as chosen')
})

test('sessionJob: a review topic (mag\'s, or one that owns or ran a review) is a pr-review; else its role', () => {
  const review = { type: 'review' as const, parentId: null, ownerSessionId: 'owner', prReview: null }
  assert.equal(sessionJob({ id: 'x', role: 'chat', reviewOf: 'r1' }, []), 'pr-review')
  assert.equal(sessionJob({ id: 'owner', role: 'chat' }, [review]), 'pr-review')
  assert.equal(sessionJob({ id: 'owner', role: 'chat' }, [{ ...review, type: 'dev' }]), 'chat')
  assert.equal(sessionJob({ id: 'x', role: null }, [review]), 'chat')
  assert.equal(sessionJob({ id: 'x', role: 'developer' }, [review]), 'developer')
})

test('findModel matches the id, the alias, or the id without [1m]', () => {
  const models: AgentModel[] = [{ id: 'claude-opus-5-5', label: 'Opus 5.5', version: '5.5', contextWindow: 1_000_000, efforts: [], alias: 'opus' }]
  assert.equal(findModel(models, 'claude-opus-5-5')?.label, 'Opus 5.5')
  assert.equal(findModel(models, 'opus')?.label, 'Opus 5.5')
  assert.equal(findModel(models, 'claude-opus-5-5[1m]')?.label, 'Opus 5.5')
  assert.equal(findModel(models, 'claude-sonnet-5-5'), undefined)
  assert.equal(findModel(models, null), undefined)
})

test('TASK_KEY_RE matches task and subtask keys', () => {
  assert.equal('see T-12 now'.match(TASK_KEY_RE)?.[0], 'T-12')
  assert.equal('see T-12.3 now'.match(TASK_KEY_RE)?.[0], 'T-12.3')
})

test('subtaskKey', () => {
  assert.equal(subtaskKey('T-1', 2), 'T-1.2')
})

test('rewriteKeys replaces whole keys only', () => {
  const map = { 'T-2': 'T-1.1', 'T-3': 'T-1.2' }
  assert.equal(rewriteKeys('T-2 and T-3, (T-2)', map), 'T-1.1 and T-1.2, (T-1.1)')
  assert.equal(rewriteKeys('T-21 T-2.1 xT-2 T-2x T-2-a wt/T-2', map), 'T-21 T-2.1 xT-2 T-2x T-2-a wt/T-2')
  assert.equal(rewriteKeys('see T-2.', map), 'see T-1.1.')
})

test('rewriteKeys does one pass', () => {
  assert.equal(rewriteKeys('T-2 T-3', { 'T-2': 'T-3', 'T-3': 'T-4' }), 'T-3 T-4')
})

test('rewriteKeys with an empty map returns the text', () => {
  assert.equal(rewriteKeys('T-2', {}), 'T-2')
})

test('dev template: options link their sketches, plan steps list changes and diagrams per repo (T-54)', () => {
  const t = DEFAULT_TEMPLATES.dev
  const options = t.slice(t.indexOf('# Options'), t.indexOf('# Changes'))
  const plan = t.slice(t.indexOf('# Plan'), t.indexOf('# Assumptions'))
  assert.match(options, /links its sketch diagrams: \[title\]\(canvas:<id>\)/)
  assert.match(plan, /per repository it changes: what changes there and the diagrams of that change/)
  assert.match(plan, /in <repo>: <what> \(\[title\]\(canvas:<id>\)/)
})
