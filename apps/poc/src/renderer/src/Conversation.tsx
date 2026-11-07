import { useCallback, useMemo, useRef, useState } from 'react'
import {
  agentState,
  chatCommands,
  isReview,
  ownedWorks,
  prRepoName,
  reviewTopic,
  runRole,
  isSubagent,
  sessionRole,
  shortTitle,
  workCard,
  type AgentSession,
  type Attachment,
  type CanvasRef,
  type ChatRef,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { ArtifactsList, HeadMenu, WaitingBar, workMenuCard, workSessions } from './ArtifactPane'
import { topicArtifacts, type ArtifactTarget } from './artifacts'
import { WorkCards } from './Cards'
import { CanvasOpener, Chat, Composer, ModelChip } from './Chat'
import { ArtifactDrawer } from './Drawer'
import { TicketLinks, AgentDot, useNow } from './Tasks'
import type { MenuCard, Selection } from './WorkList'
import { ChildSessions } from './SessionTree'

const mag = window.mag

/**
 * The conversation of a work: its owner (the topic that planned it, or its groomer; a review's topic). Legacy works
 * without one fall back to their latest groomer.
 */
export function ownerSession(work: Task, sessions: AgentSession[]): AgentSession | null {
  return (
    sessions.find((s) => s.id === work.ownerSessionId)
    ?? (isReview(work) ? reviewTopic(work, sessions) : undefined)
    ?? sessions.filter((s) => s.taskId === work.id && s.role === 'groomer').at(-1)
    ?? null
  )
}

/** What opens a referenced chat: its topic, or its work or review. */
const refSelection = (ref: ChatRef): Selection => ({ kind: ref.kind === 'topic' ? 'topic' : 'work', id: ref.id })

/** The drawer of a screen: the artifact open in it, and the opener canvas cards in the chat use. */
function useDrawer(initial: ArtifactTarget | null) {
  const [open, setOpen] = useState<ArtifactTarget | null>(initial)
  const show = useCallback((c: CanvasRef | string, focus?: string) => setOpen({ kind: 'canvas', id: typeof c === 'string' ? c : c.id, focus }), [])
  const close = useCallback(() => setOpen(null), [])
  return { open, setOpen, show, close }
}

/**
 * A topic's screen (topics-a-tree-of-agent.3): a compact header (title, kind, Turn into a work, ⋯), the sessions under
 * it and what waits on you; below, its conversation with the cards of every work it owns, and at the right the list of
 * its artifacts, or the one opened in the drawer. A work opens here, through its owner topic, with its card open.
 * `topic` null: a work whose owner is its groomer, or nobody yet; the screen is the work's, with the groomer's chat.
 */
export function TopicConversation({ topic, work, initial = null, state, onOpenKey, onSelect, onDeleted }: {
  topic: AgentSession | null
  /** The work opened from the list; with no topic, the work the screen is. */
  work: Task | null
  /** The artifact open in the drawer when the screen opens. */
  initial?: ArtifactTarget | null
  state: AppState
  onOpenKey: (key: string) => void
  onSelect: (s: Selection) => void
  /** What the screen shows is gone (deleted from its menu or its review page). */
  onDeleted: () => void
}) {
  const now = useNow(15_000)
  const box = useRef<HTMLDivElement>(null)
  const projectId = topic?.projectId ?? work!.projectId
  const project = state.projects.find((p) => p.id === projectId)
  const tasks = state.tasks.filter((t) => t.projectId === projectId)
  const drawer = useDrawer(initial)
  const [listShown, setListShown] = useState(true)
  const artifacts = useMemo(() => topicArtifacts(topic, state, topic ? null : work), [topic, work, state])
  // The review mag made this topic for: the screen is that review's.
  const review = topic ? tasks.find((t) => isReview(t) && (t.id === topic.reviewOf || reviewTopic(t, state.sessions)?.id === topic.id)) : work && isReview(work) ? work : undefined
  // The conversation: the topic, else the work's owner (its groomer, or a review's topic that is gone).
  const chat = topic ?? (work ? ownerSession(work, state.sessions) : null)
  // The works whose cards wait at the end of the conversation: those this session owns, the one opened first.
  const reviews = topic ? tasks.filter((t) => isReview(t) && t !== review && t.ownerSessionId === topic.id && t.status === 'in_progress') : []
  const owned = topic ? [...(review ? [review] : []), ...reviews, ...ownedWorks(topic.id, tasks)] : work ? [work] : []
  const cardsOf = work && owned.some((t) => t.id === work.id) ? [work, ...owned.filter((t) => t.id !== work.id)] : owned
  const waiting = cardsOf.map((t) => ({ t, card: workCard(t, tasks, state.sessions, now) })).find((c) => c.card?.move.who === 'you')
  // An answer goes into the composer.
  const focus = () => requestAnimationFrame(() => box.current?.querySelector<HTMLTextAreaElement>('.screenmain textarea')?.focus())
  const cards = cardsOf.length ? <>{cardsOf.map((t, i) => <WorkCards key={t.id} work={t} owner={chat} state={state} onAnswer={focus} label={i > 0} />)}</> : undefined
  const running = chat?.status === 'running'
  const canGroom = !topic && !!work && !isReview(work) && !workSessions(work, state).some((s) => s.status === 'running') && !work.work && (work.status === 'planning' || work.status === 'ready')
  const pr = review?.prReview?.pr
  // A work or review closed or deleted from its card: back to the topic without it (gone with it too: Home).
  const gone = () => {
    drawer.close()
    if (topic) onSelect({ kind: 'topic', id: topic.id })
    else onDeleted()
  }
  const turn = () => void mag.turnIntoWork(topic!.id).catch((e: Error) => alert(e.message))
  const refsFrom = topic && { tasks, sessions: state.sessions.filter((s) => s.projectId === projectId), self: { kind: 'topic' as const, id: topic.id } }
  const chip = project && chat && runRole(chat) === 'chat' ? <ModelChip project={project} activeModel={chat.activeModel} /> : undefined
  const parent = topic?.parentId ? state.sessions.find((s) => s.id === topic.parentId) : undefined
  const subject = topic ? null : work!
  const menu: MenuCard = review ? workMenuCard(review) : topic ? { kind: 'topic', title: shortTitle(topic), session: topic, closed: !!topic.closedAt } : workMenuCard(subject!)
  return (
    <CanvasOpener.Provider value={drawer.show}>
      <section className="convo" ref={box}>
        <header className="convohead">
          <div className="headline">
            {topic ? <TopicTitle topic={topic} /> : <h1 title={subject!.title}>{shortTitle(subject!)}</h1>}
            <span className="kind">{review ? `review · ${review.key}` : topic ? (topic.parentId ? `session · ${sessionRole(topic)}` : 'discussion') : `work · ${subject!.key}`}</span>
            {review && pr && project ? <button className="link small" onClick={() => mag.open(pr.url)}>{prRepoName(project, pr)}#{pr.number} ↗</button> : subject && <TicketLinks task={subject} />}
            {subject && !review && <AgentDot state={agentState(subject, workSessions(subject, state), tasks)} now={now} />}
            <div className="grow" />
            {topic && !review && !isSubagent(topic) && <button className="small" disabled={running} title={running ? 'The agent is still working' : 'Its agent creates a work from what was discussed'} onClick={turn}>Turn into a work</button>}
            {canGroom && !chat && <button className="small" onClick={() => mag.groom(subject!.id)}>Groom</button>}
            {review && <button className="small" title="The whole review in its own window" onClick={() => mag.openWindow({ kind: 'review', taskId: review.id })}>Open review ⧉</button>}
            {artifacts.length > 0 && <button className={`small${listShown ? ' on' : ''}`} aria-pressed={listShown} title="The docs, plans, diagrams, facts and reviews made here" onClick={() => (drawer.open ? (drawer.close(), setListShown(true)) : setListShown((v) => !v))}>Artifacts · {artifacts.length}</button>}
            <HeadMenu card={menu} onSelect={onSelect} onGone={onDeleted} />
          </div>
          {topic?.parentId && (
            <div className="muted small">
              Under {parent ? <button type="button" className="link" onClick={() => onSelect({ kind: 'topic', id: parent.id })}>{shortTitle(parent)}</button> : 'a deleted session'}
            </div>
          )}
          {topic && !review && <ChildSessions parent={topic} sessions={state.sessions} onSelect={onSelect} />}
          {waiting?.card && <WaitingBar move={waiting.card.move} work={waiting.t} state={state} onAnswer={focus} keyed={cardsOf.length > 1} />}
        </header>
        <div className="screenbody">
          <div className="screenmain">
            {chat && (chat.items.length || !topic) ? (
              <Chat session={chat} name={topic ? undefined : 'owner'} sessions={state.sessions} canvases={state.canvases} tasks={tasks} self={topic ? undefined : { kind: 'task', id: subject!.id }} onOpenRef={(r) => onSelect(refSelection(r))} onOpenTask={onOpenKey} placeholder={topic ? 'Reply…' : 'Write to the owner: ask, change the plan, give feedback…'} cards={cards} chip={chip} readOnly={!!topic && isSubagent(topic)} />
            ) : topic ? (
              <div className="chatbox">
                <div className="items">
                  <p className="muted small">
                    Work on the project with the agent: a problem, ideas, design, a quick change. It works in the repo like
                    Claude Code; what it draws and plans shows in its artifacts.
                  </p>
                  {cards}
                </div>
                <Composer busy={false} placeholder="Reply…" commands={chatCommands(topic, state.sessions)} onSend={(t: string, a: Attachment[], r: ChatRef[]) => mag.send(topic.id, t, a, r)} chip={chip} refsFrom={refsFrom!} />
              </div>
            ) : (
              <div className="chatbox">
                <div className="items">
                  <p className="muted small">This work has no owner conversation yet. Groom it: an agent reads the brief, plans the work with you here.</p>
                  {cards}
                </div>
              </div>
            )}
          </div>
          {drawer.open ? (
            <ArtifactDrawer open={drawer.open} state={state} onClose={drawer.close} onGone={gone} onOpenKey={onOpenKey} onSelect={onSelect} />
          ) : listShown && artifacts.length > 0 && (
            <ArtifactsList artifacts={artifacts} onOpen={drawer.setOpen} />
          )}
        </div>
      </section>
    </CanvasOpener.Provider>
  )
}

/** The topic's title; a click renames it, Enter saves, Esc cancels. */
function TopicTitle({ topic }: { topic: AgentSession }) {
  const title = topic.title ?? 'Topic'
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  if (draft === null) return <button className="topictitle" title="Rename" onClick={() => { cancelled.current = false; setDraft(title) }}>{title}</button>
  const save = () => {
    const t = draft.trim()
    setDraft(null)
    if (!cancelled.current && t && t !== title) void mag.renameChat(topic.id, t)
  }
  return (
    <input
      autoFocus
      className="topictitle"
      value={draft}
      aria-label="Topic title"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
      }}
    />
  )
}
