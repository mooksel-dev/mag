import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Destination } from '@mag/core'
import { check, payload, preview } from './index.ts'

const SLACK: Destination = { kind: 'slack', target: 'data-removal', label: 'Slack #data-removal' }
const JIRA: Destination = { kind: 'jira', target: 'ABC-12', label: 'Jira ABC-12' }
const GITHUB: Destination = { kind: 'github', target: 'o/r#4', label: 'GitHub o/r#4' }
const DOCS: Destination = { kind: 'gdocs', target: 'd1', label: 'Google Docs d1' }

const rule = (d: Destination, input: unknown, id: string) => check(d, input).find((r) => r.id === id)

test('payload: the text of an MCP write and of gh and acli commands, heredocs and files included', () => {
  const cases: [unknown, ReturnType<typeof payload>][] = [
    [{ channel_id: 'C1', message: 'hi' }, { body: 'hi' }],
    [{ issueIdOrKey: 'ABC-1', commentBody: 'done' }, { body: 'done' }],
    [{ projectKey: 'ABC', summary: 'S', description: 'D' }, { title: 'S', body: 'D' }],
    [{ issueIdOrKey: 'ABC-1', transition: { id: '3' } }, null],
    [{ command: 'gh pr comment 12 --body "LGTM"' }, { body: 'LGTM' }],
    [{ command: 'gh -R o/r issue create -t "Bug" -b \'Steps: "x"\'' }, { title: 'Bug', body: 'Steps: "x"' }],
    [{ command: `gh pr comment 12 --body "$(cat <<'EOF'\nHe said "ok".\n\n**Next**\nEOF\n)"` }, { body: 'He said "ok".\n\n**Next**' }],
    [{ command: "gh pr review 3 --comment --body-file - <<'EOF'\nline 1\nline 2\nEOF" }, { body: 'line 1\nline 2' }],
    [{ command: 'gh issue comment 4 -F notes.md' }, { file: 'notes.md' }],
    [{ command: 'gh api repos/o/r/issues/4/comments -f body=hello' }, { body: 'hello' }],
    [{ command: 'gh api repos/o/r/issues/4/comments -F body=@reply.md' }, { file: 'reply.md' }],
    [{ command: 'gh pr close 12' }, null],
    [{ command: 'cd x && acli jira workitem comment create --key ABC-1 --body "Fixed in #3"' }, { body: 'Fixed in #3' }],
    [{ command: 'acli jira workitem create --project ABC --summary "Title" --description "Text"' }, { title: 'Title', body: 'Text' }],
  ]
  for (const [input, want] of cases) assert.deepEqual(payload(input), want, JSON.stringify(input))
})

test('preview: Slack renders mrkdwn as Slack shows it, a Markdown heading as typed', () => {
  const html = preview(SLACK, { message: '# Title\n*Ups* and _why_ ~old~ `a*b*c`\n> quoted <@U123|olena> in <#C9|eng>\n<https://x.io/a_b_c|link>' })
  assert.ok(html)
  assert.match(html, /^<div class="slack"># Title<br>/)
  assert.match(html, /<b>Ups<\/b> and <i>why<\/i> <s>old<\/s> <code>a\*b\*c<\/code>/)
  assert.match(html, /<blockquote>quoted <span class="mention">@olena<\/span> in <span class="mention">#eng<\/span><\/blockquote>/)
  assert.match(html, /<a href="https:\/\/x\.io\/a_b_c">link<\/a>/, 'emphasis does not reach into a link')
  assert.equal(preview(SLACK, { message: '<script>x</script>' }), '<div class="slack">&lt;script&gt;x&lt;/script&gt;</div>')
})

test('preview: Jira wiki markup, GitHub and other Markdown; null without text; a file body says so', () => {
  const wiki = preview(JIRA, { commentBody: 'h2. Done\n* item with {{code}}\n[PR|https://g.io/1]\n{code}\nx = *y*\n{code}' })
  assert.equal(wiki, '<h2>Done</h2><div class="li">• item with <code>code</code></div><p><a href="https://g.io/1">PR</a></p><pre><code>x = *y*</code></pre>')
  assert.match(preview(JIRA, { commentBody: '## Done\n- a' }) ?? '', /<h2>Done<\/h2>/, 'Markdown when it is not wiki markup')
  assert.match(preview(GITHUB, { command: 'gh pr comment 4 --body "a\nb"' }) ?? '', /a<br>b/, 'GitHub comments break lines')
  assert.doesNotMatch(preview(DOCS, { text: 'a\nb' }) ?? '', /<br>/)
  assert.match(preview(GITHUB, { command: 'gh issue create -t "T <x>" -b body' }) ?? '', /^<div class="pubtitle">T &lt;x&gt;<\/div>/)
  assert.equal(preview(JIRA, { issueIdOrKey: 'ABC-1' }), null)
  assert.match(preview(GITHUB, { command: 'gh issue comment 4 -F notes.md' }) ?? '', /<code>notes\.md<\/code>/)
})

test("check: Slack can't be edited after; others can", () => {
  assert.deepEqual(rule(SLACK, { message: 'hi' }, 'final'), { id: 'final', text: "can't be edited after" })
  assert.equal(rule(GITHUB, { body: 'hi' }, 'final'), undefined)
  assert.deepEqual(check(SLACK, {}).map((r) => r.id), ['final'], 'without text only what needs none')
})

test('check: a header right under a text line breaks the spacing rule; code does not count', () => {
  assert.deepEqual(rule(SLACK, { message: 'Intro\n*Ups*\n- a\n\n*Downs*\n- b' }, 'header-spacing'), { id: 'header-spacing', text: 'no blank line before "*Ups*"', met: false })
  assert.equal(rule(GITHUB, { body: 'text\n## Next\nmore\n\n**Bold:**' }, 'header-spacing')?.met, false)
  assert.equal(rule(JIRA, { commentBody: 'text\nh3. Next' }, 'header-spacing')?.met, false)
  assert.equal(rule(SLACK, { message: '*Ups*\n- a\n\n*Downs*\n- b' }, 'header-spacing')?.met, true)
  assert.equal(rule(GITHUB, { body: '```\nx\n# comment\n```' }, 'header-spacing')?.met, true)
})

test('check: plain @mentions are unresolved on Slack and Jira; on GitHub they list who gets notified', () => {
  assert.deepEqual(rule(SLACK, { message: 'cc @olena and <@U123>, mail a@b.io' }, 'mentions'), { id: 'mentions', text: 'unresolved @olena', met: false })
  assert.equal(rule(SLACK, { message: 'cc <@U123> `@code`' }, 'mentions')?.met, true)
  assert.equal(rule(JIRA, { commentBody: 'thanks @bob.' }, 'mentions')?.text, 'unresolved @bob')
  assert.equal(rule(JIRA, { commentBody: 'thanks [~accountid:5b10]' }, 'mentions')?.met, true)
  assert.deepEqual(rule(GITHUB, { body: 'cc @octo-cat @octo-cat' }, 'mentions'), { id: 'mentions', text: 'notifies @octo-cat' })
  assert.equal(rule(GITHUB, { body: 'no one' }, 'mentions'), undefined)
  assert.equal(rule(DOCS, { text: '@x' }, 'mentions'), undefined)
})

test("check: a GitHub comment over 65,536 characters breaks the limit; Slack's and Jira's are theirs", () => {
  assert.deepEqual(rule(GITHUB, { body: 'x'.repeat(65_537) }, 'limit'), { id: 'limit', text: '65,537 of 65,536 characters', met: false })
  assert.deepEqual(rule(GITHUB, { body: 'x'.repeat(65_536) }, 'limit'), { id: 'limit', text: 'under 65,536 characters', met: true })
  assert.equal(rule(SLACK, { message: 'x'.repeat(40_001) }, 'limit')?.met, false)
  assert.equal(rule(JIRA, { commentBody: 'x'.repeat(32_768) }, 'limit')?.met, false)
  assert.equal(rule(DOCS, { text: 'x'.repeat(100_000) }, 'limit'), undefined)
})
