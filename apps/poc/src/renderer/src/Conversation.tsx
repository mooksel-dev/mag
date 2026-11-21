import { useCallback, useMemo, useRef, useState } from 'react'
import {
  agentState,
  chatCommands,
  isReview,
  ownedWorks,
  prRepoName,
  reviewTopic,
  isSubagent,
  isSubtopic,
  sessionRole,
  shortTitle,
  workCard,
  workspaceAsProject,
  type SessionHeader,
  type Attachment,
  type CanvasRef,
  type ChatLink,
  type ChatRef,
  type Task,
} from '@mag/core'
import type { AppState } from '../../preload/api'
import { LabelChips } from './labels/LabelChips'
import { HeadMenu, TopicPanel, WaitingBar, workMenuCard, workSessions } from './ArtifactPane'
import { openHit } from './jump'
import { topicAgents, topicApprovals, topicArtifacts, type ArtifactTarget } from './artifacts'
import { topicDeliverables } from './deliverableText'
import { WorkCards } from './Cards'
import { ReviewTable } from './ReviewTable'
import { ApprovalCard, CanvasOpener, Chat, Composer, SessionModelChip } from './Chat'
import { ArtifactDrawer } from './Drawer'
import { PaneHandle, usePaneWidth } from './PaneHandle'
import { TicketLinks, AgentDot, useNow } from './Tasks'
import type { MenuCard, Selection } from './WorkList'
import { Icon } from './ui/Icon'

const mag = window.mag

/**
 * The conversation of a work: its owner (the topic that planned it, or its groomer; a review's topic). Legacy works
 * without one fall back to their latest groomer.
 */
export function ownerSession(work: Task, sessions: SessionHeader[]): SessionHeader | null {
  return (
    sessions.find((s) => s.id === work.ownerSessionId)
    ?? (isReview(work) ? reviewTopic(work, sessions) : undefined)
    ?? sessions.filter((s) => s.taskId === work.id && s.role === 'groomer').at(-1)
    ?? null
  )
}

/** What opens a referenced chat: its topic, or its work or review. */
const refSelection = (ref: ChatLink): Selection => ({ kind: ref.kind === 'topic' ? 'topic' : 'work', id: ref.id })

/** The drawer of a screen: the artifact open in it, and the opener canvas cards in the chat use. */
function useDrawer(initial: ArtifactTarget | null) {
  const [open, setOpen] = useState<ArtifactTarget | null>(initial)
  const show = useCallback((c: CanvasRef | string, focus?: string) => setOpen({ kind: 'canvas', id: typeof c === 'string' ? c : c.id, focus }), [])
  const close = useCallback(() => setOpen(null), [])
  return { open, setOpen, show, close }
}

/**
 * A topic's screen (topics-a-tree-of-agent.3): a compact header (title, kind, Agents, ⋯ with New subtopic) and what
 * waits on you; below, its conversation with the cards of every work it owns, and at the right its panel (its agents,
 * then its documents and diagrams, topic-screen-one-new-compact.2), or the one opened in the drawer; both sides resize
 * (topic-screen-one-new-compact.1). The panel shows by default while an agent works or waits on you, until the user
 * toggles it. A work opens here, through its owner topic, with its card open.
 * `topic` null: a work whose owner is its groomer, or nobody yet; the screen is the work's, with the groomer's chat.
 */
export function TopicConversation({ topic, work, initial = null, state, onOpenKey, onSelect, onDeleted }: {
  topic: SessionHeader | null
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
  const projectId = topic ? topic.projectId : work!.projectId
  const workspace = topic && !topic.projectId ? state.workspaces.find((w) => w.id === topic.workspaceId) : undefined
  // A topic without a project runs on its workspace's settings.
  const project = state.projects.find((p) => p.id === projectId) ?? (workspace && workspaceAsProject(workspace))
  const tasks = state.tasks.filter((t) => t.projectId === projectId)
  const drawer = useDrawer(initial)
  const rightPane = usePaneWidth('right')
  const artifacts = useMemo(() => topicArtifacts(topic, state, topic ? null : work), [topic, work, state])
  const agents = useMemo(() => topicAgents(topic, state, topic ? null : work), [topic, work, state])
  const deliverables = useMemo(() => topicDeliverables(topic, state), [topic, state])
  const agentCount = agents.active.length + agents.finished.length
  const hasPanel = artifacts.count > 0 || agentCount > 0 || deliverables.length > 0
  // null: the default, shown while an agent works or waits on you; the user's toggle wins.
  const [panelChoice, setPanelChoice] = useState<boolean | null>(null)
  const listShown = panelChoice ?? agents.active.some((a) => a.state !== 'failed')
  // The review mag made this topic for: the screen is that review's.
  const review = topic ? tasks.find((t) => isReview(t) && (t.id === topic.reviewOf || reviewTopic(t, state.sessions)?.id === topic.id)) : work && isReview(work) ? work : undefined
  // The conversation: the topic, else the work's owner (its groomer, or a review's topic that is gone).
  const chat = topic ?? (work ? ownerSession(work, state.sessions) : null)
  // The works whose cards wait at the end of the conversation: those this session owns, the one opened first.
  const reviews = topic ? tasks.filter((t) => isReview(t) && t !== review && t.ownerSessionId === topic.id && t.status === 'in_progress') : []
  const owned = topic ? [...(review ? [review] : []), ...reviews, ...ownedWorks(topic.id, tasks)] : work ? [work] : []
  const cardsOf = work && owned.some((t) => t.id === work.id) ? [work, ...owned.filter((t) => t.id !== work.id)] : owned
  const yours = cardsOf.map((t) => ({ t, card: workCard(t, tasks, state.sessions, now) })).filter((c) => c.card?.move.who === 'you')
  // Several reviews waiting: the bar counts them, the table below lists them.
  const waitingReviews = yours.filter((c) => isReview(c.t)).length
  const waiting = waitingReviews > 1
    ? { t: yours.find((c) => isReview(c.t))!.t, card: { move: { who: 'you' as const, text: `${waitingReviews} reviews wait on you: pick what to publish in the table below` } } }
    : yours[0]
  // An answer goes into the composer.
  const focus = () => requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('.screenmain .richinput')?.focus())
  // A topic's reviews are one table; its works keep their cards.
  // A review made a moment ago has no PR recorded yet: it joins the table once it has.
  const reviewsHere = topic ? cardsOf.filter((t) => isReview(t) && !!t.prReview) : []
  const worksHere = cardsOf.filter((t) => !reviewsHere.includes(t))
  // What the topic's own agents wait on: their cards are here, where the user talks.
  const asks = topic ? topicApprovals(topic, state.sessions) : []
  const cards = cardsOf.length || asks.length ? (
    <>
      {asks.map(({ session: s, item }) => <ApprovalCard key={item.id} sessionId={s.id} item={item} who={sessionRole(s)} />)}
      {reviewsHere.length > 0 && <ReviewTable reviews={reviewsHere} project={project} state={state} onOpen={(taskId) => drawer.setOpen({ kind: 'review', taskId })} />}
      {worksHere.map((t) => <WorkCards key={t.id} work={t} owner={chat} state={state} onAnswer={focus} label={worksHere.length > 1 || reviewsHere.length > 0} />)}
    </>
  ) : undefined
  const canGroom = !topic && !!work && !isReview(work) && !workSessions(work, state).some((s) => s.status === 'running') && !work.work && (work.status === 'planning' || work.status === 'ready')
  const pr = review?.prReview?.pr
  // A work or review closed or deleted from its card: back to the topic without it (gone with it too: Home).
  const gone = () => {
    drawer.close()
    if (topic) onSelect({ kind: 'topic', id: topic.id })
    else onDeleted()
  }
  const refsFrom = topic && { projectId: projectId ?? '', tasks, sessions: state.sessions.filter((s) => s.projectId === projectId && s.workspaceId === topic.workspaceId), self: { kind: 'topic' as const, id: topic.id } }
  const parent = topic?.parentId ? state.sessions.find((s) => s.id === topic.parentId) : undefined
  const subject = topic ? null : work!
  const menu: MenuCard = review ? workMenuCard(review) : topic ? { kind: 'topic', title: shortTitle(topic), session: topic, closed: !!topic.closedAt } : workMenuCard(subject!)
  return (
    <CanvasOpener.Provider value={drawer.show}>
      <section className="convo" ref={box}>
        <header className="convohead">
          <div className="headline">
            {topic ? <TopicTitle topic={topic} /> : <h1 title={subject!.title}>{shortTitle(subject!)}</h1>}
            <span className="kind">{review ? `review · ${review.key}` : topic ? (!topic.parentId ? 'topic' : isSubtopic(topic) ? 'subtopic' : `agent · ${sessionRole(topic)}`) : subject!.key}</span>
            {topic && !topic.parentId && !topic.taskId && <LabelChips itemRef={`topic:${topic.id}`} projectId={topic.projectId} workspaceId={topic.workspaceId} state={state} movable={!owned.length} />}
            {subject && project && <LabelChips itemRef={`work:${subject.id}`} projectId={subject.projectId} workspaceId={project.workspaceId} state={state} movable={false} />}
            {review && pr && project ? <button className="link small" onClick={() => mag.open(pr.url)}>{prRepoName(project, pr)}#{pr.number} <Icon name="external" size={12} /></button> : subject && <TicketLinks task={subject} />}
            {subject && !review && <AgentDot state={agentState(subject, workSessions(subject, state), tasks)} now={now} />}
            <div className="grow" />
            {project && chat && <SessionModelChip project={project} session={chat} tasks={tasks} />}
            {canGroom && !chat && <button className="small" onClick={() => mag.groom(subject!.id)}>Groom</button>}
            {review && <button className="small" title="The whole review in its own window" onClick={() => mag.openWindow({ kind: 'review', taskId: review.id })}>Open review <Icon name="window" size={14} /></button>}
            {hasPanel && (
              <button className={`small agentsbtn${listShown ? ' on' : ''}`} aria-pressed={listShown} title="The agents of this topic, and the documents and diagrams made here" onClick={() => (drawer.open ? (drawer.close(), setPanelChoice(true)) : setPanelChoice(!listShown))}>
                <AgentCounts agents={agents} total={agentCount} />
              </button>
            )}
            <HeadMenu card={menu} onSelect={onSelect} onGone={onDeleted} />
          </div>
          {topic?.parentId && (
            <div className="muted small">
              Under {parent ? <button type="button" className="link" onClick={() => onSelect({ kind: 'topic', id: parent.id })}>{shortTitle(parent)}</button> : 'a deleted topic'}
            </div>
          )}
          {waiting?.card && <WaitingBar move={waiting.card.move} work={waiting.t} state={state} onAnswer={focus} keyed={cardsOf.length > 1 && waitingReviews < 2} />}
        </header>
        <div className={`screenbody${rightPane.width === null ? '' : ' sized'}`} style={rightPane.style}>
          <div className="screenmain">
            {chat && (chat.itemCount || !topic) ? (
              <Chat session={chat} name={topic ? undefined : 'owner'} sessions={state.sessions} canvases={state.canvases} tasks={tasks} self={topic ? undefined : { kind: 'task', id: subject!.id }} onOpenRef={(r) => (r.kind === 'hit' ? openHit(r.id, r.title) : onSelect(refSelection(r)))} onOpenTask={onOpenKey} onOpenSession={(id) => onSelect({ kind: 'topic', id })} placeholder={topic ? 'Reply…' : 'Write to the owner: ask, change the plan, give feedback…'} cards={cards} readOnly={!!topic && isSubagent(topic)} />
            ) : topic ? (
              <div className="chatbox">
                <div className="items">
                  {topic.brief && <TopicBrief topic={topic} onOpenKey={onOpenKey} />}
                  <p className="muted small">
                    {topic.parkedAt
                      ? 'An idea, parked. Write to talk it over with the agent: it sees the idea and reads the code. Your first message makes it a live topic.'
                      : 'Work on the project with the agent: a problem, ideas, design, a quick change. It works in the repo like Claude Code; what it draws and plans shows in its artifacts.'}
                  </p>
                  {cards}
                </div>
                <Composer busy={false} placeholder="Reply…" draftKey={topic.id} commands={chatCommands(topic, state.sessions)} onSend={(t: string, a: Attachment[], r: ChatRef[]) => mag.send(topic.id, t, a, r)} refsFrom={refsFrom!} />
              </div>
            ) : (
              <div className="chatbox">
                <div className="items">
                  <p className="muted small">This has no conversation yet. Groom it: an agent reads the brief and plans it with you here.</p>
                  {cards}
                </div>
              </div>
            )}
          </div>
          {(drawer.open || (listShown && hasPanel)) && <PaneHandle side="right" onResize={rightPane.set} />}
          {drawer.open ? (
            <ArtifactDrawer open={drawer.open} state={state} onClose={drawer.close} onGone={gone} onOpenKey={onOpenKey} onSelect={onSelect} />
          ) : listShown && hasPanel && (
            <TopicPanel agents={agents} artifacts={artifacts} deliverables={deliverables} onOpen={drawer.setOpen} onSelect={onSelect} />
          )}
        </div>
      </section>
    </CanvasOpener.Provider>
  )
}

/** The Agents button: how many agents the topic has, and how many work, wait on you or failed. */
function AgentCounts({ agents, total }: { agents: ReturnType<typeof topicAgents>; total: number }) {
  if (!total) return <>Artifacts</>
  const failed = agents.active.filter((a) => a.state === 'failed').length
  return (
    <>
      Agents {total}
      {agents.working > 0 && <span className="agentcount" title={`${agents.working} working`}><span className="sessdot blue" aria-hidden />{agents.working}</span>}
      {agents.waiting > 0 && <span className="agentcount" title={`${agents.waiting} wait on you`}><span className="sessdot amber" aria-hidden />{agents.waiting}</span>}
      {failed > 0 && <span className="agentcount" title={`${failed} failed`}><span className="sessdot red" aria-hidden />{failed}</span>}
    </>
  )
}

/** The idea a topic was parked with (ideas-are-parked-topics.1): its text and where it came from. */
function TopicBrief({ topic, onOpenKey }: { topic: SessionHeader; onOpenKey: (key: string) => void }) {
  const source = topic.source
  return (
    <div className="topicbrief">
      <div className="muted small">
        Idea {source ? <>from <button type="button" className="link key" onClick={() => onOpenKey(source.replace(/\.\d+$/, ''))}>{source}</button></> : 'of yours'}
      </div>
      <div className="ideatext">{topic.brief}</div>
    </div>
  )
}

/** The topic's title as the sidebar shows it (shortTitle); a click renames it, Enter saves, Esc cancels. */
function TopicTitle({ topic }: { topic: SessionHeader }) {
  const title = shortTitle(topic)
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
