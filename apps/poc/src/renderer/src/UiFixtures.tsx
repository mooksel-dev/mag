import { useLayoutEffect, useState, type ReactNode } from 'react'
import { Claim } from './ui/Claim'
import { PublishCard, type PublishDestination, type PublishRule } from './ui/PublishCard'
import { Seg } from './ui/Seg'

const noop = () => {}

const SLACK: PublishDestination = { icon: 'hash', service: 'Slack', name: 'data-removal', final: true }
const DOC: PublishDestination = { icon: 'doc', service: 'Google Docs', name: 'Team ups & downs (draft)' }
const JIRA: PublishDestination = { icon: 'ticket', service: 'Jira', name: 'PRVP-1234', final: true }

const MET: PublishRule[] = [{ text: 'epic level', met: true }, { text: 'no raw links', met: true }, { text: 'append only', met: true }]
const BROKEN: PublishRule[] = [{ text: 'epic level', met: true }, { text: 'no raw links', met: false }]
const UNCHECKED: PublishRule[] = [{ text: "don't touch old sections" }]

const message = (
  <div className="fxmsg">
    <b>Ups &amp; Downs · W47</b>
    <b>Ups</b>
    <ul><li>Riviera moved to duff-brewery, Redis removed</li><li>DBO queue: per-user observability</li></ul>
    <b>Downs</b>
    <ul><li>Integration tests are not in CI yet</li></ul>
  </div>
)

const STATES: { name: string; card: ReactNode }[] = [
  { name: 'Final destination, rules met', card: <PublishCard dest={SLACK} preview={message} rules={MET} onPublish={noop} onEdit={noop} onCancel={noop} /> },
  { name: 'A rule broken', card: <PublishCard dest={JIRA} preview={<p>Merged in #301; see https://github.com/…</p>} rules={BROKEN} onPublish={noop} onEdit={noop} onCancel={noop} /> },
  { name: 'Editable after, rule not checked, no Edit', card: <PublishCard dest={DOC} preview={message} rules={UNCHECKED} onPublish={noop} onCancel={noop} /> },
  { name: 'No rules', card: <PublishCard dest={DOC} preview={message} rules={[]} onPublish={noop} onEdit={noop} onCancel={noop} /> },
  { name: 'Publishing', card: <PublishCard dest={SLACK} preview={message} rules={MET} onPublish={noop} onEdit={noop} onCancel={noop} publishing /> },
]

/** Dev only (Develop → UI fixtures): every state of the shared ui components, in either theme. */
export default function UiFixtures() {
  // Local, not useTheme: switching here must not change the app's saved theme.
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.title = 'UI fixtures'
  }, [theme])
  return (
    <div className="page fixtures">
      <div className="fxhead">
        <h2>UI fixtures</h2>
        <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </div>
      <h3>PublishCard</h3>
      <div className="fxgrid">
        {STATES.map((s) => (
          <div key={s.name}>
            <div className="muted small fxname">{s.name}</div>
            {s.card}
          </div>
        ))}
      </div>
      <h3>Claim</h3>
      <p className="fxdoc">
        Olena merged <Claim text="34 PRs this quarter" n={1} status="verified" evidence={[{ source: 'GitHub', query: "gh pr list --author olena --state merged --search 'merged:2026-10-01..2026-12-31' → 34" }]} />,
        including <Claim text="three large DBR queue changes" n={2} status="verified" evidence={[{ source: 'PR #301' }, { source: 'PR #304' }, { source: 'PR #311', query: 'changes in queue/*' }]} />.
        Median time to first review is <Claim text="1.2 days" status="unverified" evidence={[]} />,
        and <Claim text="the flaky suite is fixed" status="unverified" evidence={[{ source: 'PR #318', query: 'gh pr checks 318 → 2 failing' }]} />.
        A claim with <Claim text="no source given" status="verified" evidence={[]} />.
      </p>
    </div>
  )
}
