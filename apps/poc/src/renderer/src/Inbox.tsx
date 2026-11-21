import { useRef, useState } from 'react'
import { workspaceLabels, type Workspace } from '@mag/core'
import type { AppState } from '../../preload/api'
import type { InboxEntry } from '../../main/core/services/inbox/index.ts'
import { useDismiss } from './Agents'
import { errorText, LabelChip } from './labels/LabelChips'
import { INBOX_GROUPS, entryLabelIds, entryRef, inboxGroup, inboxMatches, openContext, openTarget, snoozePresets, workspaceInbox, type InboxFilter } from './inboxView'
import type { Selection } from './WorkList'
import { Caret } from './ui/Icon'
import { failedKey, routineOfRef, runOfKey } from '../../main/core/services/routines/refs.ts'
import { ArtifactDrawer } from './Drawer'
import type { ArtifactTarget } from './artifacts'
import { FollowUpForm } from './FollowUpForm'

const mag = window.mag

const KIND_LABELS: Record<InboxEntry['kind'], string> = {
  approval: 'Allow?',
  agent_failed: 'Failed',
  check_failed: 'Check failed',
  question: 'Question',
  review_look: 'Look',
  ready_to_merge: 'Merge',
  review_ready: 'Review ready',
  review_activity: 'PR activity',
  ready_to_start: 'Start',
  draft: 'Draft',
  inbound: 'Inbound',
  follow_up: 'Follow up',
  other: 'Item',
}

/** The workspace's active inbox items; the rail's badge. */
export const inboxCount = (state: Pick<AppState, 'inbox'>, workspaceId: string) => workspaceInbox(state.inbox, workspaceId).length

function useInboxFilter(workspaceId: string): [InboxFilter, (f: InboxFilter) => void] {
  const key = `mag.inbox.filter.${workspaceId}`
  const [filter, setFilter] = useState<InboxFilter>(() => localStorage.getItem(key) ?? 'all')
  const set = (f: InboxFilter) => {
    setFilter(f)
    try { localStorage.setItem(key, f) } catch { /* ignore */ }
  }
  return [filter, set]
}

/**
 * The rail's Inbox section (inbox-what-waits-on-me.2): what waits on the user in this workspace, by group, filtered by
 * All, a project or any label. A row opens its work or topic; one without either becomes a topic only on Open.
 */
export function Inbox({ workspace, state, onSelect }: { workspace: Workspace; state: AppState; onSelect: (s: Selection) => void }) {
  const [stored, setFilter] = useInboxFilter(workspace.id)
  const [error, setError] = useState<string | null>(null)
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [shownArtifact, setShownArtifact] = useState<ArtifactTarget | null>(null)
  const view = workspaceLabels(workspace.id, state)
  const labels = new Map(view.flatMap((v) => v.labels).map((l) => [l.id, l]))
  // A label deleted since it was picked filters nothing.
  const filter = stored === 'all' || labels.has(stored) ? stored : 'all'
  const rows = workspaceInbox(state.inbox, workspace.id).map((e) => ({ e, labelIds: entryLabelIds(e, entryRef(e, state.tasks, state.sessions), state.itemLabels) }))
  const shown = rows.filter((r) => inboxMatches(r.labelIds, filter))
  const run = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e) => setError(errorText(e)))
  }
  // One topic per Open, however fast the clicks.
  const opening = useRef(new Set<string>())
  const open = (e: InboxEntry) => {
    const t = openTarget(e, state.tasks, state.sessions)
    if (t.kind !== 'new') return onSelect(t)
    if (opening.current.has(e.key)) return
    opening.current.add(e.key)
    run((async () => {
      const id = await mag.newChat(e.projectId, e.workspaceId ?? workspace.id)
      onSelect({ kind: 'topic', id })
      await mag.send(id, openContext(e))
      // It lives in its topic now; adding it again is new activity and brings it back.
      await mag.doneInbox(e.key)
    })().finally(() => opening.current.delete(e.key)))
  }
  const toggle = (g: string) => setFolded((f) => { const n = new Set(f); if (n.has(g)) n.delete(g); else n.add(g); return n })

  return (
    <nav className="worklist" aria-label="Inbox">
      <div className="wlhead2">
        <span className="colhead2">Inbox</span>
        <select className="inboxfilter" aria-label="Filter the inbox" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All · {rows.length}</option>
          {view.map(({ group, labels: ls }) => ls.length > 0 && (
            <optgroup key={group.id} label={group.name}>
              {ls.map((l) => <option key={l.id} value={l.id}>{l.name} · {rows.filter((r) => r.labelIds.includes(l.id)).length}</option>)}
            </optgroup>
          ))}
        </select>
        {error && <p className="err small" role="alert">{error}</p>}
      </div>
      <div className="wlscroll">
        {!shown.length && <p className="muted small pad">{rows.length ? 'Nothing here with this filter.' : 'Nothing waits on you.'}</p>}
        {INBOX_GROUPS.map((g) => {
          const items = shown.filter((r) => inboxGroup(r.e) === g.id)
          if (!items.length) return null
          const closed = folded.has(g.id)
          return (
            <section key={g.id} className="colsection" aria-label={g.label}>
              <div className="wlgrp colhead">
                <button className="wlgname unread" aria-expanded={!closed} onClick={() => toggle(g.id)}>
                  <span aria-hidden><Caret open={!closed} /></span> <span className="colname">{g.label}</span>
                  <span className="colcount">{items.length}</span>
                </button>
              </div>
              {!closed && (
                <div className="colbody">
                  {items.map(({ e, labelIds }) => (
                    <InboxRow key={e.key} entry={e} workspaceId={workspace.id} chips={labelIds.flatMap((id) => labels.get(id) ?? [])} state={state} onOpen={() => open(e)} onArtifact={setShownArtifact} run={run} />
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
      {shownArtifact && <ArtifactDrawer open={shownArtifact} state={state} onClose={() => setShownArtifact(null)} onGone={() => setShownArtifact(null)} onOpenKey={() => {}} onSelect={onSelect} />}
    </nav>
  )
}

function InboxRow({ entry: e, workspaceId, chips, state, onOpen, onArtifact, run }: {
  entry: InboxEntry
  workspaceId: string
  chips: { id: string; name: string; color: string }[]
  state: AppState
  onOpen: () => void
  onArtifact: (a: ArtifactTarget) => void
  run: (p: Promise<unknown>) => void
}) {
  const [snoozing, setSnoozing] = useState(false)
  const [following, setFollowing] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(snoozing, box, setSnoozing)
  const task = e.taskId ? state.tasks.find((t) => t.id === e.taskId) : undefined
  const topic = !task && e.sessionId ? state.sessions.find((s) => s.id === e.sessionId) : undefined
  const about = task ? `${task.key} · ${task.title}` : topic?.title
  // A routine's failure (routines-scheduled-drafts-and-a.1), and a run's log and draft (.2).
  const failed = e.added ? routineOfRef(e.ref) : null
  const retry = failed && e.key === failedKey(failed) ? failed : null
  const ran = e.added ? runOfKey(e.key) : null
  const routineRun = ran ? (state.routineRuns ?? []).find((r) => r.id === ran.runId) : undefined
  const log = routineRun?.sessionId && state.sessions.some((s) => s.id === routineRun.sessionId) ? routineRun.sessionId : null
  const draft = routineRun?.deliverableRef ? (state.deliverables ?? []).find((d) => `${d.folder}:dlv:${d.slug}` === routineRun.deliverableRef) : undefined
  return (
    <div className="inboxrow">
      <button className="inboxmain" title="Open" onClick={onOpen}>
        <span className="inboxkind">{KIND_LABELS[e.kind] ?? e.kind}</span>
        <span className="inboxtext">{e.text}</span>
        {about && <span className="inboxabout muted small">{about}</span>}
      </button>
      {(chips.length > 0 || !e.projectId) && (
        <div className="labelchips">
          {!e.projectId && <LabelChip label={{ name: 'No project', color: 'var(--line)' }} muted />}
          {chips.map((l) => <LabelChip key={l.id} label={l} />)}
        </div>
      )}
      <div className="inboxacts" ref={box}>
        <button className="small" onClick={onOpen}>Open</button>
        {retry && <button className="small" title="Run the routine again now" onClick={() => run(mag.runRoutine(retry).then(() => mag.doneInbox(e.key)))}>Retry</button>}
        {log && <button className="small" title="The run's session" onClick={() => onArtifact({ kind: 'agent', sessionId: log })}>Log</button>}
        {draft && <button className="small" title="The draft it made" onClick={() => onArtifact({ kind: 'deliverable', id: draft.id })}>Draft</button>}
        <button className="small" aria-haspopup="menu" aria-expanded={snoozing} onClick={() => setSnoozing((s) => !s)}>Snooze</button>
        {e.kind !== 'follow_up' && <button className="small" title="Bring it back on a date, with who and what" aria-expanded={following} onClick={() => setFollowing((f) => !f)}>Follow up</button>}
        <button className="small" title={e.kind === 'follow_up' ? 'Close the follow-up' : 'Hide until it has new activity'} onClick={() => run(mag.doneInbox(e.key))}>Done</button>
        {snoozing && (
          <div className="chippop inboxsnooze" role="menu" aria-label="Snooze until">
            {snoozePresets(Date.now()).map((p) => (
              <button key={p.label} role="menuitem" className="small" onClick={() => { setSnoozing(false); run(mag.snoozeInbox(e.key, p.until)) }}>{p.label}</button>
            ))}
          </div>
        )}
      </div>
      {following && (
        <FollowUpForm workspaceId={e.workspaceId ?? workspaceId} projectId={e.projectId} sourceRef={e.ref ?? entryRef(e, state.tasks, state.sessions)} fromKey={e.key} what={e.text} onDone={() => setFollowing(false)} />
      )}
    </div>
  )
}
