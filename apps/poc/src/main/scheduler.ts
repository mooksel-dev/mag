import { FALLBACK_BASE } from '@mag/core'
import { rmdir } from 'node:fs'
import { ciState, prProblems, currentStep, isLegacy, isReview, prHeads, reviewPollOutcome, prRollup, prsMerged, repoWorkName, reviewActivity, reviewDue, subtasksOf, type AgentSession, type PrState, type RepoWork, type Task, type TaskWork, type Workspace } from '@mag/core'
import type { Store } from './store'
import type { Orchestrator } from './orchestrator'
import { changedRepos, prChecks, prFeedback, prMergeable, prState, removeWorktree, type PrFeedback } from './git.ts'
import { log } from './log.ts'
import type { People } from './core/services/people/index.ts'
import type { Inbox } from './core/services/inbox/index.ts'
import type { FollowUp, Routines } from './core/services/routines/index.ts'
import { followUpKey } from './core/services/routines/refs.ts'

const PR_POLL_EVERY_MS = 60_000
/** Steps start this long after the change that made them next, so one burst of changes starts each once. */
const ADVANCE_DELAY_MS = 300

const STATES: Record<Awaited<ReturnType<typeof prState>>['state'], PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/**
 * Watches the open PRs of the tasks in progress, step by step: a step whose PRs are merged is done and the next one
 * starts (unless it starts manually); the task is done with its last step. Legacy tasks (see isLegacy) are watched as
 * a whole. It never starts a ready work: the user does.
 */
export function startScheduler(store: Store, orch: Orchestrator) {
  const anyRunning = (pred: (s: AgentSession) => boolean) => store.data.sessions.some((s) => pred(s) && orch.isRunning(s.id))

  /**
   * Every PR is merged, but is the step (or legacy task) done? Not while its developer still works, nor while a repo
   * with commits has no merged PR yet (the developer opened the first PR before finishing the others).
   */
  const finished = async (owner: Task, work: TaskWork) => {
    if (anyRunning((s) => (owner.parentId ? s.stepId === owner.id : s.taskId === owner.id))) return false
    return prsMerged(work, await changedRepos(work, FALLBACK_BASE))
  }

  // A PR closed without merge is not polled again; the developer opens a new one (set_pr) if needed.
  const live = (r: RepoWork) => !!r.prUrl && r.prState !== 'merged' && r.prState !== 'closed'

  /** Polls the live PRs of a step, or of a legacy task (owner = task): merges, closes and new comments. */
  const pollWork = async (owner: Task, task: Task) => {
    const work = owner.work!
    const repos: RepoWork[] = []
    const feedback: (PrFeedback & { repo: string })[] = []
    /** Failing CI checks of the step's open PRs, one line each. */
    const failed: string[] = []
    for (const r of work.repos) {
      if (!r.prUrl || !live(r)) {
        repos.push(r)
        continue
      }
      try {
        const pr = await prState(r.prUrl)
        const state = STATES[pr.state]
        const prDraft = state === 'open' && pr.draft
        // Feedback problems must not block merge detection.
        if (state === 'open') {
          try {
            for (const f of await prFeedback(r.prUrl)) if (f.at > work.feedbackSeenAt) feedback.push({ ...f, repo: repoWorkName(work, r) })
          } catch (e) {
            repos.push({ ...r, prState: state, prDraft, checkError: checkError(owner.key, e) })
            continue
          }
        }
        // CI and mergeability of a step's open PR (ux-odna-rozmova-na-robotu.1): a failure keeps what was known.
        const health: Partial<RepoWork> = {}
        if (state === 'open' && owner !== task) {
          try {
            const checks = await prChecks(r.prUrl)
            health.ci = ciState(checks)
            const failing = checks.filter((c) => c.bucket === 'fail')
            if (failing.length) failed.push(...failing.map((c) => `- ${repoWorkName(work, r)}: ${c.name}${c.link ? ` (${c.link})` : ''}`))
          } catch (e) {
            log.warn('scheduler', `${owner.key}: CI checks of ${r.prUrl} failed: ${(e as Error).message.split('\n')[0]}`)
          }
          try {
            health.mergeable = await prMergeable(r.prUrl)
          } catch (e) {
            log.warn('scheduler', `${owner.key}: mergeability of ${r.prUrl} failed: ${(e as Error).message.split('\n')[0]}`)
          }
        }
        repos.push({ ...r, prState: state, prDraft, prHead: pr.head, checkError: null, ...health })
      } catch (e) {
        repos.push({ ...r, checkError: checkError(owner.key, e) })
      }
    }
    const next = { ...work, repos }
    // Only merges and closes matter here; whether every changed repo has a PR is set_pr's business.
    const closed = repos.filter((r, i) => r.prState === 'closed' && work.repos[i].prState !== 'closed').map((r) => repoWorkName(work, r))
    if (closed.length) {
      log.info('scheduler', `${owner.key}: PR closed for ${closed.join(', ')}`)
      store.updateTask(owner.id, { work: next })
      store.updateTask(task.id, { needsInput: `${owner === task ? '' : `${owner.key}: `}PR for ${closed.join(', ')} was closed without merging` })
      return
    }
    if (prRollup(next, []) === 'done' && (await finished(owner, next))) {
      log.info('scheduler', `${owner.key} done: every PR merged`)
      if (owner !== task) {
        // Its developer's afterRun may have closed it while we checked.
        if (store.task(owner.id).status === 'done') return
        store.updateTask(owner.id, { work: next })
        return orch.completeStep(owner.id)
      }
      store.updateTask(task.id, { status: 'done', needsInput: null, work: next })
      // A legacy task's subtasks are a checklist: done with it.
      for (const s of subtasksOf(task.id, store.data.tasks)) if (s.status !== 'done') store.updateTask(s.id, { status: 'done' })
      for (const r of repos) await removeWorktree(r.repo, r.worktree)
      // Only removes the task dir once it is empty.
      rmdir(work.dir, () => {})
      // Merged code changes the architecture; refresh it if the project keeps one.
      if (store.project(task.projectId).architecture) {
        try {
          orch.architect(task.projectId)
        } catch {}
      }
      return
    }
    store.updateTask(owner.id, { work: next })
    if (feedback.length) {
      // PR states are saved first: the resumed run reads them. Feedback counts as seen only once the developer has it.
      log.info('scheduler', `${owner.key}: ${feedback.length} new PR comment(s)`)
      if (orch.feedback(owner.id, feedback)) store.updateTask(owner.id, { work: { ...next, feedbackSeenAt: Math.max(...feedback.map((f) => f.at)) } })
      return
    }
    if (owner === task) return
    // A failed CI or a conflict goes back to the developer before any review (ux-odna-rozmova-na-robotu.1).
    const { problem, cleared } = prProblems(next)
    orch.clearedPr(owner.id, cleared)
    if (problem) {
      const detail = problem === 'ci' ? failed.join('\n') || '- (the failing checks could not be read: gh pr checks)' : next.repos.filter((r) => r.prState === 'open' && r.mergeable === 'conflict').map((r) => `- ${repoWorkName(next, r)}: ${r.prUrl}`).join('\n')
      if (orch.fixPr(owner.id, problem, detail)) return
    }
    // New commits on a step's PRs (pushed after the user's comments, or by hand) get the agent review again (T-55.1).
    const heads = prHeads(next)
    if (!reviewDue(owner, heads) || anyRunning((s) => s.stepId === owner.id)) return
    if (prRollup(next, await changedRepos(next, FALLBACK_BASE)) === 'review') await orch.review(owner.id, heads)
  }

  /**
   * A review of a teammate's PR (reviews-ahent-reviuit-pr-timeitiv.3): done once the PR is merged or closed (Decision
   * 12); another look at what changed only when the author marks the draft ready (review-v3-concise-design-first.3),
   * once its topic is free; new commits alone wait for the user's Review again. A review the agent has not finished is
   * left to it. Every poll records the PR's activity (author replies, new commits, merge or close) for the inbox
   * (inbox-what-waits-on-me.1); when its comments can't be read, the activity stays as it was.
   */
  const pollReview = async (work: Task) => {
    const r = work.prReview!
    let pr: Awaited<ReturnType<typeof prState>>
    try {
      pr = await prState(r.pr.url)
    } catch (e) {
      checkError(work.key, e)
      return
    }
    let comments: PrFeedback[] | null = []
    if (pr.state === 'OPEN') {
      try {
        comments = await prFeedback(r.pr.url)
      } catch (e) {
        log.warn('scheduler', `${work.key}: comments of ${r.pr.url} failed: ${(e as Error).message.split('\n')[0]}`)
        comments = null
      }
    }
    // The user may have closed it, or it may have changed, while GitHub answered.
    const now = store.task(work.id)
    if (now.status !== 'in_progress' || now.prReview?.pr.url !== r.pr.url) return
    const activity = comments && reviewActivity(now.prReview, pr, comments, now.createdAt, Date.now())
    const same = !activity || JSON.stringify(activity) === JSON.stringify(now.prReview.activity ?? null)
    const review = same ? now.prReview : { ...now.prReview, activity }
    const outcome = reviewPollOutcome(review, pr)
    if (outcome === 'done') {
      log.info('scheduler', `${work.key} done: its PR was ${pr.state.toLowerCase()}`)
      store.updateTask(work.id, { status: 'done', needsInput: null, prReview: review })
      return
    }
    if (outcome === 'draft') {
      store.updateTask(work.id, { prReview: { ...review, pr: { ...review.pr, draft: pr.draft } } })
      return
    }
    if (!same) store.updateTask(work.id, { prReview: review })
    if (outcome !== 'rereview' || orch.isRunning(now.ownerSessionId ?? '')) return
    log.info('scheduler', `${work.key}: its PR was marked ready (${pr.head!.slice(0, 12)}), looking again`)
    await orch.rereview(work.id).catch((e) => checkError(work.key, e))
  }

  let polling = false
  const pollPrs = async () => {
    if (polling) return
    polling = true
    try {
      for (const work of store.data.tasks.filter((t) => isReview(t) && t.status === 'in_progress' && t.prReview)) await pollReview(work)
      for (const task of store.data.tasks.filter((t) => !t.parentId && t.status === 'in_progress' && !isReview(t))) {
        const owner = isLegacy(task) ? task : currentStep(task.id, store.data.tasks)
        // Fully merged but not done: merged while its developer ran, so pollWork skipped it then.
        if (owner?.work && (owner.work.repos.some(live) || prRollup(owner.work, []) === 'done')) await pollWork(owner, task)
      }
    } finally {
      polling = false
    }
  }

  /** Starts the current step of every task in progress that is not running, waiting on the user or starting manually. */
  const advance = () => {
    for (const task of store.data.tasks) {
      if (task.parentId || task.status !== 'in_progress' || isLegacy(task) || task.needsInput) continue
      if (anyRunning((s) => s.taskId === task.id)) continue
      const step = currentStep(task.id, store.data.tasks)
      if (step?.status !== 'todo' || step.startManually) continue
      log.info('scheduler', `${task.key}: starting ${step.key}`)
      orch.develop(task.id).catch((e) => {
        log.warn('scheduler', `${task.key}: starting ${step.key} failed: ${(e as Error).message}`)
        store.updateTask(task.id, { needsInput: `Could not start ${step.key}: ${(e as Error).message}` })
      })
    }
  }
  let advancing: NodeJS.Timeout | null = null
  store.onChange(() => {
    advancing ??= setTimeout(() => {
      advancing = null
      advance()
    }, ADVANCE_DELAY_MS)
  })

  void pollPrs()
  advance()
  // Not what keeps mag (or a test) running.
  setInterval(pollPrs, PR_POLL_EVERY_MS).unref()
  return { pollNow: pollPrs }
}

function checkError(key: string, e: unknown) {
  const msg = (e as Error).message ?? String(e)
  log.warn('scheduler', `PR check failed for ${key}: ${msg}`)
  return msg.split('\n')[0]
}

/** People sync once a day per workspace (who-is-who-people-from.1). */
export const PEOPLE_SYNC_EVERY_MS = 24 * 60 * 60_000
const PEOPLE_CHECK_EVERY_MS = 60 * 60_000

/** Workspaces with a directory whose last people sync is a day old or more. */
export function peopleSyncDue(workspaces: Workspace[], lastSyncedAt: (id: string) => number, now: number): string[] {
  return workspaces.filter((w) => (w.directories?.slack || w.directories?.atlassian || w.directories?.githubOrgs?.length) && now - lastSyncedAt(w.id) >= PEOPLE_SYNC_EVERY_MS).map((w) => w.id)
}

/** Syncs the people of each workspace that is due, now and every hour after; `onSynced` after each. */
export function startPeopleSync(store: Pick<Store, 'workspaces'>, people: Pick<People, 'sync' | 'lastSyncedAt'>, onSynced: () => void = () => {}) {
  let running = false
  const check = async () => {
    if (running) return
    running = true
    try {
      for (const id of peopleSyncDue(store.workspaces(), people.lastSyncedAt, Date.now())) {
        try {
          const r = await people.sync(id)
          log.info('scheduler', `people of ${id}: ${r.matched} matched, ${r.new} new, ${r.unmatched} unmatched${r.errors.length ? `; ${r.errors.join('; ')}` : ''}`)
        } catch (e) {
          log.warn('scheduler', `people of ${id}: sync failed: ${(e as Error).message}`)
        }
        onSynced()
      }
    } finally {
      running = false
    }
  }
  void check()
  setInterval(check, PEOPLE_CHECK_EVERY_MS).unref()
  return { checkNow: check }
}

/** How often due routines are looked for: a slot is a whole minute. */
export const ROUTINE_TICK_MS = 60_000

/** Starts each routine due at `now` (routines-scheduled-drafts-and-a.1); one that fails to start is logged, the rest still run. */
export function routineTick(routines: Pick<Routines, 'due'>, run: (id: string) => Promise<unknown>, now: number) {
  for (const r of routines.due(now)) {
    log.info('scheduler', `routine ${r.name} is due`)
    run(r.id).catch((e) => log.warn('scheduler', `routine ${r.name}: the run did not start: ${(e as Error).message}`))
  }
}

/** A due follow-up's Inbox item: who and what, its source as the ref. */
export const followUpItem = (f: FollowUp) => ({
  key: followUpKey(f.id),
  kind: 'follow_up' as const,
  text: `${f.who}: ${f.what}`,
  workspaceId: f.workspaceId,
  projectId: f.projectId,
  ref: f.sourceRef,
  labels: f.projectId ? [f.projectId] : [],
  dueAt: f.dueAt,
})

/** Puts each follow-up due at `now` in the Inbox, once (routines-scheduled-drafts-and-a.3); one that fails is logged, the rest still go. */
export function followUpTick(routines: Pick<Routines, 'dueFollowUps' | 'surfaceFollowUp'>, inbox: Pick<Inbox, 'add'>, now: number) {
  for (const f of routines.dueFollowUps(now)) {
    try {
      inbox.add(followUpItem(f))
      routines.surfaceFollowUp(f.id)
    } catch (e) {
      log.warn('scheduler', `follow-up ${f.id}: ${(e as Error).message}`)
    }
  }
}

/** Runs due routines and surfaces due follow-ups now (a slot missed while mag was closed, once) and on every tick after. */
export function startRoutineSchedule(routines: Pick<Routines, 'due' | 'dueFollowUps' | 'surfaceFollowUp'>, inbox: Pick<Inbox, 'add'>, run: (id: string) => Promise<unknown>) {
  const tick = () => {
    const t = Date.now()
    followUpTick(routines, inbox, t)
    routineTick(routines, run, t)
  }
  tick()
  setInterval(tick, ROUTINE_TICK_MS).unref()
  return { tickNow: tick }
}
