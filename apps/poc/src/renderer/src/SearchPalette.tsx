import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { searchAll, type AgentSession, type ChatRef, type SearchHit, type Task } from '@mag/core'
import { threadTime } from './format'

/**
 * The search palette (archive-of-chats-summaries-search.2): an overlay over all topics, works and reviews of the project,
 * archive included, by title, summary and message text (core searchAll). Each row: title, key, an Archived mark and the
 * time, then the snippet of a matched message or the summary's line. ↑↓ move, Enter or a click picks, Escape closes.
 */
export function SearchPalette({ tasks, sessions, onPick, onClose, placeholder = 'Search chats and works, archive included' }: {
  /** The project's. */
  tasks: Task[]
  /** The project's. */
  sessions: AgentSession[]
  onPick: (ref: ChatRef) => void
  onClose: () => void
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Message text of every chat is read: typing stays responsive while the hits catch up.
  const deferred = useDeferredValue(query)
  const hits = searchAll(deferred, tasks, sessions)
  const list = useRef<HTMLDivElement>(null)
  const at = Math.min(active, Math.max(hits.length - 1, 0))
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at, deferred])
  const pick = (h: SearchHit | undefined) => {
    if (!h) return
    onClose()
    onPick(h.ref)
  }
  const now = Date.now()
  return (
    <>
      <div className="spscrim" onClick={onClose} />
      <div className="spalette" role="dialog" aria-label="Search">
        <input
          autoFocus
          type="search"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-controls="sphits"
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(at + 1, hits.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(at - 1, 0)) }
            else if (e.key === 'Enter') { e.preventDefault(); pick(hits[at]) }
            else if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }}
        />
        {deferred.trim() && (
          <div className="sphits" id="sphits" role="listbox" aria-label="Results" ref={list}>
            {hits.map((h, i) => (
              <button key={`${h.ref.kind}:${h.ref.id}`} role="option" aria-selected={i === at} className={`sphit${i === at ? ' on' : ''}`} onClick={() => pick(h)} onMouseMove={() => i !== at && setActive(i)}>
                <span className="sptop">
                  <span className="title">{h.title}</span>
                  {h.key && <span className="spkey">{h.key}</span>}
                  {h.archived && <span className="sparch">Archived</span>}
                  <span className="sptime">{threadTime(h.at, now)}</span>
                </span>
                {(h.snippet ?? h.line) && <span className="spline">{h.snippet ?? h.line}</span>}
              </button>
            ))}
            {!hits.length && <p className="muted small spempty">Nothing matches.</p>}
          </div>
        )}
      </div>
    </>
  )
}
