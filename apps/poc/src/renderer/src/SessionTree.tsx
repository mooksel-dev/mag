import { useState } from 'react'
import { shortTitle, type AgentSession, type SessionNode, type SessionState } from '@mag/core'
import { Composer } from './Chat'
import { startSubtopic } from './draftSubtopic'
import { RowMenu, type Selection } from './WorkList'

const mag = window.mag

const STATE_LABELS: Record<SessionState, string> = { running: 'agent working', waiting: 'waits on you', idle: 'idle', error: 'failed', closed: 'closed' }

/**
 * A topic's subtopics in the sidebar (topic-screen-one-new-compact.2): one line each with its state dot, nested by
 * depth under a guide line; a click opens it, ⋯ on hover or a right-click opens the topic's menu (New subtopic, Rename, Branch, Close,
 * Delete). The draft of a New subtopic under one of them (`draftOf`) shows as its last line.
 */
export function SubtopicRows({ nodes, selectedId, draftOf, onSelect, onGone }: {
  nodes: SessionNode[]
  selectedId: string | null
  /** The session a New subtopic draft is open under, if any. */
  draftOf: string | null
  onSelect: (s: Selection) => void
  /** A subtopic was deleted from its menu. */
  onGone: (s: AgentSession) => void
}) {
  const [menu, setMenu] = useState<string | null>(null)
  return (
    <>
      {nodes.map((n) => {
        const s = n.session
        const title = shortTitle(s)
        const on = selectedId === s.id
        return (
          <div key={s.id}>
            <div className={`wlrow wlsub${on ? ' on' : ''}${menu === s.id ? ' menuopen' : ''}`} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu(s.id) }}>
              <button
                className="wlsess"
                aria-current={on ? 'true' : undefined}
                title={`${title} · ${STATE_LABELS[n.state]}`}
                onClick={() => onSelect({ kind: 'topic', id: s.id })}
              >
                <span className={`sessdot ${n.dot}`} aria-hidden />
                <span className="title">{title}</span>
              </button>
              <button className="wlmore" aria-label={`More for ${title}`} aria-haspopup="menu" aria-expanded={menu === s.id} title="New subtopic, rename, close, delete…" onClick={() => setMenu(menu === s.id ? null : s.id)}>⋯</button>
              {menu === s.id && (
                <RowMenu
                  card={{ kind: 'topic', title, session: s, closed: !!s.closedAt, sessions: n.children }}
                  onClose={() => setMenu(null)}
                  onSelect={onSelect}
                  onGone={() => onGone(s)}
                />
              )}
            </div>
            {(n.children.length > 0 || draftOf === s.id) && (
              <div className="wlkids">
                <SubtopicRows nodes={n.children} selectedId={selectedId} draftOf={draftOf} onSelect={onSelect} onGone={onGone} />
                {draftOf === s.id && <DraftRow />}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

/** The line of a New subtopic draft: it has no session yet. */
export function DraftRow() {
  return (
    <div className="wlsess on wldraft" aria-current="true">
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
