// The work list (ux-odna-rozmova-na-robotu.2, work-list-the-left-column.1, .3): the left column of the project window,
// one card per chat with the works it created as its children, and per work without a chat (reviews of teammates' PRs
// included): what it is, where it stands, whose move it is and what happened last, from what mag already knows.

import {
  approvalName,
  currentStep,
  inbox,
  isArchived,
  isLegacy,
  isReview,
  childSessions,
  openPrs,
  rootSession,
  resultLine,
  reviewState,
  reviewTopicIds,
  shownResult,
  reviewTopic,
  subtasksOf,
  type AgentSession,
  type ChatItem,
  type InboxItem,
  type RepoWork,
  type Task,
} from './index.ts'

/**
 * Where a card stands: waiting = on the user; working = an agent runs (or someone else: CI, the PR author); topics =
 * without a work; done = finished or closed. Home lists by it; the sidebar never groups or sorts by it (decision 9).
 */
export type WorkGroup = 'waiting' | 'working' | 'topics' | 'done'

export type CardKind = 'work' | 'review' | 'topic'
/** amber = waiting on you, green = an agent working, grey = idle or someone else's move. */
/** blue = an agent works, amber = waits on you, green = done, ready for you, grey = closed or finished, red = failed. */
export type CardDot = 'blue' | 'amber' | 'green' | 'grey' | 'red'

export type WorkStage = 'Plan' | 'Approve' | 'Build' | 'Merge' | 'Done'
export type ReviewStage = 'Running' | 'Report ready' | 'Waiting for author' | 'Done'

/** What the user does about a card's move: the button of the Waiting-on-you bar (step 2). */
export type MoveAction =
  | { kind: 'open_pr'; url: string }
  | { kind: 'approve_start' }
  | { kind: 'start' }
  | { kind: 'start_step'; stepId: string }
  | { kind: 'answer' }
  | { kind: 'restart'; sessionId: string }
  | { kind: 'publish' }
  | { kind: 'review_again' }
  | { kind: 'open' }

/** Whose move it is, one line: the user's with the exact action, an agent's with what it does, or someone else's. */
export interface CardMove {
  who: 'you' | 'agent' | 'other'
  text: string
  action?: MoveAction
}

export interface WorkCard {
  /** The work's (a review's) id, or the topic's session id. */
  id: string
  kind: CardKind
  group: WorkGroup
  dot: CardDot
  title: string
  stage: WorkStage | ReviewStage | null
  /** "step 2/3 · PR #85"; a review: "PR #12 · @ann". */
  progress: string | null
  move: CardMove
  last: { text: string; at: number } | null
  /** Last activity: the work's update or its sessions' last item. */
  at: number
  /** When the work or topic was created: fixed, so it orders new rows stably. */
  createdAt: number
  /** In Closed: a topic or task with closedAt, or a canceled work. */
  closed: boolean
  task?: Task
  session?: AgentSession
  /** A chat: its own state, without its children's (what a filter matches it by). */
  own?: { group: WorkGroup; dot: CardDot }
  /** A chat: the works it owns and the reviews it asked for (and the sessions under it), newest created first. */
  children?: WorkCard[]
  /** A topic: the sessions under it (topics-a-tree-of-agent.2), each with its own; in the order they were started. */
  sessions?: SessionNode[]
}

/** waiting = an approval waits on the user; closed = closed with its topic or on its own. */
export type SessionState = 'running' | 'waiting' | 'idle' | 'error' | 'closed'

/** A session under a topic, as the sidebar and the topic page show it: its role, where it stands, and its children. */
export interface SessionNode {
  session: AgentSession
  /** general (no role), topic (a branched topic of before the tree), subagent, or its preset. */
  role: string
  state: SessionState
  dot: CardDot
  children: SessionNode[]
}

/** A session's dot by its state: running blue, waiting on you amber, idle green, failed red, closed grey. */
const SESSION_DOTS: Record<SessionState, CardDot> = { running: 'blue', waiting: 'amber', idle: 'green', error: 'red', closed: 'grey' }

/** The label of a child session's role: subagent for one read from its parent's stream. */
export const sessionRole = (s: Pick<AgentSession, 'role' | 'origin' | 'agentJob'>): string =>
  s.origin === 'subagent' ? 'subagent' : s.role === null ? (s.agentJob ? 'agent' : 'general') : s.role === 'chat' ? 'topic' : s.role

const pendingApproval = (s: AgentSession) => s.items.some((i) => i.kind === 'approval' && i.status === 'pending')

/** Where one session stands, by itself. */
export function sessionState(s: AgentSession): SessionState {
  if (pendingApproval(s)) return 'waiting'
  if (s.status === 'running') return 'running'
  if (s.status === 'error') return 'error'
  return s.closedAt ? 'closed' : 'idle'
}

/** The sessions under `parentId`, each with its own (a cycle in a broken file stops at a session seen before). */
export function sessionNodes(parentId: string, sessions: AgentSession[], seen = new Set<string>([parentId])): SessionNode[] {
  return childSessions(parentId, sessions)
    .filter((s) => !seen.has(s.id) && !!seen.add(s.id))
    .map((s) => {
      const state = sessionState(s)
      return { session: s, role: sessionRole(s), state, dot: SESSION_DOTS[state], children: sessionNodes(s.id, sessions, seen) }
    })
}

/** Every node of a tree, parents before children. */
export const flatNodes = (nodes: SessionNode[]): SessionNode[] => nodes.flatMap((n) => [n, ...flatNodes(n.children)])

export type CardFilter = 'all' | 'waiting' | 'working' | 'reviews'
export const CARD_FILTERS: CardFilter[] = ['all', 'waiting', 'working', 'reviews']
export const CARD_FILTER_LABELS: Record<CardFilter, string> = { all: 'All', waiting: 'Waiting on you', working: 'Working', reviews: 'Reviews' }

const MIN_MS = 60_000

/** When a session last did something: its last item, else when its run started or it was created. */
export function sessionActivity(s: AgentSession): number {
  return Math.max(s.items.at(-1)?.at ?? 0, s.runStartedAt ?? 0, s.createdAt)
}

/** "12 min", "3 h", "2 d". */
export function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / MIN_MS))
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

/** One line, at most `n` characters. */
const cut = (text: string, n = 80) => {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? ''
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}

/** The last item of a kind (ES2022 has no findLast). */
function lastItem<K extends ChatItem['kind']>(items: ChatItem[], ...kinds: K[]): Extract<ChatItem, { kind: K }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) if ((kinds as string[]).includes(items[i].kind)) return items[i] as Extract<ChatItem, { kind: K }>
  return undefined
}

const prNo = (r: RepoWork) => r.prUrl?.match(/\/pull\/(\d+)/)?.[1]
const prsText = (prs: RepoWork[]) => (prs.length === 1 ? `PR #${prNo(prs[0])}` : `${prs.length} PRs`)

/**
 * The short human title of a row: a work's title; a review's without its "repo#n: " prefix; a topic's generated (or
 * given) title, else "New topic", never its cut first message.
 */
export function shortTitle(of: Task | AgentSession): string {
  if ('type' in of) return isReview(of) ? of.title.replace(/^[^:]*#\d+: /, '') : of.title
  return (of.titleGenerated && of.title?.trim()) || 'New topic'
}

/** Where a work is: planning, its plan waiting for Approve & Start, steps being built, PRs waiting for merge, or done. */
export function workStage(work: Task, tasks: Task[]): WorkStage | null {
  if (work.status === 'canceled') return null
  if (work.status === 'done') return 'Done'
  if (work.status === 'ready') return 'Approve'
  if (work.status === 'planning') return subtasksOf(work.id, tasks).length && work.needsInput ? 'Approve' : 'Plan'
  const step = isLegacy(work) ? null : currentStep(work.id, tasks)
  return (step ? openPrs(step) : openPrs(work)).length ? 'Merge' : 'Build'
}

/**
 * Where a review is: closed; its agent reviewing; published and waiting for the PR's author; its report waiting on the
 * user. No stage without a report and nothing running (asking, failed, yet to start): the move line says what to do.
 */
export function reviewStage(task: Task, sessions: AgentSession[]): ReviewStage | null {
  const state = reviewState(task, sessions)
  if (state === 'closed') return 'Done'
  if (state === 'reviewing') return 'Running'
  if (!shownResult(task.prReview)?.verdict) return null
  return task.prReview!.posted ? 'Waiting for author' : 'Report ready'
}

/** A work's sessions: its own (groomer, developer, reviewer), its owner topic and, a review, the topic of each result. */
function sessionsOf(task: Task, sessions: AgentSession[]): AgentSession[] {
  const topics = reviewTopicIds(task)
  return sessions.filter((s) => s.taskId === task.id || topics.includes(s.id))
}

/** The running session of a work (see sessionsOf), the latest started. */
function runningOf(task: Task, sessions: AgentSession[]): AgentSession | undefined {
  return sessionsOf(task, sessions)
    .filter((s) => s.status === 'running')
    .sort((a, b) => (b.runStartedAt ?? 0) - (a.runStartedAt ?? 0))[0]
}

/** "developer · 12 min · Bash pnpm test": who runs, for how long, and its last tool call. */
function agentMove(s: AgentSession, owner: boolean, now: number): CardMove {
  const tool = lastItem(s.items, 'tool')
  const activity = tool ? cut(tool.summary ? `${tool.name} ${tool.summary}` : tool.name, 60) : null
  const role = owner ? 'owner' : s.role && s.role !== 'chat' ? s.role : 'agent'
  return { who: 'agent', text: [role, span(now - (s.runStartedAt ?? s.createdAt)), activity].filter(Boolean).join(' · ') }
}

/** A pending approval: the tool call to allow. */
function approvalMove(item: InboxItem): CardMove {
  const a = item.session?.items.find((i) => i.kind === 'approval' && i.id === item.approvalId)
  return { who: 'you', text: a?.kind === 'approval' ? `Allow ${approvalName(a)}` : 'Allow a tool call', action: { kind: 'open' } }
}

/** Opens the first PR (GitHub shows the rest from there), else the work. */
const prAction = (prs: RepoWork[]): MoveAction => (prs[0]?.prUrl ? { kind: 'open_pr', url: prs[0].prUrl } : { kind: 'open' })

/** A review's move by its state. */
function reviewMove(task: Task, sessions: AgentSession[], now: number): CardMove {
  const posted = task.prReview?.posted
  const r = shownResult(task.prReview)
  switch (reviewState(task, sessions)) {
    case 'closed':
      return { who: 'other', text: 'Closed' }
    case 'reviewing': {
      return agentMove(runningOf(task, sessions)!, false, now)
    }
    case 'question':
      return { who: 'you', text: "Answer the agent's question", action: { kind: 'answer' } }
    case 'failed':
      return { who: 'you', text: 'Review again', action: { kind: 'review_again' } }
    case 'outdated':
      return { who: 'you', text: 'Review the new commits', action: { kind: 'review_again' } }
    case 'waiting':
      return { who: 'other', text: 'Waits for the agent' }
    case 'ready':
      if (posted) return { who: 'other', text: `PR author · ${span(now - posted.at)}`, action: { kind: 'open_pr', url: task.prReview!.pr.url } }
      if (r?.report && !r.report.decided) return { who: 'you', text: `Your call on direction (${r.report.direction.options.length} options)`, action: { kind: 'open' } }
      return { who: 'you', text: 'Publish the review', action: { kind: 'publish' } }
  }
}

/**
 * Whose move a work (a review too) is: `item` is its inbox item (or its owner topic's approval), if any. An approval
 * first; a review by its state; a work by its inbox item, else its running agent, else what it waits for (CI, another
 * step) or what the user does next (Approve & Start, Start, continue planning). Ready to merge while CI still runs is
 * CI's move, not the user's.
 */
export function cardMove(task: Task, item: InboxItem | undefined, sessions: AgentSession[], tasks: Task[], now: number): CardMove {
  // An approval blocks the agent of a review too, whatever its state.
  if (item?.kind === 'approval') return approvalMove(item)
  if (isReview(task)) return reviewMove(task, sessions, now)
  if (task.status === 'done') return { who: 'other', text: 'Done' }
  if (task.status === 'canceled') return { who: 'other', text: 'Canceled' }
  const step = isLegacy(task) ? null : currentStep(task.id, tasks)
  const steps = subtasksOf(task.id, tasks)
  const prs = step ? openPrs(step) : openPrs(task)
  if (item) {
    switch (item.kind) {
      case 'agent_failed':
        return item.session
          ? { who: 'you', text: `Restart the ${item.session.role}`, action: { kind: 'restart', sessionId: item.session.id } }
          : { who: 'you', text: 'Restart the agent', action: { kind: 'open' } }
      case 'check_failed':
        return { who: 'you', text: `PR check failed: ${cut(item.text, 60)}`, action: prAction(prs) }
      case 'question':
        if (step?.ownerQuestion) return { who: 'you', text: "Answer the developer's question", action: { kind: 'answer' } }
        if (task.needsQuestions?.length) return { who: 'you', text: `Your call: ${task.needsQuestions.length} question${task.needsQuestions.length > 1 ? 's' : ''}`, action: { kind: 'answer' } }
        if (task.status === 'planning' && steps.length) return { who: 'you', text: 'Approve & Start', action: { kind: 'approve_start' } }
        return { who: 'you', text: `Your call: ${cut(task.needsInput ?? item.text, 60)}`, action: { kind: 'answer' } }
      case 'review_look':
        return { who: 'you', text: `Look at ${prsText(prs)}`, action: prAction(prs) }
      case 'ready_to_merge':
        if (prs.some((r) => r.ci === 'pending')) return { who: 'other', text: `CI · ${prsText(prs)}` }
        return { who: 'you', text: `Merge ${prsText(prs)}`, action: prAction(prs) }
      case 'ready_to_start':
        return step
          ? { who: 'you', text: `Start step ${steps.indexOf(step) + 1}`, action: { kind: 'start_step', stepId: step.id } }
          : { who: 'you', text: 'Start the next step', action: { kind: 'open' } }
      case 'review_ready':
        break
    }
  }
  const running = runningOf(task, sessions)
  if (running) return agentMove(running, running.id === task.ownerSessionId, now)
  if (prs.some((r) => r.ci === 'pending')) return { who: 'other', text: `CI · ${prsText(prs)}` }
  if (step?.waitingFor) return { who: 'other', text: `Waits for ${step.waitingFor.key}` }
  if (task.status === 'planning') return steps.length
    ? { who: 'you', text: 'Approve & Start', action: { kind: 'approve_start' } }
    : { who: 'you', text: 'Continue planning', action: { kind: 'answer' } }
  if (task.status === 'ready') return { who: 'you', text: 'Start', action: { kind: 'start' } }
  // In progress, nothing running and nothing asked: the next step is about to start, or its developer stopped.
  if (step?.status === 'todo') return { who: 'other', text: `Starting step ${steps.indexOf(step) + 1}` }
  return { who: 'you', text: 'The developer stopped: look at the work', action: { kind: 'open' } }
}

/**
 * What happened last: a work's latest notice (in its sessions or its owner topic), agent review of a step or merged
 * step; a review's report or its publishing; a topic's last message.
 */
export function lastEvent(of: Task | AgentSession, sessions: AgentSession[], tasks: Task[] = []): { text: string; at: number } | null {
  const events: { text: string; at: number }[] = []
  if (!('type' in of)) {
    const m = lastItem(of.items, 'user', 'assistant')
    return m ? { text: `${m.kind === 'user' ? 'you' : 'agent'}: ${cut(m.text, 60)}`, at: m.at } : null
  }
  for (const s of sessionsOf(of, sessions)) {
    const n = lastItem(s.items, 'notice')
    if (n) events.push({ text: cut(n.text, 60), at: n.at })
  }
  const r = shownResult(of.prReview)
  if (r?.at) events.push({ text: `agent review: ${resultLine(r) || 'no verdict'}`, at: r.at })
  if (of.prReview?.posted) events.push({ text: 'published to GitHub', at: of.prReview.posted.at })
  for (const step of subtasksOf(of.id, tasks)) {
    if (step.review) {
      const n = step.review.findings.length
      events.push({ text: `agent review: ${step.review.verdict} · ${n} note${n === 1 ? '' : 's'}`, at: step.review.at })
    }
    const merged = step.work?.repos.filter((x) => x.prState === 'merged') ?? []
    if (step.status === 'done' && merged.length) events.push({ text: `${prsText(merged)} merged`, at: step.updatedAt })
  }
  return events.sort((a, b) => b.at - a.at)[0] ?? null
}

/** "step 2/3 · PR #85": a work's current step of its steps and the open PRs; a review's PR and author. */
function progressOf(task: Task, tasks: Task[]): string | null {
  const review = task.prReview
  // Both formats run: which one the row speaks of.
  if (isReview(task)) return review ? `PR #${review.pr.number} · @${review.pr.author}${review.results.v1 && review.results.v2 ? ` · ${review.shown}` : ''}` : null
  const steps = subtasksOf(task.id, tasks)
  const step = isLegacy(task) ? null : currentStep(task.id, tasks)
  const prs = step ? openPrs(step) : openPrs(task)
  const where = steps.length && task.status !== 'planning' ? `step ${step ? steps.indexOf(step) + 1 : steps.length}/${steps.length}` : null
  return [where, prs.length ? prsText(prs) : null].filter(Boolean).join(' · ') || null
}

const dotOf = (group: WorkGroup, move: CardMove): CardDot =>
  group === 'waiting' ? 'amber' : group === 'done' ? 'grey' : move.who === 'agent' ? 'blue' : 'green'

/**
 * The project chat topics of `mine`, mag's topics of reviews included: not an agent's session. Each has a row; the works
 * and reviews it owns are its children.
 */
function chatTopics(mine: AgentSession[]): AgentSession[] {
  // A session under a topic is in that topic's tree, not a row (topics-a-tree-of-agent.2); a parked one is an idea.
  return mine.filter((s) => s.role === 'chat' && !s.taskId && !s.parentId && !s.parkedAt)
}

const finished = (t: Task) => t.status === 'done' || t.status === 'canceled'

/** The top-level works (not reviews) a chat owns (`tasks` are the project's): open ones first, then the newest created. */
export function ownedWorks(sessionId: string, tasks: Task[]): Task[] {
  return tasks
    .filter((t) => !t.parentId && !isReview(t) && t.ownerSessionId === sessionId)
    .sort((a, b) => Number(finished(a)) - Number(finished(b)) || b.createdAt - a.createdAt)
}

/** How urgent a group is for a chat row: the chat takes the most urgent of itself and its children. */
const URGENCY: Record<WorkGroup, number> = { waiting: 3, working: 2, topics: 1, done: 0 }

/** A work's card: its stage, progress, whose move (`item` its inbox item) and what happened last. */
function taskCard(task: Task, item: InboxItem | undefined, mine: AgentSession[], tasks: Task[], now: number): WorkCard {
  const review = isReview(task)
  const move = cardMove(task, item, mine, tasks, now)
  const group: WorkGroup = finished(task) ? 'done' : move.who === 'you' ? 'waiting' : 'working'
  return {
    id: task.id,
    kind: review ? 'review' : 'work',
    group,
    dot: dotOf(group, move),
    title: shortTitle(task),
    stage: review ? reviewStage(task, mine) : workStage(task, tasks),
    progress: progressOf(task, tasks),
    move,
    last: lastEvent(task, mine, tasks),
    at: Math.max(task.updatedAt, ...sessionsOf(task, mine).map(sessionActivity)),
    createdAt: task.createdAt,
    closed: task.status === 'canceled' || !!task.closedAt,
    task,
  }
}

/**
 * A chat's card with the works it owns as `children` (newest created first). Its group is the most urgent of its own
 * (an approval waits on you, a run is working, else a discussion) and its children's; done only when every child is
 * finished and the chat neither asks nor runs. Its move: its own approval or run, else the move of a child waiting on
 * the user "via <key>", else the newest open child's stage, else a discussion's line. Closed only when nothing is open.
 */
function chatCard(s: AgentSession, children: WorkCard[], tree: SessionNode[], approval: InboxItem | undefined, mine: AgentSession[], now: number): WorkCard {
  // The sessions under the topic are its own state (topics-a-tree-of-agent.2): a child running is the topic working.
  const runningChild = flatNodes(tree).find((n) => n.session.status === 'running')?.session
  const running = s.status === 'running' || !!runningChild
  const open = children.filter((c) => c.group !== 'done')
  // Only works finish a topic: a review it asked for is one thing it did.
  const works = children.filter((c) => c.kind === 'work')
  const ownGroup: WorkGroup = approval ? 'waiting' : running ? 'working' : 'topics'
  const childMove = (c: AgentSession) => {
    const m = agentMove(c, false, now)
    return { ...m, text: `${shortTitle(c)} · ${m.text}` }
  }
  const ownMove: CardMove = approval
    ? approvalMove(approval)
    : s.status === 'running' ? agentMove(s, false, now) : runningChild ? childMove(runningChild) : { who: 'other', text: 'Discussion · no work yet' }
  const idle = !approval && !running
  // No child open: a discussion without works is done once closed; one with works, once they all are finished.
  const done = idle && !open.length && (works.length > 0 || !!s.closedAt)
  const closed = idle && !open.length && !!s.closedAt
  const group: WorkGroup = done ? 'done' : [ownGroup, ...open.map((c) => c.group)].reduce((a, b) => (URGENCY[b] > URGENCY[a] ? b : a))
  const waiting = open.find((c) => c.group === 'waiting')
  const via = (c: WorkCard): CardMove => ({ ...c.move, text: `${c.move.text} via ${c.task!.key}` })
  // A review has no row of its own to say what it waits for, so a run elsewhere in the tree does not hide it.
  const review = approval ? undefined : open.find((c) => c.kind === 'review' && c.group === 'waiting')
  const move: CardMove = review
    ? via(review)
    : !idle ? ownMove
    : waiting ? via(waiting)
    // A review can have no stage yet (see reviewStage).
    : open.length ? { who: open[0].move.who, text: `${open[0].stage ?? open[0].move.text} · ${open[0].task!.key}` }
    : closed ? { who: 'other', text: 'Closed' }
    : works.length ? { who: 'other', text: 'Done' }
    : ownMove
  // Green while the chat or any open child has an agent running.
  const dot: CardDot = group === 'waiting' ? 'amber' : group === 'done' ? 'grey' : running || open.some((c) => c.dot === 'blue') ? 'blue' : 'green'
  const last = [lastEvent(s, mine), ...children.map((c) => c.last)].filter((l) => !!l).sort((a, b) => b.at - a.at)[0] ?? null
  const under = flatNodes(tree).map((n) => n.session)
  return {
    id: s.id,
    kind: 'topic',
    group,
    dot,
    title: shortTitle(s),
    stage: null,
    progress: null,
    move,
    last,
    at: Math.max(sessionActivity(s), ...under.map(sessionActivity), ...children.map((c) => c.at)),
    createdAt: s.createdAt,
    closed,
    session: s,
    // mag's topic of a review closes and deletes as that review.
    ...(s.reviewOf && { task: children.find((c) => c.id === s.reviewOf)?.task }),
    own: { group: ownGroup, dot: ownGroup === 'waiting' ? 'amber' : running ? 'blue' : closed ? 'grey' : 'green' },
    ...(children.length ? { children } : {}),
    ...(tree.length ? { sessions: tree } : {}),
  }
}

/**
 * The project's rows as cards (`tasks` are the project's), newest created first; done, canceled and closed ones
 * included. Every chat topic is a row (a parked one is not: it is an idea, see parkedTopics), and the works it owns and
 * the reviews it asked for (it or a session under it, review_pr) are its `children`; works without a chat owner (groomer,
 * ticket, a deleted topic) and reviews with mag's own topic are rows of their own, a review's titled "Review: ". A work's
 * agents are its own sessions and its owner topic (a review's: its topics). The order means nothing to the sidebar (see
 * sidebarRows): it never moves a row.
 */
export function workCards(projectId: string, tasks: Task[], sessions: AgentSession[], now: number): WorkCard[] {
  const items = inbox(projectId, tasks, sessions)
  const mine = sessions.filter((s) => s.projectId === projectId)
  const works = tasks.filter((t) => !t.parentId && t.projectId === projectId)
  const chats = chatTopics(mine)
  const chatIds = new Set(chats.map((s) => s.id))
  const out: WorkCard[] = []
  const children = new Map<string, WorkCard[]>()
  for (const task of works) {
    // A chat's approval is on the chat's row, not on a work's.
    const item = finished(task) ? undefined : items.find((i) => i.task?.id === task.id)
    const c = taskCard(task, item, mine, tasks, now)
    // A work a session under a topic owns is the topic's too, and so is a review it asked for or mag opened a topic for.
    const root = (task.ownerSessionId ? rootSession(task.ownerSessionId, mine) : undefined)?.id ?? (isReview(task) ? reviewTopic(task, mine)?.id : undefined)
    const chat = root && chatIds.has(root) ? root : null
    if (chat) children.set(chat, [...(children.get(chat) ?? []), c])
    else out.push(isReview(task) ? { ...c, title: `Review: ${c.title}` } : c)
  }
  for (const s of chats) {
    const tree = sessionNodes(s.id, mine)
    const ids = new Set([s.id, ...flatNodes(tree).map((n) => n.session.id)])
    const approval = items.find((i) => i.kind === 'approval' && !i.task && !!i.session && ids.has(i.session.id))
    const kids = (children.get(s.id) ?? []).sort((a, b) => b.createdAt - a.createdAt)
    out.push(chatCard(s, kids, tree, approval, mine, now))
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** The rows and their children, as one list (Home, counts, a work's card). */
export function flatCards(cards: WorkCard[]): WorkCard[] {
  return cards.flatMap((c) => [c, ...(c.children ?? [])])
}

/**
 * A subtopic (topic-screen-one-new-compact.2): a session under a topic that the user talks in, as in a topic: a general
 * one (no role, a Branch or New subtopic) or a branched topic of before the tree. Not an agent: a role's preset or a
 * Claude Code subagent.
 */
export const isSubtopic = (s: Pick<AgentSession, 'role' | 'origin' | 'parentId' | 'agentJob'>): boolean =>
  !!s.parentId && s.origin !== 'subagent' && !s.agentJob && (s.role === null || s.role === 'chat')

/** The subtopics of a tree, nested by depth: an agent and everything under it are left out. */
export const subtopicNodes = (nodes: SessionNode[]): SessionNode[] =>
  nodes.filter((n) => isSubtopic(n.session)).map((n) => ({ ...n, children: subtopicNodes(n.children) }))

/**
 * What a topic's row has under it in the sidebar (topic-screen-one-new-compact.2): its subtopics, always, nested by
 * depth. Its agents and works are on the topic's page, not in the sidebar.
 */
export function topicKids(card: Pick<WorkCard, 'sessions'>): SessionNode[] {
  return subtopicNodes(card.sessions ?? [])
}

/**
 * The work a chat opens on: the one it owns that waits on the user, else the first of ownedWorks (the newest open, else
 * the newest); null when it owns none. `tasks` and `sessions` are the project's.
 */
export function headerWork(sessionId: string, tasks: Task[], sessions: AgentSession[], now: number): Task | null {
  const owned = ownedWorks(sessionId, tasks)
  if (!owned.length) return null
  const kids = workCards(owned[0].projectId, tasks, sessions, now).find((c) => c.kind === 'topic' && c.id === sessionId)?.children ?? []
  const waiting = owned.find((t) => kids.some((c) => c.id === t.id && c.group === 'waiting'))
  return waiting ?? owned[0]
}

/** Home's order of a group's cards: the agent working before someone else's move, then the latest activity first. */
export function byActivity(cards: WorkCard[]): WorkCard[] {
  const grey = (c: WorkCard) => (c.group === 'working' && c.dot !== 'blue' ? 1 : 0)
  return [...cards].sort((a, b) => grey(a) - grey(b) || b.at - a.at)
}

/** The card of one work (a review too), as workCards builds it for its row, so the selected work's header shows the same move. null for a step. */
export function workCard(task: Task, tasks: Task[], sessions: AgentSession[], now: number): WorkCard | null {
  return flatCards(workCards(task.projectId, tasks, sessions, now)).find((c) => c.id === task.id && c.kind !== 'topic') ?? null
}

/** done = finished; merge = its PRs open; build = in progress; waiting = for another step; manual = waits for Start; todo = next. */
export type StepState = 'done' | 'merge' | 'build' | 'waiting' | 'manual' | 'todo'

export interface StepLine {
  /** 1-based. */
  no: number
  key: string
  title: string
  /** "PR #85", "2 PRs": the step's PRs, merged ones included. */
  pr?: string
  state: StepState
  /** waiting: the key of the step it waits for. */
  waitsFor?: string
}

/** The selected work's steps for its header: number, title, PRs and where each stands. */
export function stepsLine(work: Task, tasks: Task[]): StepLine[] {
  return subtasksOf(work.id, tasks).map((s, i) => {
    const prs = s.work?.repos.filter((r) => r.prUrl && r.prState !== 'closed') ?? []
    const state: StepState =
      s.status === 'done' ? 'done'
      : prs.some((r) => r.prState === 'open') ? 'merge'
      : s.waitingFor ? 'waiting'
      : s.status === 'in_progress' ? 'build'
      : s.startManually ? 'manual'
      : 'todo'
    return {
      no: i + 1,
      key: s.key,
      title: s.title,
      ...(prs.length ? { pr: prsText(prs) } : {}),
      state,
      ...(state === 'waiting' ? { waitsFor: s.waitingFor!.key } : {}),
    }
  })
}

/** A chat to open or reference: a topic (its session id) or a work or review (its task id). */
export interface ChatRef {
  kind: 'topic' | 'task'
  id: string
}

/** One result of searchAll. */
export interface SearchHit {
  ref: ChatRef
  title: string
  /** A work's or review's key. */
  key: string | null
  /** The summary's first line, if it has one. */
  line: string | null
  /** Around the first word found only in the messages. */
  snippet: string | null
  archived: boolean
  /** Per word: 3 in the title or key, 2 in the summary, 1 in the messages; summed. */
  score: number
  /** Last activity. */
  at: number
}

/** Most hits searchAll returns. */
export const SEARCH_MAX = 50

const said = (s: AgentSession) => s.items.filter((i): i is Extract<ChatItem, { kind: 'user' | 'assistant' | 'job' }> => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'job')

/** The sessions whose messages a work's search reads: its own and its steps' agents, its owner topic, a review's topics. */
function searchSessions(task: Task, tasks: Task[], sessions: AgentSession[]): AgentSession[] {
  const ids = new Set([task.id, ...subtasksOf(task.id, tasks).map((s) => s.id)])
  const topics = reviewTopicIds(task)
  return sessions.filter((s) => (s.taskId && ids.has(s.taskId)) || s.id === task.ownerSessionId || topics.includes(s.id))
}

/** The topics search lists on their own: a chat that owns an open work searches as that work (as before chats had children). */
function searchTopics(sessions: AgentSession[], works: Task[], tasks: Task[]): AgentSession[] {
  const owners = new Set(works.filter((t) => !finished(t)).map((t) => t.ownerSessionId))
  // Sessions under a topic are found on their own too, as branched topics were (topics-a-tree-of-agent.2).
  const under = sessions.filter((s) => s.parentId && !s.taskId)
  return [...chatTopics(sessions), ...under].filter((s) => !owners.has(s.id))
}

/** ~120 characters of `text` around `at`, on one line. */
function snippetAt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + length + 80)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}

/**
 * Searches the project's topics and top-level works and reviews, archive included (⌘K): every word of `query`,
 * case-insensitive, must be in the title or key, the summary or the messages (user, assistant, job; a work's: its own,
 * its steps' and its owner topic's). Best score first, then the latest activity; at most SEARCH_MAX. `tasks` and
 * `sessions` are the project's. No words: no hits.
 */
export function searchAll(query: string, tasks: Task[], sessions: AgentSession[]): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const works = tasks.filter((t) => !t.parentId)
  const items = [
    ...works.map((t) => {
      const own = searchSessions(t, tasks, sessions)
      return { ref: { kind: 'task' as const, id: t.id }, item: t, key: t.key, own, at: Math.max(t.updatedAt, ...own.map(sessionActivity)) }
    }),
    ...searchTopics(sessions, works, tasks).map((s) => ({ ref: { kind: 'topic' as const, id: s.id }, item: s, key: null, own: [s], at: sessionActivity(s) })),
  ]
  const hits: SearchHit[] = []
  for (const { ref, item, key, own, at } of items) {
    const title = shortTitle(item)
    const head = `${title}\n${key ?? ''}`.toLowerCase()
    const sum = item.summary
    const summary = sum ? [sum.title, ...sum.gist, ...sum.decisions, ...sum.open, ...sum.keywords].join('\n').toLowerCase() : ''
    // Messages are read only for a word the title and summary don't have.
    let messages: { text: string; lower: string }[] | null = null
    let snippet: string | null = null
    let score = 0
    for (const w of words) {
      if (head.includes(w)) score += 3
      else if (summary.includes(w)) score += 2
      else {
        messages ??= own.flatMap(said).sort((a, b) => a.at - b.at).map((i) => ({ text: i.text, lower: i.text.toLowerCase() }))
        const m = messages.find((x) => x.lower.includes(w))
        if (!m) { score = 0; break }
        score += 1
        snippet ??= snippetAt(m.text, m.lower.indexOf(w), w.length)
      }
    }
    if (score) hits.push({ ref, title, key, line: sum?.gist[0] ?? null, snippet, archived: isArchived(item), score, at })
  }
  return hits.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, SEARCH_MAX)
}

/**
 * Whether a card matches a filter on its own: waiting = that group; working = an agent running (green dot); reviews =
 * a review, done included. A chat by its own state, not its children's, so a count counts each thing once.
 */
export function cardMatches(c: WorkCard, filter: CardFilter): boolean {
  const own = c.own ?? c
  switch (filter) {
    case 'all':
      return true
    case 'waiting':
      return own.group === 'waiting'
    case 'working':
      return own.dot === 'blue'
    case 'reviews':
      return c.kind === 'review'
  }
}

/** The cards that match a filter on their own (see cardMatches). */
export function cardFilter(cards: WorkCard[], filter: CardFilter): WorkCard[] {
  return cards.filter((c) => cardMatches(c, filter))
}

/** A review closed under a topic still open: the topic is no longer about it, as a closed review's own row leaves the list. */
const closedUnder = (row: WorkCard, kid: WorkCard) => kid.kind === 'review' && kid.closed && !row.closed

/** A row a filter shows: it matches, or one of its children does; under it, only the matching children show. */
export function rowMatches(c: WorkCard, filter: CardFilter): boolean {
  return cardMatches(c, filter) || !!c.children?.some((k) => !closedUnder(c, k) && cardMatches(k, filter))
}

/** What the sidebar's filter counts count: each open row and its children, as one list. */
export function countedCards(cards: WorkCard[]): WorkCard[] {
  return cards.filter((c) => !c.closed).flatMap((c) => [c, ...(c.children ?? []).filter((k) => !closedUnder(c, k))])
}
