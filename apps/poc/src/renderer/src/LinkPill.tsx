import { useState } from 'react'
import type { RepoWork, Task, TicketRef } from '@mag/core'
import { LINK_SERVICES, PR_STATE_COLORS, prNumber, prPillState, prTooltip, ticketLabel, ticketTooltip, type LinkService } from './linkServices'

const mag = window.mag

function ServiceIcon({ service }: { service: LinkService }) {
  return (
    <svg className="linkicon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={LINK_SERVICES[service].icon} fill="currentColor" />
    </svg>
  )
}

/**
 * A link to an external service: a pill with its icon. Click opens the URL, ⌥-click copies it; neither reaches the
 * row around it. A span, not a button: pills sit inside row buttons. Without a URL it is not clickable.
 */
function LinkPill({ url, color, title, label, children }: { url: string | null; color?: string; title: string; label: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const act = (alt: boolean) => {
    if (!url) return
    if (!alt) return void mag.open(url)
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  const style = color ? { background: color } : undefined
  if (!url) return <span className="linkpill" style={style} title={title} aria-label={label}>{children}</span>
  return (
    <span
      className="linkpill on"
      style={style}
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
    <LinkPill url={url} color={state ? PR_STATE_COLORS[state] : undefined} title={prTooltip(pr)} label={`PR ${prNumber(url)}${state ? `, ${state}` : ''}`}>
      <ServiceIcon service="github" />
      <span>{prNumber(url)}</span>
    </LinkPill>
  )
}

/** PR pills, one per repo with a PR. */
export function PrPills({ prs }: { prs: RepoWork[] }) {
  return <>{prs.filter((r) => r.prUrl).map((r) => <PrPill key={r.prUrl} pr={r} />)}</>
}

/** One ticket of a work (T-55.5): only a link, its key (or the link) and ↗. `compact` (rows): no ↗. */
export function TicketPill({ ticket, compact }: { ticket: TicketRef; compact?: boolean }) {
  const label = ticketLabel(ticket)
  return (
    <LinkPill url={ticket.url} title={ticketTooltip(ticket)} label={`Ticket ${label}`}>
      <b>{label}</b>
      {!compact && <span aria-hidden="true">↗</span>}
    </LinkPill>
  )
}

/** The work's tickets, one pill each. */
export function TicketPills({ task, compact }: { task: Task; compact?: boolean }) {
  return <>{(task.tickets ?? []).map((t) => <TicketPill key={t.url} ticket={t} compact={compact} />)}</>
}
