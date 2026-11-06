import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TOKENS_CSS } from '@mag/core'
import { appStyles, reviewPage } from './reviewPage.ts'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
const used = (css: string) => new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))

test('the app\'s styles.css keeps no tokens of its own: they all come from TOKENS_CSS (prompts-use-the-models-to.7)', () => {
  assert.doesNotMatch(styles, /^:root\s*\{|\[data-theme='dark'\]\s*\{/m)
  const known = new Set([...defined(TOKENS_CSS), ...defined(styles)])
  assert.deepEqual([...used(styles)].filter((t) => !known.has(t)), [])
})

test('review.html carries the same tokens as the review window, before the app\'s styles', () => {
  const page = reviewPage({ title: 'Review · A-1 <x>', css: styles, extra: '.s {}', body: '<main>r</main>' })
  assert.ok(page.includes(`<style>${TOKENS_CSS}${styles}</style>`))
  assert.equal(appStyles(styles), TOKENS_CSS + styles)
  assert.match(page, /<html lang="en" data-theme="light">/)
  assert.match(page, /<title>Review · A-1 &lt;x&gt;<\/title>/)
  assert.match(page, /<style>\.s \{\}<\/style>\n<\/head>\n<body><div id="root"><main>r<\/main><\/div><\/body>/)
})
