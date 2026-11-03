import { useEffect, useState } from 'react'
import {
  WORK_GROUPS,
  WORK_GROUP_LABELS,
  currentStep,
  isLegacy,
  isReview,
  prRepoName,
  reviewLine,
  subtasksOf,
  workList,
  type InboxKind,
  type Project,
  type WorkListItem,
} from '@mag/core'
import type { AppState, CrashReport } from '../../preload/api'
import { ago, crashMarkdown, threadTime } from './format'
import { useNow } from './Tasks'

const mag = window.mag

/** What the list has open: a work (a review too) or a topic without a work. */
export type Selection = { kind: 'work' | 'topic'; id: string }

const BADGES: Record<InboxKind, [string, string]> = {
  approval: ['amber', 'Approval'],
  agent_failed: ['red', 'Agent failed'],
  check_failed: ['red', 'Check failed'],
  question: ['amber', 'Question'],
  review_look: ['amber', 'Look'],
  ready_to_merge: ['green', 'Merge'],
  review_ready: ['violet', 'Review ready'],
  ready_to_start: ['amber', 'Start'],
}

/**
 * The left column (ux-odna-rozmova-na-robotu.2): one field that starts any work, then the works and topics of core
 * workList() by group. Done is collapsed.
 */
export function WorkList({ project, state, selected, onSelect }: {
  project: Project
  state: AppState
  selected: Selection | null
  onSelect: (s: Selection) => void
}) {
  const now = useNow(15_000)
  const tasks = state.tasks.filter((t) => t.projectId === project.id)
  const items = workList(project.id, tasks, state.sessions, now)
  const [showDone, setShowDone] = useState(false)
  const [crash, setCrash] = useState<CrashReport | null>(null)
  useEffect(() => {
    mag.lastCrash().then(setCrash, () => {})
  }, [])
  const groups = WORK_GROUPS.map((g) => ({ g, list: items.filter((i) => i.group === g) })).filter((x) => x.list.length)
  return (
    <nav className="worklist" aria-label="Works">
      <NewWork project={project} onSelect={onSelect} />
      <div className="wlscroll">
        {crash && <CrashRow crash={crash} onDismiss={() => mag.dismissCrash().then(() => setCrash(null))} />}
        {!items.length && <p className="muted small pad">No works yet. Describe a problem above: a topic opens, and its agent plans the work with you.</p>}
        {groups.map(({ g, list }) => (
          <div key={g} className="wlgroup">
            {g === 'done'
              ? <button className="wlhead" aria-expanded={showDone} onClick={() => setShowDone((d) => !d)}>{showDone ? '▾' : '▸'} {WORK_GROUP_LABELS[g]} · {list.length}</button>
              : <div className="wlhead">{WORK_GROUP_LABELS[g]} · {list.length}</div>}
            {(g !== 'done' || showDone) && list.map((i) => (
              <Row key={key(i)} item={i} project={project} state={state} now={now} on={selected?.id === key(i)} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </nav>
  )
}

const key = (i: WorkListItem) => (i.kind === 'work' ? i.task.id : i.session.id)

function Row({ item, project, state, now, on, onSelect }: { item: WorkListItem; project: Project; state: AppState; now: number; on: boolean; onSelect: (s: Selection) => void }) {
  const badge = item.badge && BADGES[item.badge]
  if (item.kind === 'topic') {
    const t = item.session
    return (
      <button className={`wlrow${on ? ' on' : ''}`} onClick={() => onSelect({ kind: 'topic', id: t.id })}>
        <div className="wltop">
          {t.status === 'running' && <span className="dot live" />}
          <span className="title">{t.title ?? 'Topic'}</span>
          {badge && <span className={`pill ${badge[0]}`}>{badge[1]}</span>}
        </div>
        <div className="muted small">{item.text ?? threadTime(item.at, now)}</div>
      </button>
    )
  }
  const t = item.task
  const tasks = state.tasks.filter((x) => x.projectId === t.projectId)
  const pr = t.prReview?.pr
  const sub = (() => {
    if (isReview(t)) return `${pr ? `${prRepoName(project, pr)}#${pr.number} · @${pr.author} · ` : ''}${reviewLine(t, state.sessions)}`
    if (item.text) return item.text
    const step = isLegacy(t) ? null : currentStep(t.id, tasks)
    const steps = subtasksOf(t.id, tasks)
    const where = step && steps.length > 1 ? `step ${steps.indexOf(step) + 1}/${steps.length}` : null
    if (item.agent) return [item.agent.role, where, ago(item.agent.since, now)].filter(Boolean).join(' · ')
    return [t.status === 'in_progress' ? 'in progress' : t.status, where].filter(Boolean).join(' · ')
  })()
  return (
    <button className={`wlrow${on ? ' on' : ''}`} onClick={() => onSelect({ kind: 'work', id: t.id })}>
      <div className="wltop">
        {item.agent && <span className="dot live" />}
        <span className="title">{isReview(t) ? `Review ${t.title.replace(/^[^:]*#\d+: /, '')}` : t.title}</span>
        {badge && <span className={`pill ${badge[0]}`}>{badge[1]}</span>}
      </div>
      <div className="muted small"><span className="key">{t.key}</span> · {sub}</div>
    </button>
  )
}

const PR_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/
const URL_RE = /^https?:\/\/\S+$/

/**
 * Starts any work from one field: a PR link reviews the PR, any other link starts a work from that ticket, and words
 * open a new topic with them, whose agent plans the work with the user.
 */
function NewWork({ project, onSelect }: { project: Project; onSelect: (s: Selection) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = text.trim()
  const what = PR_RE.test(t) ? 'Review PR' : URL_RE.test(t) ? 'From ticket' : 'New work'
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    try {
      if (PR_RE.test(t)) {
        const r = await mag.startReview(project.id, t)
        if ('error' in r) return setError(r.error)
        onSelect({ kind: 'work', id: r.taskId })
      } else if (URL_RE.test(t)) {
        const r = await mag.workFromTicket(project.id, t)
        if ('error' in r) return setError(r.error)
        onSelect({ kind: 'work', id: r.taskId })
      } else {
        const id = await mag.newChat(project.id)
        onSelect({ kind: 'topic', id })
        await mag.send(id, t)
      }
      setText('')
    } catch (err) {
      setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="newwork" onSubmit={submit}>
      <input
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null) }}
        placeholder="New work: a problem, a ticket or PR link…"
        aria-label="New work"
        aria-invalid={!!error}
        title="Words open a topic whose agent plans the work with you; a ticket link starts a work from it; a GitHub PR link reviews the PR"
      />
      {t && <button type="submit" className="primary small" disabled={busy}>{what}</button>}
      {error && <span className="err small" role="alert">{error}</span>}
    </form>
  )
}

/** mag crashed in an earlier run: the report is in the logs folder. */
function CrashRow({ crash, onDismiss }: { crash: CrashReport; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(crashMarkdown(crash)).then(() => setCopied(true))
  return (
    <div className="wlrow crash">
      <div className="wltop"><span className="pill red">Crash</span><span className="title">mag crashed {new Date(crash.time).toLocaleString()}</span></div>
      <div className="muted small">{crash.kind}{crash.screen ? ` on ${crash.screen}` : ''}: {crash.message.split('\n')[0]}</div>
      <div className="actions">
        <button className="small" onClick={() => mag.openLogs()}>Logs</button>
        <button className="small" onClick={onDismiss}>Dismiss</button>
        <button className="small primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy report'}</button>
      </div>
    </div>
  )
}
