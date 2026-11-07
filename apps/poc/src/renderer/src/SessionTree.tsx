import { useState } from 'react'
import { shortTitle, type AgentSession, type SessionNode, type SessionState } from '@mag/core'
import { Composer } from './Chat'
import { startSubtopic } from './draftSubtopic'
import type { Selection } from './WorkList'

const mag = window.mag

const STATE_LABELS: Record<SessionState, string> = { running: 'working', waiting: 'waiting on you', idle: 'idle', error: 'failed', closed: 'closed' }

/**
 * A topic's subtopics in the sidebar (topic-screen-one-new-compact.2): one line each with its state dot, nested by
 * depth; a click opens it. The draft of a New subtopic under one of them (`draftOf`) shows as its last line.
 */
export function SubtopicRows({ nodes, selectedId, draftOf, onSelect, depth = 0 }: {
  nodes: SessionNode[]
  selectedId: string | null
  /** The session a New subtopic draft is open under, if any. */
  draftOf: string | null
  onSelect: (s: Selection) => void
  depth?: number
}) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.session.id}>
          <button
            className={`wlsess${selectedId === n.session.id ? ' on' : ''}`}
            style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}
            aria-current={selectedId === n.session.id ? 'true' : undefined}
            title={`${shortTitle(n.session)} · ${STATE_LABELS[n.state]}`}
            onClick={() => onSelect({ kind: 'topic', id: n.session.id })}
          >
            <span className={`sessdot ${n.dot}`} aria-hidden />
            <span className="title">{shortTitle(n.session)}</span>
          </button>
          {n.children.length > 0 && <SubtopicRows nodes={n.children} selectedId={selectedId} draftOf={draftOf} onSelect={onSelect} depth={depth + 1} />}
          {draftOf === n.session.id && <DraftRow depth={depth + 1} />}
        </div>
      ))}
    </>
  )
}

/** The line of a New subtopic draft: it has no session yet. */
export function DraftRow({ depth = 0 }: { depth?: number }) {
  return (
    <div className="wlsess on wldraft" aria-current="true" style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}>
      <span className="sessdot grey" aria-hidden />
      <span className="title">New subtopic</span>
    </div>
  )
}

/**
 * A New subtopic (topic-screen-one-new-compact.2): an empty conversation under `parent` with the usual composer. It
 * is only this screen until the first message, which starts the subtopic and opens it; left without one, nothing is
 * kept.
 */
export function DraftSubtopic({ parent, onSelect }: { parent: AgentSession; onSelect: (s: Selection) => void }) {
  const [busy, setBusy] = useState(false)
  const send = async (text: string, attachments: Parameters<typeof startSubtopic>[3], refs: Parameters<typeof startSubtopic>[4]) => {
    setBusy(true)
    try {
      const child = await startSubtopic(mag, parent.id, text, attachments, refs)
      onSelect({ kind: 'topic', id: child.id })
    } catch (e) {
      alert((e as Error).message)
      throw e
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="convo">
      <header className="convohead">
        <div className="headline">
          <h1>New subtopic</h1>
          <span className="kind">subtopic</span>
          <div className="grow" />
          <button className="small" title="Nothing is kept" onClick={() => onSelect({ kind: 'topic', id: parent.id })}>Cancel</button>
        </div>
        <div className="muted small">
          Under <button type="button" className="link" onClick={() => onSelect({ kind: 'topic', id: parent.id })}>{shortTitle(parent)}</button>
        </div>
      </header>
      <div className="screenbody">
        <div className="screenmain">
          <div className="chatbox">
            <div className="items">
              <p className="muted small">A subtopic of {shortTitle(parent)}: a conversation of its own with the agent, in the same project. Your first message starts it; left empty, it is not kept.</p>
            </div>
            <Composer busy={busy} autoFocus placeholder="What is this subtopic about?" onSend={send} />
          </div>
        </div>
      </div>
    </section>
  )
}
