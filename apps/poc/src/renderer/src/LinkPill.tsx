import { useState } from 'react'
import type { RepoWork, Task } from '@mag/core'
import { LINK_SERVICES, PR_STATE_COLORS, prNumber, prPillState, prTooltip, ticketTooltip, type LinkService } from './linkServices'

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

/**
 * The task's tracker ticket: the tracker icon, the key in bold, its status in the tracker when mag knows it (not yet:
 * T-38) and ↗, on the tracker's brand color. `compact` (rows): icon and key only.
 */
export function TicketPill({ task, compact }: { task: Task; compact?: boolean }) {
  const t = task.tracker
  if (!t) return null
  const status: string | null = null
  return (
    <LinkPill url={t.url} color={LINK_SERVICES[t.kind].color} title={ticketTooltip(t, status)} label={`${LINK_SERVICES[t.kind].name} ticket ${t.key}`}>
      <ServiceIcon service={t.kind} />
      <b>{t.key}</b>
      {!compact && status && <span className="linkstatus">{status}</span>}
      {!compact && t.url && <span aria-hidden="true">↗</span>}
    </LinkPill>
  )
}
