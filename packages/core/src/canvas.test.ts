import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CANVAS_CLASSES, CANVAS_CSS, TOKENS_CSS, canvasDocument, canvasTheme } from './index.ts'

const block = (selector: string) => {
  const at = TOKENS_CSS.indexOf(`${selector} {`)
  return TOKENS_CSS.slice(at, TOKENS_CSS.indexOf('\n}', at))
}
const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
const used = (css: string) => new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))

test('a canvas without its own CSS gets mag\'s tokens, canvas.css and the app\'s theme (prompts-use-the-models-to.7)', () => {
  for (const theme of ['light', 'dark'] as const) {
    const doc = canvasDocument('<div class="card"><span class="tag amber">waiting</span></div>', theme)
    assert.match(doc, new RegExp(`^<!doctype html><html data-theme="${theme}"><head>`))
    assert.ok(doc.includes(TOKENS_CSS) && doc.includes(CANVAS_CSS))
    assert.ok(doc.indexOf('</head><body><div class="card">') > doc.indexOf(CANVAS_CSS))
  }
})

test('a full document keeps its head and body; mag\'s style comes first so the page can refine it', () => {
  const page = '<!DOCTYPE html>\n<html lang="en" data-theme=light><head><title>t</title><style>.x { color: var(--accent) }</style></head><body><p>hi</p></body></html>'
  const doc = canvasDocument(page, 'dark')
  assert.match(doc, /^<!DOCTYPE html>\n<html data-theme="dark" lang="en"><head><style data-mag-canvas>/)
  assert.equal(/<html[^>]*>/.exec(doc)?.[0], '<html data-theme="dark" lang="en">')
  assert.ok(doc.indexOf(CANVAS_CSS) < doc.indexOf('<title>t</title>'))
  assert.ok(doc.endsWith('<body><p>hi</p></body></html>'))
  assert.match(canvasDocument('<html><body>b</body></html>', 'light'), /^<html data-theme="light"><head><style data-mag-canvas>[\s\S]*<\/style><\/head><body>b<\/body><\/html>$/)
})

test('a page with its own palette (CSS without mag\'s tokens) stays on light, as it was written', () => {
  assert.equal(canvasTheme('<style>body { background: #fff; color: #222 }</style><p>x</p>', 'dark'), 'light')
  assert.equal(canvasTheme('<link rel="stylesheet" href="https://cdn.jsdelivr.net/x.css">', 'dark'), 'light')
  assert.equal(canvasTheme('<style>.x { gap: var(--sp-2) }</style>', 'dark'), 'dark')
  assert.equal(canvasTheme('<p style="margin:0">x</p>', 'dark'), 'dark')
  assert.match(canvasDocument('<style>p { color: #222 }</style><p>x</p>', 'dark'), /^<!doctype html><html data-theme="light">/)
})

test('canvas.css uses only tokens that light and dark both define', () => {
  const light = defined(block(':root'))
  const dark = defined(block("[data-theme='dark']"))
  const missing = [...used(CANVAS_CSS)].filter((t) => !light.has(t) || (!dark.has(t) && !/^--(sp|r|fs|lh)/.test(t)))
  assert.deepEqual(missing, [])
  assert.doesNotMatch(CANVAS_CSS, /#[0-9a-f]{3,6}\b|rgba?\(/i)
})

test('the classes told to agents are the ones canvas.css styles', () => {
  for (const c of ['card', 'tag', 'table', 'callout', 'grid', 'muted', 'small', 'accent', 'amber', 'green', 'danger', 'cols-2', 'cols-3']) {
    assert.ok(CANVAS_CLASSES.includes(c), c)
    assert.ok(CANVAS_CSS.includes(`.${c}`), c)
  }
})
