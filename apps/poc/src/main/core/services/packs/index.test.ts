import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceFiles } from '../../clients/workspace-files/index.ts'
import { createPacks, packText } from './index.ts'

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'mag-packs-'))
  const packs = createPacks({ files: createWorkspaceFiles(() => root), now: () => Date.UTC(2026, 10, 21) })
  return { root, packs }
}

test('packs: defaults are seeded for report, assessment, proposal and reply, never over the user\'s files', () => {
  const { root, packs } = setup()
  assert.deepEqual(packs.seedDefaults('personal').sort(), ['assessment', 'proposal', 'reply', 'report'])
  for (const kind of ['report', 'assessment', 'proposal', 'reply'])
    for (const f of ['prompt', 'template', 'rubric', 'rules']) assert.ok(readFileSync(join(root, 'personal', 'packs', kind, `${f}.md`), 'utf8').trim())
  writeFileSync(join(root, 'personal', 'packs', 'report', 'prompt.md'), 'mine\n')
  unlinkSync(join(root, 'personal', 'packs', 'report', 'template.md'))
  assert.deepEqual(packs.seedDefaults('personal'), [])
  const pack = packs.resolve('personal', null, 'report')
  assert.equal(pack.prompt?.text, 'mine\n')
  assert.equal(pack.template, null, 'a file the user deleted stays deleted')
  // A kind without defaults has no pack until the user writes one.
  assert.deepEqual(packs.resolve('personal', null, 'agenda'), { kind: 'agenda', prompt: null, template: null, rubric: null, rules: [] })
  assert.equal(packText(packs.resolve('personal', null, 'agenda')), '')
})

test('packs: a project overrides the workspace file by file; its rules add to the workspace\'s', () => {
  const { root, packs } = setup()
  const proj = join(root, 'work', 'projects', 'mag', 'packs', 'report')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'template.md'), '# Project template\n')
  packs.addRule('work', null, 'report', 'Use links, not raw text', 'said twice in one topic')
  packs.addRule('work', 'mag', 'report', '  Name the sprint\n in the title ')
  const pack = packs.resolve('work', 'mag', 'report')
  assert.equal(pack.template?.scope, 'project')
  assert.equal(pack.template?.text, '# Project template\n')
  assert.equal(pack.prompt?.scope, 'workspace')
  assert.equal(pack.rubric?.path, join(root, 'work', 'packs', 'report', 'rubric.md'))
  assert.deepEqual(pack.rules.map((r) => r.scope), ['workspace', 'project'])
  assert.match(pack.rules[0].text, /^- Use links, not raw text \(why: said twice in one topic\) · 2026-11-21$/m)
  assert.match(pack.rules[1].text, /^- Name the sprint in the title · 2026-11-21$/m)
  const text = packText(pack)
  assert.match(text, /## The report pack \(mag\)/)
  assert.match(text, /### Template \(the project's\)\n# Project template/)
  assert.match(text, /### Learned rules\n[\s\S]*Use links[\s\S]*The project's:\n[\s\S]*Name the sprint/)
  // Without the project, only the workspace's.
  const ws = packs.resolve('work', null, 'report')
  assert.equal(ws.template?.scope, 'workspace')
  assert.equal(ws.rules.length, 1)
})

test('packs: addRule appends to rules.md, made with its header when missing; refuses an empty or long rule', () => {
  const { root, packs } = setup()
  const path = packs.addRule('work', null, 'decision', 'One decision per line')
  assert.equal(path, join(root, 'work', 'packs', 'decision', 'rules.md'))
  packs.addRule('work', null, 'decision', 'Name who decided')
  const text = readFileSync(path, 'utf8')
  assert.match(text, /^# Rules\n/)
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('- ')), ['- One decision per line · 2026-11-21', '- Name who decided · 2026-11-21'])
  assert.throws(() => packs.addRule('work', null, 'decision', '   '), /needs its text/)
  assert.throws(() => packs.addRule('work', null, 'decision', 'x'.repeat(501)), /at most 500/)
  assert.throws(() => packs.addRule('work', '../x', 'decision', 'y'), /Not a project folder name/)
  // A rules.md with only its header adds nothing to the prompt.
  rmSync(path)
  writeFileSync(path, '# Rules\n')
  assert.deepEqual(packs.resolve('work', null, 'decision').rules, [])
})

test('packs: the assessment pack carries the impact rubric', () => {
  const { packs } = setup()
  const rubric = packs.resolve('personal', null, 'assessment').rubric?.text ?? ''
  assert.match(rubric, /outcome and by cost to others/)
  assert.match(rubric, /Self-merge, big PRs and follow-up fixes are not negatives on their own/)
  assert.match(rubric, /a real problem, solved, adopted, durable/)
  assert.match(rubric, /ownership context/)
})
