import { rmdir } from 'node:fs'
import { DEFAULT_AUTO_ARCHIVE_DAYS, autoArchiveDue, nextWork, prRollup, repoWorkName, type PrState, type RepoWork, type TaskWork } from '@mag/core'
import type { Store } from './store'
import type { Orchestrator } from './orchestrator'
import { changedRepos, prFeedback, prState, removeWorktree, type PrFeedback } from './git'
import { log } from './log'

const PICK_EVERY_MS = 5_000
const PR_POLL_EVERY_MS = 60_000
const ARCHIVE_EVERY_MS = 60 * 60_000

const STATES: Record<Awaited<ReturnType<typeof prState>>, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/**
 * Runs the todo queue of every project in order, one task at a time, watches the open PRs of the tasks in progress
 * and archives finished tasks after the project's autoArchiveDays.
 */
export function startScheduler(store: Store, orch: Orchestrator) {
  const pick = () => {
    for (const project of store.data.projects) {
      const tasks = store.data.tasks.filter((t) => t.projectId === project.id)
      const next = nextWork(tasks)
      const busy = store.data.sessions.some((s) => s.taskId === next?.id && s.role === 'developer' && orch.isRunning(s.id))
      if (next && !busy) {
        log.info('scheduler', `developing ${next.key}`, { project: project.name })
        orch.develop(next.id).catch((e) => log.error('scheduler', `develop ${next.key} failed`, e))
      }
    }
  }

  /**
   * Every PR is merged, but is the task done? Not while its developer still works, nor while a repo with commits has
   * no merged PR yet (the developer opened the first PR before finishing the others).
   */
  const finished = async (taskId: string, work: TaskWork) => {
    if (store.data.sessions.some((s) => s.taskId === taskId && orch.isRunning(s.id))) return false
    const changed = await changedRepos(work, store.project(store.task(taskId).projectId).baseBranch)
    return changed.every((c) => work.repos.some((r) => r.repo === c && r.prState === 'merged'))
  }

  let polling = false
  const pollPrs = async () => {
    if (polling) return
    polling = true
    try {
      // A PR closed without merge is not polled again; the developer opens a new one (set_pr) if needed.
      const live = (r: RepoWork) => !!r.prUrl && r.prState !== 'merged' && r.prState !== 'closed'
      for (const task of store.data.tasks.filter((t) => t.status === 'in_progress' && t.work?.repos.some(live))) {
        const work = task.work!
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
                repos.push({ ...r, prState: state, checkError: checkError(task.key, e) })
                continue
              }
            }
            repos.push({ ...r, prState: state, checkError: null })
          } catch (e) {
            repos.push({ ...r, checkError: checkError(task.key, e) })
          }
        }
        const next = { ...work, repos }
        // Only merges and closes matter here; whether every changed repo has a PR is set_pr's business.
        const closed = repos.filter((r, i) => r.prState === 'closed' && work.repos[i].prState !== 'closed').map((r) => repoWorkName(work, r))
        if (closed.length) {
          log.info('scheduler', `${task.key}: PR closed for ${closed.join(', ')}`)
          store.updateTask(task.id, { needsInput: `PR for ${closed.join(', ')} was closed without merging`, work: next })
          continue
        }
        if (prRollup(next, []) === 'done' && (await finished(task.id, next))) {
          log.info('scheduler', `${task.key} done: every PR merged`)
          store.updateTask(task.id, { status: 'done', needsInput: null, work: next })
          for (const r of repos) await removeWorktree(r.repo, r.worktree)
          // Only removes the task dir once it is empty.
          rmdir(work.dir, () => {})
          // Merged code changes the architecture; refresh it if the project keeps one.
          if (store.project(task.projectId).architecture) {
            try {
              orch.architect(task.projectId)
            } catch {}
          }
          continue
        }
        if (!feedback.length) {
          store.updateTask(task.id, { work: next })
          continue
        }
        // Save PR states first: the resumed run reads them. Feedback counts as seen only once the developer has it.
        store.updateTask(task.id, { work: next })
        log.info('scheduler', `${task.key}: ${feedback.length} new PR comment(s)`)
        if (orch.feedback(task.id, feedback)) store.updateTask(task.id, { work: { ...next, feedbackSeenAt: Math.max(...feedback.map((f) => f.at)) } })
      }
    } finally {
      polling = false
    }
  }

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

  pick()
  void pollPrs()
  archiveOld()
  setInterval(pick, PICK_EVERY_MS)
  setInterval(pollPrs, PR_POLL_EVERY_MS)
  setInterval(archiveOld, ARCHIVE_EVERY_MS)
  return { pollNow: pollPrs }
}

function checkError(key: string, e: unknown) {
  const msg = (e as Error).message ?? String(e)
  log.warn('scheduler', `PR check failed for ${key}: ${msg}`)
  return msg.split('\n')[0]
}
