import { test } from 'node:test'
import assert from 'node:assert/strict'
import { folderVocabulary, moduleResolver } from './vocabulary.ts'

test('folderVocabulary: a module per top folder, one per child of apps/, packages/ or src/ (reviews-ahent-reviuit-pr-timeitiv.3)', () => {
  const v = folderVocabulary(['src/a.ts', 'src/b/c.ts', 'packages/core/src/x.ts', 'apps/web/main.go', 'README.md', 'packages/top.ts', 'infra/main.tf'])
  assert.deepEqual(v.modules, [
    { id: 'src', paths: ['src'] },
    { id: 'src-b', paths: ['src/b'] },
    { id: 'packages-core', paths: ['packages/core'] },
    { id: 'apps-web', paths: ['apps/web'] },
    { id: 'packages', paths: ['packages'] },
    { id: 'infra', paths: ['infra'] },
  ])
  const moduleOf = moduleResolver(v)
  assert.equal(moduleOf('packages/core/src/x.ts'), 'packages-core')
  assert.equal(moduleOf('packages/top.ts'), 'packages')
  assert.equal(moduleOf('src/b/c.ts'), 'src-b')
  assert.equal(moduleOf('src/a.ts'), 'src')
  assert.equal(moduleOf('README.md'), null)
})
