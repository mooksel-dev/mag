import { useState } from 'react'
import { CHILD_ROLES, flatNodes, isSubagent, liveNode, sessionNodes, shortTitle, type AgentSession, type ChildRole, type SessionNode, type SessionState } from '@mag/core'
import type { Selection } from './WorkList'

const mag = window.mag

const STATE_LABELS: Record<SessionState, string> = { running: 'working', waiting: 'waiting on you', idle: 'idle', error: 'failed', closed: 'closed' }

/**
 * The sessions under a topic in the sidebar (topics-a-tree-of-agent.2): one line each, with its role and state; a click
 * opens it. Only those topicKids picks (topic-screen-one-new-compact.1), flat.
 */
export function SessionRows({ nodes, selectedId, onSelect }: { nodes: SessionNode[]; selectedId: string | null; onSelect: (s: Selection) => void }) {
  return (
    <>
      {nodes.map((n) => (
        <button
          key={n.session.id}
          className={`wlsess${selectedId === n.session.id ? ' on' : ''}`}
          aria-current={selectedId === n.session.id ? 'true' : undefined}
          title={`${shortTitle(n.session)} · ${n.role} · ${STATE_LABELS[n.state]}`}
          onClick={() => onSelect({ kind: 'topic', id: n.session.id })}
        >
          <span className={`sessdot ${n.dot}`} aria-hidden />
          <span className="title">{shortTitle(n.session)}</span>
          <span className="sessrole">{n.role}</span>
        </button>
      ))}
    </>
  )
}

/**
 * The sessions under a topic or a session, on its page, as one line (topic-screen-one-new-compact.1): "Sessions:", the
 * ones that run, wait on you or failed (Stop on a running one), "N done" that unfolds all of them with their state, and
 * + session, which starts one more under it (a brief, an optional preset, fork). Writing to one is in its own
 * conversation. A subagent (topics-a-tree-of-agent.4) only lists the subagents it started: it starts none, and none of
 * them stops.
 */
export function ChildSessions({ parent, sessions, onSelect }: { parent: AgentSession; sessions: AgentSession[]; onSelect: (s: Selection) => void }) {
  const nodes = sessionNodes(parent.id, sessions)
  const [adding, setAdding] = useState(false)
  const [all, setAll] = useState(false)
  const [brief, setBrief] = useState('')
  const [role, setRole] = useState<ChildRole | ''>('')
  const [fork, setFork] = useState(false)
  const [busy, setBusy] = useState(false)
  const canFork = parent.agent === 'claude-code' && !!parent.nativeSessionId
  const start = () => {
    setBusy(true)
    mag
      .startChild(parent.id, brief, role || null, fork && canFork)
      .then((c) => {
        setAdding(false)
        setBrief('')
        setRole('')
        setFork(false)
        onSelect({ kind: 'topic', id: c.id })
      })
      .catch((e: Error) => alert(e.message))
      .finally(() => setBusy(false))
  }
  const readOnly = isSubagent(parent)
  if (readOnly && !nodes.length) return null
  const flat = flatNodes(nodes)
  const live = flat.filter(liveNode)
  const rest = flat.length - live.length
  return (
    <div className="childsess" aria-label={`Sessions under ${shortTitle(parent)}`}>
      <div className="childsessline small">
        <span className="muted">Sessions:</span>
        {live.map((n) => (
          <span key={n.session.id} className={`sesschip ${n.dot}`} title={`${n.role} · ${STATE_LABELS[n.state]}`}>
            <button className="link" onClick={() => onSelect({ kind: 'topic', id: n.session.id })}>{shortTitle(n.session)}</button>
            {n.session.status === 'running' && !isSubagent(n.session) && <button className="iconbtn" aria-label={`Stop ${shortTitle(n.session)}`} title="Stop" onClick={() => void mag.stop(n.session.id).catch((e: Error) => alert(e.message))}>■</button>}
          </span>
        ))}
        {rest > 0 && <button className="link muted" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? '▾' : '▸'} {rest} done</button>}
        {!adding && !readOnly && <button className="link" onClick={() => setAdding(true)}>＋ session</button>}
      </div>
      {all && <NodeList nodes={nodes} onSelect={onSelect} />}
      {adding && (
        <form className="childsessform" onSubmit={(e) => { e.preventDefault(); start() }}>
          <textarea autoFocus rows={2} value={brief} placeholder="What it does: its first message (empty: you write it there)" aria-label="Brief" onChange={(e) => setBrief(e.target.value)} />
          <div className="row">
            <select value={role} aria-label="Role" onChange={(e) => setRole(e.target.value as ChildRole | '')}>
              <option value="">General</option>
              {CHILD_ROLES.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
            </select>
            <label className="small" title={canFork ? 'It starts with all of this conversation' : 'Needs a Claude Code session here (send a message first)'}>
              <input type="checkbox" checked={fork && canFork} disabled={!canFork} onChange={(e) => setFork(e.target.checked)} /> With this conversation
            </label>
            <div className="grow" />
            <button type="button" className="small" onClick={() => setAdding(false)}>Cancel</button>
            <button className="small primary" disabled={busy || (!brief.trim() && !(fork && canFork))}>Start</button>
          </div>
        </form>
      )}
    </div>
  )
}

function NodeList({ nodes, onSelect, depth = 0 }: { nodes: SessionNode[]; onSelect: (s: Selection) => void; depth?: number }) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.session.id}>
          <div className="childsessrow" style={{ paddingLeft: depth * 14 }}>
            <span className={`sessdot ${n.dot}`} aria-hidden />
            <button className="link title" onClick={() => onSelect({ kind: 'topic', id: n.session.id })}>{shortTitle(n.session)}</button>
            <span className="sessrole">{n.role}</span>
            <span className="muted small">{STATE_LABELS[n.state]}</span>
            {n.session.status === 'running' && !isSubagent(n.session) && <button className="small" onClick={() => void mag.stop(n.session.id).catch((e: Error) => alert(e.message))}>Stop</button>}
          </div>
          {n.children.length > 0 && <NodeList nodes={n.children} onSelect={onSelect} depth={depth + 1} />}
        </div>
      ))}
    </>
  )
}
