// One visual system for canvases (prompts-use-the-models-to.7): every HTML page an agent shows the user is wrapped with
// mag's tokens and a small stylesheet on them, in the app's theme, so mockups, comparisons and the app look like one
// product. Agents build on the classes below instead of bringing a palette or fonts of their own.

import { TOKENS_CSS } from './tokens.ts'

export { TOKENS_CSS }

export type CanvasTheme = 'light' | 'dark'

/** The classes a canvas may use, as told to agents (show_canvas). Meanings follow the app's: see TOKENS_CSS. */
export const CANVAS_CLASSES = `card (a box; .accent marks the chosen or recommended one), tag (a small label; .amber = waiting on the user, \
.green = working or as planned, .accent = the primary one, .danger = a problem), table, callout (a note; .amber, .green, .danger), \
grid (cards side by side; .cols-2, .cols-3), muted, small. Plain h1–h3, p, a, code, pre, button (.primary) and input are styled too.`

/** The canvas stylesheet: only mag's tokens, so it follows light and dark. */
export const CANVAS_CSS = `
* { box-sizing: border-box; }
html, body { background: var(--surface); }
body { margin: 0; padding: var(--sp-4) var(--sp-5); color: var(--text); }
h1 { font-size: var(--fs-xl); font-weight: 600; margin: 0 0 var(--sp-3); }
h2 { font-size: var(--fs-lg); font-weight: 600; margin: var(--sp-6) 0 var(--sp-2); }
h3 { font-size: var(--fs-md); font-weight: 600; margin: var(--sp-4) 0 var(--sp-2); }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p { margin: 0 0 var(--sp-3); }
a { color: var(--accent); }
hr { border: 0; border-top: 1px solid var(--line); margin: var(--sp-4) 0; }
code, pre { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; background: var(--code); border-radius: var(--r-sm); }
code { padding: 1px 4px; }
pre { padding: var(--sp-3); overflow: auto; }
pre code { padding: 0; background: none; }
button, input, select, textarea { font: inherit; color: inherit; }
button { border: 1px solid var(--border); background: var(--surface); border-radius: var(--r); padding: 6px 12px; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
input, select, textarea { border: 1px solid var(--border); border-radius: var(--r); padding: 7px 10px; background: var(--surface); }
.muted { color: var(--muted); }
.small { font-size: var(--fs-sm); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: var(--sp-4); box-shadow: var(--shadow); }
.card.accent { border-color: var(--accent); }
.card > :last-child { margin-bottom: 0; }
.tag { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); line-height: 16px; padding: 2px 8px; border-radius: var(--r-pill); background: var(--status); color: var(--muted); white-space: nowrap; }
.tag.amber { background: var(--amber-bg); color: var(--amber-fg); }
.tag.green { background: var(--green-bg); color: var(--green-fg); }
.tag.accent { background: var(--soft); color: var(--accent); }
.tag.danger { background: var(--danger-bg); color: var(--danger-fg); }
table, .table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); margin: 0 0 var(--sp-3); }
th, td { text-align: left; vertical-align: top; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--row-line); }
th { color: var(--muted); font-weight: 600; border-bottom-color: var(--line); }
.callout { background: var(--info-bg); color: var(--text); border-left: 3px solid var(--accent); border-radius: var(--r); padding: var(--sp-3) var(--sp-4); margin: 0 0 var(--sp-3); }
.callout.amber { background: var(--amber-bg); border-left-color: var(--amber-line); }
.callout.green { background: var(--green-bg); border-left-color: var(--green-fg); }
.callout.danger { background: var(--danger-bg); border-left-color: var(--danger-line); }
.callout > :last-child { margin-bottom: 0; }
.grid { display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 0 0 var(--sp-3); }
.grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
`

const OWN_CSS = /<style\b|<link\b[^>]*\brel\s*=\s*["']?stylesheet/i

/**
 * The theme a canvas renders in: the app's, unless the page brings its own CSS without mag's tokens. Such a page was
 * written with a palette of its own, on light (canvases before prompts-use-the-models-to.7), and would lose its text on
 * a dark background.
 */
export function canvasTheme(html: string, theme: CanvasTheme): CanvasTheme {
  return OWN_CSS.test(html) && !html.includes('var(--') ? 'light' : theme
}

/**
 * An agent's HTML as the document a canvas frame shows: mag's tokens and CANVAS_CSS first, so the page's own CSS can
 * still refine them, and `data-theme` on <html>. A full document keeps its head and body; a fragment is wrapped.
 */
export function canvasDocument(html: string, theme: CanvasTheme): string {
  const shown = canvasTheme(html, theme)
  const style = `<style data-mag-canvas>${TOKENS_CSS}${CANVAS_CSS}</style>`
  const htmlTag = /<html\b[^>]*>/i.exec(html)
  if (!htmlTag) {
    const body = html.replace(/^\s*<!doctype[^>]*>/i, '')
    return `<!doctype html><html data-theme="${shown}"><head><meta charset="utf-8">${style}</head><body>${body}</body></html>`
  }
  const tag = htmlTag[0].replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '').replace(/^<html/i, `<html data-theme="${shown}"`)
  const doc = html.slice(0, htmlTag.index) + tag + html.slice(htmlTag.index + htmlTag[0].length)
  const head = /<head\b[^>]*>/i.exec(doc)
  const at = head ? head.index + head[0].length : htmlTag.index + tag.length
  return doc.slice(0, at) + (head ? style : `<head>${style}</head>`) + doc.slice(at)
}
