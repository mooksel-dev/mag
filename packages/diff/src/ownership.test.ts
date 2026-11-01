import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ArchNode } from '@mag/core'
import { carryIds, sharedPaths, unowned } from './ownership.ts'

const mod = (id: string, paths: string[] = [], children?: ArchNode[], level?: ArchNode['level']): ArchNode => ({
  id,
  name: id,
  description: '',
  uses: [],
  ...(paths.length && { paths }),
  ...(level && { level }),
  ...(children && { children }),
})

test('unowned lists code files no module owns, tests included, other files not', () => {
  const v = { modules: [{ id: 'app', paths: ['apps/web'] }, { id: 'db', paths: ['db/*.sql'] }] }
  const files = ['apps/web/a.ts', 'apps/api/b.ts', 'apps/api/b.test.ts', 'db/1.sql', 'db/seed/2.sql', 'README.md', 'package.json', 'types.d.ts']
  assert.deepEqual(unowned(v, files), ['apps/api/b.ts', 'apps/api/b.test.ts', 'db/seed/2.sql'])
})

test('sharedPaths finds a path two modules give, however written', () => {
  const v = { modules: [{ id: 'a', paths: ['src/x', 'src/y'] }, { id: 'b', paths: ['./src/x/'] }, { id: 'c', paths: ['src/x/inner'] }] }
  assert.deepEqual(sharedPaths(v), [{ path: 'src/x', modules: ['a', 'b'] }])
})

test('carryIds gives a renamed module its old id by the files it owns', () => {
  const files = ['app/ui/a.tsx', 'app/ui/b.tsx', 'app/ui/c.tsx', 'app/store/s.ts', 'app/tasks/t.ts', 'app/tasks/u.ts']
  const prev = [mod('app', ['app'], [mod('ui', ['app/ui']), mod('store', ['app/store']), mod('tasks', ['app/tasks'])]), mod('github')]
  const next = [
    mod('desktop', ['app'], [
      // Most of ui's files under a new id; a new module takes one of them.
      mod('views', ['app/ui/a.tsx', 'app/ui/b.tsx']),
      mod('widgets', ['app/ui/c.tsx']),
      mod('store', ['app/store']),
      // Half of tasks' files is enough.
      mod('tasks-a', ['app/tasks/t.ts']),
    ]),
    mod('gh'),
  ]
  assert.deepEqual([...carryIds(prev, next, files)], [['desktop', 'app'], ['views', 'ui'], ['tasks-a', 'tasks']])
})

test('carryIds keeps ids that exist, pairs each old id once and only on one level', () => {
  const files = ['a/x.ts', 'a/y.ts']
  const prev = [mod('old', ['a'])]
  // Both new ids own all of old's files: the system takes it, the module may not.
  const next = [mod('sys', ['a'], [mod('inner', ['a/x.ts', 'a/y.ts'])])]
  assert.deepEqual([...carryIds(prev, next, files)], [['sys', 'old']])
  assert.deepEqual([...carryIds(prev, [mod('old', ['a']), mod('new', ['a/x.ts'])], files)], [])
})

test('carryIds without files compares the paths themselves', () => {
  const prev = [mod('web', ['apps/web'], [mod('api-client', ['apps/web/src/api'], undefined, 'module')])]
  const next = [mod('web', ['apps/web'], [mod('http', ['apps/web/src/api'])])]
  assert.deepEqual([...carryIds(prev, next, [])], [['http', 'api-client']])
})
