import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { Pill } from './Pill'
import { ruleTone, rulesSummary, type PublishDestination, type PublishRule } from './publish'

export type { PublishDestination, PublishRule }

interface PublishCardProps {
  dest: PublishDestination
  /** The write as the destination will show it. */
  preview: ReactNode
  rules: PublishRule[]
  onPublish: () => void
  /** No Edit button without it. */
  onEdit?: () => void
  onCancel: () => void
  /** The write is on its way: the actions wait. */
  publishing?: boolean
}

/** The one card for every outbound write: where it goes, how it will look, the destination's rules, one Publish. */
export function PublishCard({ dest, preview, rules, onPublish, onEdit, onCancel, publishing }: PublishCardProps) {
  const summary = rulesSummary(rules)
  return (
    <section className="pubcard" aria-label={`Publish to ${dest.name}`}>
      <header className="pubhead">
        <Icon name="send" className="pubsend" />
        <span className="t">Publish</span>
        <span className="to">
          <Icon name="arrow-r" size={14} />
          <Icon name={dest.icon} size={14} />
          {dest.service && <span className="svc">{dest.service}</span>}
          <span className="name">{dest.name}</span>
        </span>
        <span className="sp" />
        {dest.final && <Pill tone="amber" icon="lock" title="What is published here can't be edited after">can't be edited after</Pill>}
      </header>
      <div className="pubprev">{preview}</div>
      {rules.length > 0 && (
        <div className="pubrules">
          <Icon name="rules" size={14} />
          <span>Destination rules:</span>
          {rules.map((r, i) => (
            <Pill key={i} tone={ruleTone(r)} icon={r.met === false ? 'x' : undefined}>{r.text}</Pill>
          ))}
          {summary && <Pill tone={summary.tone} icon={summary.tone === 'green' ? 'check' : 'alert'}>{summary.text}</Pill>}
        </div>
      )}
      <footer className="pubfoot">
        <button type="button" className="ghost" disabled={publishing} onClick={onCancel}>Cancel</button>
        <span className="sp" />
        {onEdit && <button type="button" disabled={publishing} onClick={onEdit}><Icon name="pencil" size={14} />Edit</button>}
        <button type="button" className="primary" disabled={publishing} onClick={onPublish}><Icon name="send" size={14} />{publishing ? 'Publishing…' : 'Publish'}</button>
      </footer>
    </section>
  )
}
