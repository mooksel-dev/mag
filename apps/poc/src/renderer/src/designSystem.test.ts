import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { ICONS } from './ui/icons.ts'

const here = new URL('./', import.meta.url)
const styles = readFileSync(new URL('./styles.css', here), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const sources = (readdirSync(here, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx'))
/** A .tsx file without its comments: glyphs in docs are fine, on screen they are not. */
const code = (f: string) => readFileSync(new URL(f, here), 'utf8').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '')

test('styles.css hard-codes no colour or shadow: they come from the tokens', () => {
  assert.deepEqual(styles.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [], [])
})

test('no glyph or emoji stands in for an icon in the renderer: ui/Icon draws them', () => {
  const GLYPHS = /[↑■📎＋⌕⚙★⧉✕⋯▸▾×☀☾⚠↗▶●○◐▲▼↻]/u
  const found = sources.flatMap((f) => code(f).split('\n').filter((l) => GLYPHS.test(l)).map((l) => `${f}: ${l.trim()}`))
  assert.deepEqual(found, [])
  assert.doesNotMatch(styles, /content:\s*'[^']*[▸▾]/)
})

test('every icon a screen names is in the set, and the set draws in currentColor only', () => {
  const names = new Set(Object.keys(ICONS))
  const used = sources.flatMap((f) => [...code(f).matchAll(/<Icon name="([\w-]+)"|iconSvg\('([\w-]+)'/g)].map((m) => m[1] ?? m[2]))
  assert.ok(used.length > 20)
  assert.deepEqual(used.filter((n) => !names.has(n)), [])
  for (const [n, svg] of Object.entries(ICONS)) assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgba?\(|fill="(?!none)|stroke="/i, n)
})

test('one Pill, one Seg, one selected row: the old chip and segmented variants are gone', () => {
  const OLD = ['status', 'diffpill', 'wlbadge', 'stepchip', 'stripchip', 'verdict', 'tag', 'badge', 'mptabs', 's-planning', 's-done']
  for (const c of OLD) assert.doesNotMatch(styles, new RegExp(`\\.${c}\\b`), c)
  assert.equal(styles.match(/^\.pill \{/gm)?.length, 1)
  assert.equal(styles.match(/^\.seg \{/gm)?.length, 1)
  assert.doesNotMatch(styles, /\.seg\.views|\.titlebar \.seg|\.chathead \.seg|\.mpeffort \.seg/)
  const selected = styles.match(/^.*\.on[^{]*\{[^}]*background: var\(--select\)[^}]*\}$/gm) ?? []
  assert.equal(selected.length, 1, 'one rule for the selected row')
  for (const row of ['wlrow', 'wlsess', 'wlidea', 'mtgrow', 'prow', 'sphit', 'setitem', 'mprow']) {
    assert.ok(selected[0].includes(`.${row}.on`), row)
    assert.doesNotMatch(styles.replace(selected[0], ''), new RegExp(`\\.${row}\\.on\\s*\\{`), `${row} has no selected style of its own`)
  }
})

test('PublishCard renders approvals with a destination (Chat); Claim is not used in production yet; the fixtures page loads lazily', () => {
  const importers = (name: string) => sources.filter((f) => new RegExp(`from '\\.\\.?\\/(ui\\/)?${name}'`).test(code(f))).sort()
  assert.deepEqual(importers('PublishCard'), ['Chat.tsx', 'UiFixtures.tsx'])
  assert.deepEqual(importers('Claim'), ['UiFixtures.tsx'])
  const all = (readdirSync(here, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && f !== 'UiFixtures.tsx')
  assert.deepEqual(all.filter((f) => /from '\.\/UiFixtures'/.test(code(f))), [], 'no static import of the fixtures page')
  assert.match(code('main.tsx'), /lazy\(\(\) => import\('\.\/UiFixtures'\)\)/)
})
