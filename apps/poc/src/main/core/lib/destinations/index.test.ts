import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, cliWriteRules, declared, isAuto } from './index.ts'

const bash = (command: string) => classify('Bash', undefined, { command })

test('classify: MCP writes get their destination and target; reads are null', () => {
  const cases: [string, string, unknown, { kind: string; target: string; label: string } | null][] = [
    ['slack_send_message', 'Slack', { channel_id: 'C0123ABCD', message: 'hi' }, { kind: 'slack', target: 'C0123ABCD', label: 'Slack C0123ABCD' }],
    ['slack_schedule_message', 'claude.ai Slack', { channel: 'data-removal' }, { kind: 'slack', target: 'data-removal', label: 'Slack #data-removal' }],
    ['slack_send_message_draft', 'Slack', {}, { kind: 'slack', target: '', label: 'Slack' }],
    ['createJiraIssue', 'claude.ai Atlassian', { projectKey: 'ABC', summary: 's' }, { kind: 'jira', target: 'ABC', label: 'Jira ABC' }],
    ['addCommentToJiraIssue', 'Atlassian', { issueIdOrKey: 'ABC-12', commentBody: 'x' }, { kind: 'jira', target: 'ABC-12', label: 'Jira ABC-12' }],
    ['transitionJiraIssue', 'Atlassian', { issueIdOrKey: 'ABC-12' }, { kind: 'jira', target: 'ABC-12', label: 'Jira ABC-12' }],
    ['createConfluencePage', 'Atlassian', { spaceId: '42', title: 't' }, { kind: 'confluence', target: '42', label: 'Confluence 42' }],
    ['updateConfluencePage', 'Atlassian', { pageId: '7' }, { kind: 'confluence', target: '7', label: 'Confluence 7' }],
    ['add_issue_comment', 'GitHub', { owner: 'o', repo: 'r', issue_number: 4 }, { kind: 'github', target: 'o/r#4', label: 'GitHub o/r#4' }],
    ['update_document', 'Google Docs', { documentId: 'd1' }, { kind: 'gdocs', target: 'd1', label: 'Google Docs d1' }],
    ['create_file', 'Google Drive', {}, { kind: 'gdocs', target: '', label: 'Google Docs' }],
    ['execute', 'Cloudflare', { code: 'x' }, { kind: 'other', target: 'Cloudflare', label: 'Cloudflare · execute' }],
    ['mystery', 'Thing', {}, { kind: 'other', target: 'Thing', label: 'Thing · mystery' }],
    ['slack_search_public', 'Slack', { query: 'q' }, null],
    ['slack_read_thread', 'Slack', {}, null],
    ['getJiraIssue', 'Atlassian', { issueIdOrKey: 'ABC-1' }, null],
    ['searchConfluenceUsingCql', 'Atlassian', {}, null],
    ['get_document', 'Google Docs', {}, null],
  ]
  for (const [tool, server, input, want] of cases) assert.deepEqual(classify(tool, server, input), want, `${server} ${tool}`)
})

test('classify: gh, acli Jira and Confluence writes in Bash get a destination; reads, pushes and other tools are null', () => {
  const writes: [string, string, string][] = [
    ['gh pr comment 4 -b "[mag] ok"', 'github', '#4'],
    ['gh -R acme/api pr review 4 --approve', 'github', 'acme/api#4'],
    ['gh pr edit https://github.com/acme/api/pull/9 --title t', 'github', 'acme/api#9'],
    ['gh issue create --repo acme/api --title t', 'github', 'acme/api'],
    ['gh issue comment 3 -R acme/api -b x', 'github', 'acme/api#3'],
    ['gh release create v1 -R acme/api', 'github', 'acme/api'],
    ['gh api -X POST repos/acme/api/issues/4/comments -f body=x', 'github', 'acme/api#4'],
    ['gh api repos/acme/api/pulls/4/comments -f body=x', 'github', 'acme/api#4'],
    ['gh api --method=PATCH /repos/acme/api', 'github', 'acme/api'],
    ['cd /r && gh pr close 4', 'github', '#4'],
    ['gh api graphql -f query=\'mutation { addComment(input: {}) { clientMutationId } }\'', 'github', ''],
    ['acli jira workitem create --project ABC --summary "a; b"', 'jira', 'ABC'],
    ['acli jira workitem edit --key ABC-12 --summary s', 'jira', 'ABC-12'],
    ['acli jira workitem comment create --key ABC-12 --body x', 'jira', 'ABC-12'],
    ['acli jira workitem transition ABC-12 --status Done', 'jira', 'ABC-12'],
    ['acli jira workitem assign -k ABC-3 --assignee @me', 'jira', 'ABC-3'],
    ['FOO=1 acli confluence page create --space ENG --title t', 'confluence', 'ENG'],
    ['acli confluence page update --id 77', 'confluence', '77'],
  ]
  for (const [command, kind, target] of writes) {
    const got = bash(command)
    assert.equal(got?.kind, kind, command)
    assert.equal(got?.target, target, command)
  }
  for (const command of [
    'gh pr view 4 --json state',
    'gh pr create --title t',
    'gh api repos/acme/api/pulls/4',
    'gh api -X GET repos/acme/api/pulls -f state=open',
    'gh issue list',
    'gh api graphql -f query=\'{ viewer { login } }\'',
    'acli jira workitem view ABC-12',
    'acli jira workitem search --jql "project = ABC"',
    'acli jira auth login',
    'acli confluence page view --id 7',
    'git push -u origin feature',
    'rm /home/u/.claude/projects/x/memory/a.md',
    'echo "gh pr comment 4"',
    'ls | grep gh',
  ])
    assert.equal(bash(command), null, command)
  assert.equal(classify('Edit', undefined, { file_path: '/x' }), null)
  assert.equal(classify('Bash', undefined, {}), null)
})

test('cliWriteRules: ask rules for acli Jira and Confluence and gh issue and release writes', () => {
  const rules = cliWriteRules()
  for (const r of ['Bash(acli jira:*)', 'Bash(acli confluence:*)', 'Bash(gh issue comment:*)', 'Bash(gh * issue comment *)', 'Bash(gh release create:*)']) assert.ok(rules.includes(r), r)
  assert.ok(!rules.some((r) => r.includes('issue list') || r.includes('issue view')))
})

test('isAuto: a pattern of the kind without a target, or with the target (case and # aside)', () => {
  const slack = { kind: 'slack' as const, target: 'Data-Removal', label: '' }
  assert.equal(isAuto(slack, undefined), false)
  assert.equal(isAuto(slack, { auto: [] }), false)
  assert.equal(isAuto(slack, { auto: [{ kind: 'slack' }] }), true)
  assert.equal(isAuto(slack, { auto: [{ kind: 'slack', target: '#data-removal' }] }), true)
  assert.equal(isAuto(slack, { auto: [{ kind: 'slack', target: 'general' }] }), false)
  assert.equal(isAuto(slack, { auto: [{ kind: 'jira' }] }), false)
  assert.equal(isAuto({ kind: 'jira', target: '', label: '' }, { auto: [{ kind: 'jira', target: 'ABC' }] }), false, 'no target: only a kind-wide pattern')
})

test('declared: a destination as the agent names it, by its kind word; anything else is other', () => {
  assert.deepEqual(declared('Slack #general'), { kind: 'slack', target: '#general', label: 'Slack #general' })
  assert.deepEqual(declared('slack general'), { kind: 'slack', target: 'general', label: 'Slack #general' })
  assert.deepEqual(declared('jira: ABC-12'), { kind: 'jira', target: 'ABC-12', label: 'Jira ABC-12' })
  assert.deepEqual(declared('gh acme/api#4'), { kind: 'github', target: 'acme/api#4', label: 'GitHub acme/api#4' })
  assert.deepEqual(declared('Google Docs 1AbC'), { kind: 'gdocs', target: '1AbC', label: 'Google Docs 1AbC' })
  assert.deepEqual(declared('Confluence'), { kind: 'confluence', target: '', label: 'Confluence' })
  assert.deepEqual(declared('  status page  webhook '), { kind: 'other', target: 'status page webhook', label: 'status page webhook' })
  assert.deepEqual(declared('slackbot'), { kind: 'other', target: 'slackbot', label: 'slackbot' })
  assert.deepEqual(declared(''), { kind: 'other', target: '', label: 'Other write' })
})
