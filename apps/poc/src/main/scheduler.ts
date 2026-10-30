import { rmdir } from 'node:fs'
import { DEFAULT_AUTO_ARCHIVE_DAYS, autoArchiveDue, currentStep, isLegacy, prRollup, repoWorkName, subtasksOf, type AgentSession, type PrState, type RepoWork, type Task, type TaskWork } from '@mag/core'
import type { Store } from './store'
import type { Orchestrator } from './orchestrator'
import { changedRepos, prFeedback, prState, removeWorktree, type PrFeedback } from './git'
import { log } from './log'

const PR_POLL_EVERY_MS = 60_000
const ARCHIVE_EVERY_MS = 60 * 60_000
/** Steps start this long after the change that made them next, so one burst of changes starts each once. */
const ADVANCE_DELAY_MS = 300

const STATES: Record<Awaited<ReturnType<typeof prState>>, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/**
 * Watches the open PRs of the tasks in progress, step by step: a step whose PRs are merged is done and the next one
 * starts (unless it starts manually); the task is done with its last step. Legacy tasks (see isLegacy) are watched as
 * a whole. Archives finished tasks after the project's autoArchiveDays. It never starts a todo task: the user does.
 */
export function startScheduler(store: Store, orch: Orchestrator) {
  const anyRunning = (pred: (s: AgentSession) => boolean) => store.data.sessions.some((s) => pred(s) && orch.isRunning(s.id))

  /**
   * Every PR is merged, but is the step (or legacy task) done? Not while its developer still works, nor while a repo
   * with commits has no merged PR yet (the developer opened the first PR before finishing the others).
   */
  const finished = async (owner: Task, work: TaskWork) => {
    if (anyRunning((s) => (owner.parentId ? s.stepId === owner.id : s.taskId === owner.id))) return false
    const changed = await changedRepos(work, store.project(owner.projectId).baseBranch)
    return changed.every((c) => work.repos.some((r) => r.repo === c && r.prState === 'merged'))
  }

  // A PR closed without merge is not polled again; the developer opens a new one (set_pr) if needed.
  const live = (r: RepoWork) => !!r.prUrl && r.prState !== 'merged' && r.prState !== 'closed'

  /** Polls the live PRs of a step, or of a legacy task (owner = task): merges, closes and new comments. */
  const pollWork = async (owner: Task, task: Task) => {
    const work = owner.work!
    const repos: RepoWork[] = []
    const feedback: (PrFeedback & { repo: string })[] = []
    for (const r of work.repos) {
      if (!r.prUrl || !live(r)) {
        repos.push(r)
        continue
      }
      try {
        const state = STATES[await prState(r.prUrl)]
        // Feedback problems must not block merge detection.
        if (state === 'open') {
          try {
            for (const f of await prFeedback(r.prUrl)) if (f.at > work.feedbackSeenAt) feedback.push({ ...f, repo: repoWorkName(work, r) })
          } catch (e) {
            repos.push({ ...r, prState: state, checkError: checkError(owner.key, e) })
            continue
          }
        }
        repos.push({ ...r, prState: state, checkError: null })
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
    if (!feedback.length) return
    // PR states are saved first: the resumed run reads them. Feedback counts as seen only once the developer has it.
    log.info('scheduler', `${owner.key}: ${feedback.length} new PR comment(s)`)
    if (orch.feedback(owner.id, feedback)) store.updateTask(owner.id, { work: { ...next, feedbackSeenAt: Math.max(...feedback.map((f) => f.at)) } })
  }

  let polling = false
  const pollPrs = async () => {
    if (polling) return
    polling = true
    try {
      for (const task of store.data.tasks.filter((t) => !t.parentId && t.status === 'in_progress')) {
        const owner = isLegacy(task) ? task : currentStep(task.id, store.data.tasks)
        if (owner?.work?.repos.some(live)) await pollWork(owner, task)
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

  const archiveOld = () => {
    const now = Date.now()
    for (const project of store.data.projects) {
      const tasks = store.data.tasks.filter((t) => t.projectId === project.id)
      for (const t of autoArchiveDue(tasks, project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS, now)) {
        log.info('scheduler', `${t.key} archived after ${project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS} days`)
        store.updateTask(t.id, { archivedAt: now })
      }
    }
  }

  void pollPrs()
  advance()
  archiveOld()
  setInterval(pollPrs, PR_POLL_EVERY_MS)
  setInterval(archiveOld, ARCHIVE_EVERY_MS)
  return { pollNow: pollPrs }
}

function checkError(key: string, e: unknown) {
  const msg = (e as Error).message ?? String(e)
  log.warn('scheduler', `PR check failed for ${key}: ${msg}`)
  return msg.split('\n')[0]
}
