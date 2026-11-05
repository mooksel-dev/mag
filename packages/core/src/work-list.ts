// The work list (ux-odna-rozmova-na-robotu.2, work-list-the-left-column.1): the left column of the project window, one
// card per work (reviews of teammates' PRs included) and per topic without a work: what it is, where it stands, whose
// move it is and what happened last, from what mag already knows.

import {
  currentStep,
  inbox,
  isLegacy,
  isReview,
  openPrs,
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

/** waiting = on the user; working = an agent runs (or someone else: CI, the PR author); topics = without a work. */
export type WorkGroup = 'waiting' | 'working' | 'topics' | 'done'

export const WORK_GROUPS: WorkGroup[] = ['waiting', 'working', 'topics', 'done']

export const WORK_GROUP_LABELS: Record<WorkGroup, string> = {
  waiting: 'Waiting on you',
  working: 'Agents working',
  topics: 'Discussions',
  done: 'Done · 7 days',
}

export type CardKind = 'work' | 'review' | 'topic'
/** amber = waiting on you, green = an agent working, grey = idle or someone else's move. */
export type CardDot = 'amber' | 'green' | 'grey'

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
  task?: Task
  session?: AgentSession
}

export type CardFilter = 'all' | 'waiting' | 'working' | 'reviews'
export const CARD_FILTERS: CardFilter[] = ['all', 'waiting', 'working', 'reviews']
export const CARD_FILTER_LABELS: Record<CardFilter, string> = { all: 'All', waiting: 'Waiting on you', working: 'Working', reviews: 'Reviews' }

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
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
  const role = owner ? 'owner' : s.role === 'chat' ? 'agent' : s.role
  return { who: 'agent', text: [role, span(now - (s.runStartedAt ?? s.createdAt)), activity].filter(Boolean).join(' · ') }
}

/** A pending approval: the tool call to allow. */
function approvalMove(item: InboxItem): CardMove {
  const a = item.session?.items.find((i) => i.kind === 'approval' && i.id === item.approvalId)
  return { who: 'you', text: a?.kind === 'approval' ? `Allow ${a.server} · ${a.tool}` : 'Allow a tool call', action: { kind: 'open' } }
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
  group === 'waiting' ? 'amber' : group !== 'done' && move.who === 'agent' ? 'green' : 'grey'

/**
 * The project's works and the topics that own no open work, as cards in group order (`tasks` are the project's):
 * waiting on the user first, then agents working (someone else's move, grey, at its end), discussions, and done in the
 * last 7 days; canceled works are left out. A work's agents are its own sessions and, for a work owned by a topic (a
 * review too), that topic. Within a group the most recent activity comes first.
 */
export function workCards(projectId: string, tasks: Task[], sessions: AgentSession[], now: number): WorkCard[] {
  const items = inbox(projectId, tasks, sessions)
  const mine = sessions.filter((s) => s.projectId === projectId)
  const works = tasks.filter((t) => !t.parentId && t.projectId === projectId && t.status !== 'canceled')
  const out: WorkCard[] = []
  // A topic that owns several open works opens as the latest updated one (as App does): its approvals count for that one.
  const latestOwned = new Map<string, Task>()
  for (const t of works) {
    if (t.status === 'done' || !t.ownerSessionId) continue
    const prev = latestOwned.get(t.ownerSessionId)
    if (!prev || t.updatedAt > prev.updatedAt) latestOwned.set(t.ownerSessionId, t)
  }
  for (const task of works) {
    const finished = task.status === 'done'
    if (finished && task.updatedAt < now - WEEK_MS) continue
    const own = sessionsOf(task, mine)
    const at = Math.max(task.updatedAt, ...own.map(sessionActivity))
    // A pending approval in the owner topic counts for the work too.
    const ownsTopic = !!task.ownerSessionId && latestOwned.get(task.ownerSessionId) === task
    const item = finished ? undefined : items.find((i) => i.task?.id === task.id || (!i.task && ownsTopic && i.session?.id === task.ownerSessionId))
    const review = isReview(task)
    const move = cardMove(task, item, mine, tasks, now)
    const group: WorkGroup = finished ? 'done' : move.who === 'you' ? 'waiting' : 'working'
    out.push({
      id: task.id,
      kind: review ? 'review' : 'work',
      group,
      dot: dotOf(group, move),
      title: shortTitle(task),
      stage: review ? reviewStage(task, mine) : workStage(task, tasks),
      progress: progressOf(task, tasks),
      move,
      last: lastEvent(task, mine, tasks),
      at,
      task,
    })
  }
  // A topic that owns an open work shows through it; a topic mag created for a review is that review's.
  const owners = new Set(works.filter((t) => t.status !== 'done').map((t) => t.ownerSessionId))
  for (const s of mine) {
    if (s.role !== 'chat' || s.taskId || s.reviewOf || owners.has(s.id)) continue
    if (tasks.some((t) => isReview(t) && reviewTopic(t, sessions)?.id === s.id)) continue
    const approval = items.find((i) => i.kind === 'approval' && i.session?.id === s.id)
    const move: CardMove = approval
      ? approvalMove(approval)
      : s.status === 'running' ? agentMove(s, false, now) : { who: 'other', text: 'Discussion · no work yet' }
    const group: WorkGroup = approval ? 'waiting' : 'topics'
    out.push({ id: s.id, kind: 'topic', group, dot: dotOf(group, move), title: shortTitle(s), stage: null, progress: null, move, last: lastEvent(s, mine), at: sessionActivity(s), session: s })
  }
  const order = (c: WorkCard) => WORK_GROUPS.indexOf(c.group) * 2 + (c.group === 'working' && c.dot === 'grey' ? 1 : 0)
  return out.sort((a, b) => order(a) - order(b) || b.at - a.at)
}

/**
 * The card of one work (a review too), as workCards builds it for its row, so the selected work's header shows the same
 * move. null for what the list leaves out: a canceled work, one done over 7 days ago, a step.
 */
export function workCard(task: Task, tasks: Task[], sessions: AgentSession[], now: number): WorkCard | null {
  return workCards(task.projectId, tasks, sessions, now).find((c) => c.id === task.id && c.kind !== 'topic') ?? null
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

/** The cards a filter shows: waiting = that group; working = an agent running (green dot); reviews = review rows, done included. */
export function cardFilter(cards: WorkCard[], filter: CardFilter): WorkCard[] {
  switch (filter) {
    case 'all':
      return cards
    case 'waiting':
      return cards.filter((c) => c.group === 'waiting')
    case 'working':
      return cards.filter((c) => c.dot === 'green')
    case 'reviews':
      return cards.filter((c) => c.kind === 'review')
  }
}
