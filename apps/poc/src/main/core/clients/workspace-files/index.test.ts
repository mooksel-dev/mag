import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceFiles } from './index.ts'

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'mag-wsfiles-'))
  const opened: string[][] = []
  return { root, opened, files: createWorkspaceFiles(() => root, (a) => void opened.push(a)) }
}

test('workspace-files: versions are v<N>.md in <ws>/deliverables/<slug>/; a taken slug gets a suffix', () => {
  const { root, files } = setup()
  assert.equal(files.createDeliverable('personal', 'weekly'), 'weekly')
  assert.equal(files.createDeliverable('personal', 'weekly'), 'weekly-2')
  const path = files.writeVersion('personal', 'weekly', 1, '# One')
  assert.equal(path, join(root, 'personal', 'deliverables', 'weekly', 'v1.md'))
  assert.equal(readFileSync(path, 'utf8'), '# One\n')
  files.writeVersion('personal', 'weekly', 2, 'two\n')
  writeFileSync(join(root, 'personal', 'deliverables', 'weekly', 'notes.txt'), 'x')
  assert.deepEqual(files.versions('personal', 'weekly'), [1, 2])
  assert.equal(files.readVersion('personal', 'weekly', 2), 'two\n')
  assert.throws(() => files.writeVersion('personal', 'weekly', 2, 'again'), /exists/)
  assert.throws(() => files.readVersion('personal', 'weekly', 3), /No version 3/)
})

test('workspace-files: a missing folder has no versions; paths in names are refused', () => {
  const { files, opened } = setup()
  assert.deepEqual(files.versions('personal', 'none'), [])
  assert.equal(files.exists('personal', 'none'), false)
  assert.throws(() => files.writeVersion('personal', 'none', 1, 'x'), /No deliverable folder/)
  assert.throws(() => files.createDeliverable('..', 'x'), /Not a workspace folder name/)
  assert.throws(() => files.dirOf('personal', '../etc'), /Not a deliverable folder name/)
  assert.throws(() => files.versionPath('personal', 'x', 0), /Not a version/)
  files.reveal('/tmp/x.md')
  assert.deepEqual(opened, [['-R', '/tmp/x.md']])
})
