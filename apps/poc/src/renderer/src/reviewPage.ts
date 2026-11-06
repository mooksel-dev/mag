// The exported review.html's shell (review-v2-part-2-v1-2.3): the review window's markup with the app's own styles on
// mag's tokens, the same TOKENS_CSS the app puts in its page (prompts-use-the-models-to.7), so the archive looks like
// the window it came from.
import { TOKENS_CSS } from '@mag/core'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The app's stylesheet as a page or an SVG carries it: tokens first, then `css` (styles.css). */
export const appStyles = (css: string) => TOKENS_CSS + css

/** review.html: `body` (static markup) under `title`, styled by `css` (styles.css) and `extra` (the static layout). */
export function reviewPage({ title, css, extra, body }: { title: string; css: string; extra: string; body: string }): string {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${appStyles(css)}</style>
<style>${extra}</style>
</head>
<body><div id="root">${body}</div></body>
</html>
`
}
