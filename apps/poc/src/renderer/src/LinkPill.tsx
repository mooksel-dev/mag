import { useState } from 'react'
import type { RepoWork, Task, TicketRef } from '@mag/core'
import { LINK_SERVICES, PR_STATE_TONES, prNumber, prPillState, prTooltip, ticketLabel, ticketTooltip, type LinkService } from './linkServices'
import { Icon } from './ui/Icon'
import type { Tone } from './ui/tones'

const mag = window.mag

function ServiceIcon({ service }: { service: LinkService }) {
  return (
    <svg className="linkicon" width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
      <path d={LINK_SERVICES[service].icon} fill="currentColor" />
    </svg>
  )
}

/**
 * A link to an external service: a Pill with its icon. Click opens the URL, ⌥-click copies it; neither reaches the
 * row around it. A span, not a button: pills sit inside row buttons. Without a URL it is not clickable.
 */
function LinkPill({ url, tone = 'grey', title, label, children }: { url: string | null; tone?: Tone; title: string; label: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const act = (alt: boolean) => {
    if (!url) return
    if (!alt) return void mag.open(url)
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  if (!url) return <span className={`pill ${tone}`} title={title} aria-label={label}>{children}</span>
  return (
    <span
      className={`pill ${tone} linkpill`}
      title={title}
      aria-label={label}
      role="link"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); act(e.altKey) }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); act(e.altKey) } }}
    >
      {copied ? 'Copied' : children}
    </span>
  )
}

/** One PR: the GitHub icon and its number on the color of its state; rows and the header show it the same. */
export function PrPill({ pr }: { pr: RepoWork }) {
  const state = prPillState(pr)
  const url = pr.prUrl!
  return (
    <LinkPill url={url} tone={state ? PR_STATE_TONES[state] : undefined} title={prTooltip(pr)} label={`PR ${prNumber(url)}${state ? `, ${state}` : ''}`}>
      <ServiceIcon service="github" />
      <span>{prNumber(url)}</span>
    </LinkPill>
  )
}

/** PR pills, one per repo with a PR. */
export function PrPills({ prs }: { prs: RepoWork[] }) {
  return <>{prs.filter((r) => r.prUrl).map((r) => <PrPill key={r.prUrl} pr={r} />)}</>
}

/** One ticket of a work (T-55.5): only a link, its key (or the link) and the external icon; `compact` (rows): no icon. */
export function TicketPill({ ticket, compact }: { ticket: TicketRef; compact?: boolean }) {
  const label = ticketLabel(ticket)
  return (
    <LinkPill url={ticket.url} title={ticketTooltip(ticket)} label={`Ticket ${label}`}>
      <b>{label}</b>
      {!compact && <Icon name="external" size={12} />}
    </LinkPill>
  )
}

/** The work's tickets, one pill each. */
export function TicketPills({ task, compact }: { task: Task; compact?: boolean }) {
  return <>{(task.tickets ?? []).map((t) => <TicketPill key={t.url} ticket={t} compact={compact} />)}</>
}
