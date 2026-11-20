import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CANVAS_CLASSES, CANVAS_CSS, TOKENS_CSS, HEIGHT_MESSAGE, canvasDocument, canvasPieces, canvasTheme } from './index.ts'

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

test('canvasPieces: a page without embeds is one piece, as it is', () => {
  const html = '<h1>t</h1><div><mag-canvas id="x"></mag-canvas></div>'
  assert.deepEqual(canvasPieces(html), [{ kind: 'html', html }])
  assert.deepEqual(canvasPieces(''), [{ kind: 'html', html: '' }])
})

test('canvasPieces: top-level <mag-canvas id> tags split the page; empty pieces go', () => {
  assert.deepEqual(canvasPieces('<h1>Review</h1>\n<mag-canvas id="d1"></mag-canvas>\n<p>after</p><mag-canvas id=\'d2\'/>  <mag-canvas id=d3>ignored</mag-canvas>'), [
    { kind: 'html', html: '<h1>Review</h1>\n' },
    { kind: 'embed', id: 'd1' },
    { kind: 'html', html: '\n<p>after</p>' },
    { kind: 'embed', id: 'd2' },
    { kind: 'embed', id: 'd3' },
  ])
  assert.deepEqual(canvasPieces('<MAG-CANVAS data-id="no" ID="a"></MAG-CANVAS>'), [{ kind: 'embed', id: 'a' }])
  assert.deepEqual(canvasPieces('<mag-canvas></mag-canvas>'), [{ kind: 'embed', id: '' }])
})

test('canvasPieces: a tag inside an element, a comment or a script stays HTML; unclosed <p> and <li> do not nest', () => {
  const nested = '<div class="card"><mag-canvas id="in"></mag-canvas></div>'
  assert.deepEqual(canvasPieces(`${nested}<mag-canvas id="out"></mag-canvas>`), [{ kind: 'html', html: nested }, { kind: 'embed', id: 'out' }])
  const hidden = '<!-- <mag-canvas id="c"></mag-canvas> --><script>const s = "<mag-canvas id=\'s\'>"</script><img src="a.png"><br/>'
  assert.deepEqual(canvasPieces(`${hidden}<mag-canvas id="out"></mag-canvas>`), [{ kind: 'html', html: hidden }, { kind: 'embed', id: 'out' }])
  assert.deepEqual(canvasPieces('<p>one<p>two<ul><li>a<li>b</ul><mag-canvas id="x"></mag-canvas>').map((p) => p.kind), ['html', 'embed'])
  assert.deepEqual(canvasPieces('<p>text<mag-canvas id="x"></mag-canvas>').map((p) => p.kind), ['html', 'embed'])
})

test('canvasPieces: every piece keeps the page\'s styles and a full document\'s head', () => {
  const style = '<style>.x { gap: var(--sp-2) }</style>'
  const link = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/x.css">'
  assert.deepEqual(canvasPieces(`<h1>a</h1>${style}<mag-canvas id="d"></mag-canvas><p>b</p>${link}`), [
    { kind: 'html', html: `${style}${link}<h1>a</h1>` },
    { kind: 'embed', id: 'd' },
    { kind: 'html', html: `${style}${link}<p>b</p>` },
  ])
  const doc = '<!doctype html><html><head><title>t</title></head><body class="b"><h1>a</h1><mag-canvas id="d"></mag-canvas><p>b</p></body></html>'
  assert.deepEqual(canvasPieces(doc), [
    { kind: 'html', html: '<!doctype html><html><head><title>t</title></head><body class="b"><h1>a</h1></body></html>' },
    { kind: 'embed', id: 'd' },
    { kind: 'html', html: '<!doctype html><html><head><title>t</title></head><body class="b"><p>b</p></body></html>' },
  ])
})

test('canvasDocument with reportHeight posts the page\'s height to its parent', () => {
  assert.ok(!canvasDocument('<p>x</p>', 'light').includes(HEIGHT_MESSAGE))
  const doc = canvasDocument('<p>x</p>', 'light', { reportHeight: true })
  assert.match(doc, new RegExp(`<script data-mag-canvas>[^<]*parent\\.postMessage\\(\\{ ${HEIGHT_MESSAGE}:`))
  assert.ok(doc.indexOf(HEIGHT_MESSAGE) < doc.indexOf('<body>'))
})
