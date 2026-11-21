import { useEffect, useState } from 'react'
import { taskByKey, type Project } from '@mag/core'
import type { Meeting, MeetingContent, MeetingHit, MeetingLink } from '../../main/core/services/meetings/types.ts'
import type { MeetingPerson } from '../../main/core/services/people/types.ts'
import type { AppState, MeetingStatus } from '../../preload/api'
import { Markdown } from './Chat'
import { linkKey, meetingWhen, snippetParts, transcriptLines } from './meetingText'
import { Recorder, useMeetingStatus } from './Recorder'
import type { Selection } from './WorkList'
import { Caret, Icon } from './ui/Icon'
import { Pill } from './ui/Pill'
import { FollowUpForm } from './FollowUpForm'
import { actionItems } from './followUpView'

const mag = window.mag
/** Meetings the section shows before "All". */
const RECENT = 5

/** Every meeting, newest first; refetched when one is saved, summarized, renamed, linked or deleted. */
export function useMeetings(): Meeting[] | null {
  const [list, setList] = useState<Meeting[] | null>(null)
  useEffect(() => {
    const load = () => void mag.listMeetings().then(setList, () => setList([]))
    load()
    return mag.onMeetingsChanged(load)
  }, [])
  return list
}

/** Search as the user types, a little after; null while the box is empty. */
function useMeetingSearch(q: string): MeetingHit[] | null {
  const [hits, setHits] = useState<MeetingHit[] | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => mag.onMeetingsChanged(() => setVersion((v) => v + 1)), [])
  useEffect(() => {
    if (!q.trim()) return setHits(null)
    let live = true
    const t = setTimeout(() => void mag.searchMeetings(q).then((h) => live && setHits(h), () => live && setHits([])), 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, version])
  return hits
}

function Snippet({ text }: { text: string }) {
  return <>{snippetParts(text).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>
}

/** Workspace-wide, on top of every project's sidebar: Record, search, then the meetings, newest first. */
export function MeetingsSection({ selectedId, onOpen }: { selectedId: string | null; onOpen: (id: string, at?: string) => void }) {
  const meetings = useMeetings()
  const [q, setQ] = useState('')
  const hits = useMeetingSearch(q)
  const status = useMeetingStatus()
  const [open, setOpen] = useState(() => localStorage.getItem('mag.meetings.open') !== '0')
  const [all, setAll] = useState(false)
  const toggle = () => {
    localStorage.setItem('mag.meetings.open', open ? '0' : '1')
    setOpen(!open)
  }
  const shown = all ? meetings ?? [] : (meetings ?? []).slice(0, RECENT)
  return (
    <section className="meetings" aria-label="Meetings">
      <div className="mtghead">
        <button className="wlfold" aria-expanded={open} onClick={toggle}><Caret open={open} /> Meetings{meetings?.length ? ` · ${meetings.length}` : ''}</button>
      </div>
      <Recorder />
      {open && !!meetings?.length && (
        <input className="mtgsearch" type="search" value={q} placeholder="Search meetings" aria-label="Search meetings" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
      )}
      {open && hits && (
        <div className="mtglist" role="list" aria-label="Search results">
          {!hits.length && <p className="muted small pad">Nothing matches.</p>}
          {hits.map((h, i) => (
            <button key={`${h.meetingId}:${h.part}:${h.at}:${i}`} role="listitem" className="mtghit" onClick={() => onOpen(h.meetingId, h.at ?? undefined)}>
              <span className="mtgtop"><span className="mtgtitle">{h.title}</span><span className="wltime">{h.at ?? 'summary'} · {meetingWhen(h)}</span></span>
              <span className="mtgsnip"><Snippet text={h.snippet} /></span>
            </button>
          ))}
        </div>
      )}
      {open && !hits && (
        <div className="mtglist">
          {meetings && !meetings.length && <p className="muted small pad">No meetings yet. Record a call: mic and system audio, transcribed on this Mac.</p>}
          {shown.map((m) => (
            <button key={m.id} className={`mtgrow${selectedId === m.id ? ' on' : ''}`} aria-current={selectedId === m.id ? 'true' : undefined} onClick={() => onOpen(m.id)} title={m.error ?? m.id}>
              <span className="mtgtitle">{m.title}</span>
              <span className="wltime">{status?.summarizing.includes(m.id) ? 'summarizing…' : meetingWhen(m)}</span>
            </button>
          ))}
          {meetings && meetings.length > RECENT && <button className="wlfold" onClick={() => setAll(!all)}>{all ? 'Fewer' : `All ${meetings.length}`}</button>}
        </div>
      )}
    </section>
  )
}

/** A topic or a work of `project` a meeting can be linked to. */
function linkTargets(state: AppState, project: Project): { ref: MeetingLink; label: string }[] {
  const works = state.tasks.filter((t) => t.projectId === project.id && !t.parentId && t.status !== 'canceled')
  const topics = state.sessions.filter((s) => s.projectId === project.id && !s.taskId && s.role === 'chat' && !s.parentId)
  return [
    ...works.map((t) => ({ ref: { projectId: project.id, workKey: t.key }, label: `${t.key} · ${t.title}` })),
    ...topics.map((s) => ({ ref: { projectId: project.id, topicId: s.id }, label: `Topic · ${s.title || 'Untitled'}` })),
  ]
}

function linkLabel(state: AppState, l: MeetingLink): string {
  const project = state.projects.find((p) => p.id === l.projectId)?.name ?? 'a deleted project'
  if (l.workKey) return `${project} · ${l.workKey} ${state.tasks.find((t) => t.projectId === l.projectId && t.key === l.workKey)?.title ?? ''}`.trim()
  return `${project} · ${state.sessions.find((s) => s.id === l.topicId)?.title || 'topic'}`
}

/** Who took part, as the workspace's persons: a person's chip, a suggestion to confirm in People, a name nobody matches. */
function useMeetingPeople(id: string, workspaceId: string): MeetingPerson[] {
  const [chips, setChips] = useState<MeetingPerson[]>([])
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    const offMeetings = mag.onMeetingsChanged(bump)
    const offPeople = mag.onPeopleChanged(bump)
    return () => (offMeetings(), offPeople())
  }, [])
  useEffect(() => {
    let live = true
    void mag.meetingPeople(id, workspaceId).then((c) => live && setChips(c), () => live && setChips([]))
    return () => {
      live = false
    }
  }, [id, workspaceId, version])
  return chips
}

function PersonChips({ chips }: { chips: MeetingPerson[] }) {
  if (!chips.length) return null
  return (
    <div className="mtglinks" aria-label="Participants">
      {chips.filter((c) => !c.notPerson).map((c) =>
        c.person ? (
          <Pill key={c.name} tone="acc" icon="users" title={c.name === c.person.name ? c.person.name : `${c.name} = ${c.person.name}`}>{c.person.name}</Pill>
        ) : c.suggestion ? (
          <Pill key={c.name} tone="amber" title={`Maybe ${c.suggestion.name}: confirm it in People`}>{c.name}?</Pill>
        ) : (
          <Pill key={c.name} title="Not matched to anyone in this workspace">{c.name}</Pill>
        ),
      )}
    </div>
  )
}

/** One meeting: summary on top, transcript below; rename, links, Show in Finder, summarize again, delete. */
export function MeetingView({ id, at, state, project, onClose, onSelect }: {
  id: string
  /** hh:mm:ss of a transcript line to show, from a search hit. */
  at?: string
  state: AppState
  project: Project
  onClose: () => void
  onSelect: (s: Selection) => void
}) {
  const [content, setContent] = useState<MeetingContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const status: MeetingStatus | null = useMeetingStatus()
  const chips = useMeetingPeople(id, project.workspaceId)
  useEffect(() => {
    const load = () => void mag.readMeeting(id).then((c) => (setContent(c), setError(null)), (e: Error) => setError(e.message))
    load()
    return mag.onMeetingsChanged(load)
  }, [id])
  useEffect(() => {
    if (content && at) document.getElementById(`line-${at}`)?.scrollIntoView({ block: 'center' })
  }, [content !== null, at]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = (f: () => Promise<unknown>) => void f().catch((e: Error) => setError(e.message))
  if (error && !content) return <main className="pagewrap"><div className="pagehead"><span>Meeting</span><div className="grow" /><button className="small" onClick={onClose}><Icon name="x" size={14} /> Close</button></div><p className="err pad">{error}</p></main>
  if (!content) return null
  const { meta } = content
  const recording = status?.recording?.meeting?.id === id
  const summarizing = status?.summarizing.includes(id) ?? false
  const lines = transcriptLines(content.transcript)
  const linked = new Set((meta.links ?? []).map(linkKey))
  const targets = linkTargets(state, project).filter((t) => !linked.has(linkKey(t.ref)))
  const openLink = (l: MeetingLink) => {
    if (l.projectId !== project.id) {
      const task = l.workKey ? state.tasks.find((t) => t.projectId === l.projectId && t.key === l.workKey) : null
      return void (task ? mag.openTask(task.id) : mag.openProject(l.projectId))
    }
    if (l.topicId) return onSelect({ kind: 'topic', id: l.topicId })
    const task = taskByKey(state.tasks.filter((t) => t.projectId === project.id), l.workKey ?? '')
    if (task) onSelect({ kind: 'work', id: task.parentId ?? task.id })
  }
  return (
    <main className="pagewrap meetingview">
      <div className="pagehead">
        {renaming ? (
          <form className="mtgrename" onSubmit={(e) => { e.preventDefault(); const t = (e.currentTarget.elements.namedItem('title') as HTMLInputElement).value; setRenaming(false); act(() => mag.renameMeeting(id, t)) }}>
            <input name="title" defaultValue={meta.title} autoFocus aria-label="Meeting title" onBlur={() => setRenaming(false)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)} />
          </form>
        ) : (
          <span title="Double-click to rename" onDoubleClick={() => setRenaming(true)}>{meta.title}</span>
        )}
        <span className="muted small">{meetingWhen(meta)}</span>
        <div className="grow" />
        <button className="small" onClick={() => setRenaming(true)}>Rename</button>
        <button className="small" onClick={() => act(() => mag.revealMeeting(id))}>Show in Finder</button>
        <button className="small" disabled={recording || summarizing || !lines.length} onClick={() => act(() => mag.summarizeMeeting(id))}>{summarizing ? 'Summarizing…' : content.summary ? 'Summarize again' : 'Summarize'}</button>
        <button className="small danger" disabled={recording} onClick={() => { if (confirm(`Delete "${meta.title}"? Its folder with the transcript and summary goes.`)) act(async () => { await mag.removeMeeting(id); onClose() }) }}>Delete</button>
        <button className="small" onClick={onClose}><Icon name="x" size={14} /> Close</button>
      </div>
      <section className="page">
        {error && <p className="err">{error}</p>}
        {meta.error && <p className="recnote err">Transcript has gaps: {meta.error}</p>}
        <PersonChips chips={chips} />
        <div className="mtglinks">
          {(meta.links ?? []).map((l) => (
            <Pill key={linkKey(l)}>
              <button className="link" onClick={() => openLink(l)}>{linkLabel(state, l)}</button>
              <button className="link" aria-label="Unlink" title="Unlink" onClick={() => act(() => mag.unlinkMeeting(id, l))}><Icon name="x" size={12} /></button>
            </Pill>
          ))}
          {targets.length > 0 && (
            <select value="" aria-label="Link to a topic or work" onChange={(e) => { const t = targets[Number(e.target.value)]; if (t) act(() => mag.linkMeeting(id, t.ref)) }}>
              <option value="">Link to a topic or work of {project.name}…</option>
              {targets.map((t, i) => <option key={linkKey(t.ref)} value={i}>{t.label}</option>)}
            </select>
          )}
        </div>
        <h2>Summary</h2>
        {content.summary ? <Markdown text={content.summary} /> : <p className="muted small">{recording ? 'Written after the call.' : summarizing ? 'The Claude CLI is writing it…' : lines.length ? 'None yet.' : 'Nothing was said.'}</p>}
        {content.summary && <ActionFollowUps meetingId={id} summary={content.summary} state={state} project={project} />}
        <h2>Transcript</h2>
        {lines.length ? (
          <div className="transcript">
            {lines.map((l, i) => (
              <p key={i} id={i === lines.findIndex((x) => x.at === l.at) ? `line-${l.at}` : undefined} className={`tline ${l.speaker}${l.at === at ? ' hit' : ''}`}><span className="tat">{l.at}</span><span className="tspk">{l.speaker}</span><span>{l.text}</span></p>
            ))}
          </div>
        ) : (
          <p className="muted small">{recording ? 'Lines appear about every 30 seconds.' : 'Nothing was transcribed.'}</p>
        )}
        <p className="muted small">Folder: <code>{content.dir}</code></p>
      </section>
    </main>
  )
}

/** The summary's action items, each with Follow up, or when it comes back once it has one (routines-scheduled-drafts-and-a.3). */
function ActionFollowUps({ meetingId, summary, state, project }: { meetingId: string; summary: string; state: AppState; project: Project }) {
  const [open, setOpen] = useState<number | null>(null)
  const items = actionItems(summary)
  if (!items.length) return null
  return (
    <>
      <h3>Follow up on action items</h3>
      <ul className="mtgactions">
        {items.map((a, i) => {
          const ref = `mtg:${meetingId}#${i}`
          const f = (state.followUps ?? []).find((x) => x.sourceRef === ref && x.status !== 'done')
          return (
            <li key={ref}>
              <span><b>{a.who}</b>: {a.what}</span>
              {f ? <span className="muted small">back {new Date(f.dueAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span> : open !== i && <button className="small" onClick={() => setOpen(i)}>Follow up</button>}
              {open === i && !f && <FollowUpForm workspaceId={project.workspaceId} projectId={project.id || null} sourceRef={ref} who={a.who} what={a.what} onDone={() => setOpen(null)} />}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** Where meetings are kept, and a way to change it; meetings saved before stay in the old folder. */
export function MeetingsRootSetting() {
  const status = useMeetingStatus()
  const [error, setError] = useState<string | null>(null)
  if (!status) return null
  return (
    <div className="field">
      Meetings folder
      <div className="repo">
        <code>{status.root}</code>
        <button className="link" onClick={() => void mag.revealMeeting()}>Show in Finder</button>
        <button className="link" disabled={!!status.recording} onClick={() => void mag.chooseMeetingsRoot().then(() => setError(null), (e: Error) => setError(e.message))}>Change…</button>
      </div>
      {error && <span className="err small">{error}</span>}
      <span className="muted small">For every project. Meetings already saved stay where they are: move their folders yourself to keep them in the list.</span>
    </div>
  )
}
