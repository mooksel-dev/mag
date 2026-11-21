import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_COLORS, TOKENS_CSS } from './index.ts'

const block = (selector: string) => {
  const at = TOKENS_CSS.indexOf(`${selector} {`)
  return TOKENS_CSS.slice(at, TOKENS_CSS.indexOf('\n}', at))
}
const values = (css: string) => new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const light = values(block(':root'))
const dark = values(block("[data-theme='dark']"))
/** A token's value in a theme: dark overrides :root, aliases followed. */
const resolve = (name: string, theme: 'light' | 'dark'): string | undefined => {
  const v = (theme === 'dark' ? dark.get(name) : undefined) ?? light.get(name)
  const alias = v?.match(/^var\((--[\w-]+)\)$/)
  return alias ? resolve(alias[1], theme) : v
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const V2 = ['--chrome', '--canvas', '--surface', '--surface-2', '--raised', '--line', '--line-2', '--hover', '--select', '--t1', '--t2', '--t3', '--t4',
  '--acc', '--acc-fg', '--acc-t', '--amber', '--amber-t', '--green', '--green-t', '--red', '--red-t', '--blue', '--blue-t', '--sh-1', '--sh-2', '--sh-win', '--hi']

test('the v2 tokens are set for light and for dark', () => {
  for (const t of V2) {
    assert.ok(light.has(t), `light ${t}`)
    assert.ok(dark.has(t), `dark ${t}`)
  }
})

test('neutrals step chrome < canvas < surface < raised (light: canvas, surface and raised are all white)', () => {
  const steps = ['--chrome', '--canvas', '--surface', '--raised']
  const dl = steps.map((s) => luminance(resolve(s, 'dark')!))
  const ll = steps.map((s) => luminance(resolve(s, 'light')!))
  for (let i = 1; i < steps.length; i++) {
    assert.ok(dl[i] > dl[i - 1], `dark ${steps[i]} above ${steps[i - 1]}`)
    assert.ok(ll[i] >= ll[i - 1], `light ${steps[i]} not below ${steps[i - 1]}`)
  }
  assert.ok(luminance(resolve('--panel', 'dark')!) > luminance(resolve('--bg', 'dark')!), 'the panel is lighter than the bg in dark')
})

test('shadows are per theme, not one rgba for both', () => {
  for (const t of ['--sh-1', '--sh-2', '--sh-win']) assert.notEqual(light.get(t), dark.get(t), t)
  assert.equal(light.get('--shadow'), 'var(--sh-1)')
})

test('the names before v2 still resolve in both themes, so old canvases render', () => {
  const OLD = ['--bg', '--side', '--line', '--text', '--muted', '--faint', '--accent', '--soft', '--surface', '--border', '--hover', '--row-line', '--subtle', '--code',
    '--panel', '--on-accent', '--status', '--badge', '--on-badge', '--scrim', '--shadow', '--amber-bg', '--amber-fg', '--amber-line', '--violet-bg', '--violet-fg',
    '--info-bg', '--info-fg', '--green-bg', '--green-fg', '--danger-bg', '--danger-fg', '--danger-line', '--warn-bg', '--warn-fg', '--warn-line', '--notice-bg', '--notice-fg']
  for (const t of OLD) for (const theme of ['light', 'dark'] as const) assert.ok(resolve(t, theme), `${t} in ${theme}`)
  assert.notEqual(resolve('--soft', 'light'), resolve('--info-bg', 'light'))
})

test('project colours are tokens too, the same values projects store', () => {
  PROJECT_COLORS.forEach((c, i) => assert.equal(light.get(`--proj-${i + 1}`), c))
})
