import { nextWork, planQueue, rollupStatus, subtasksOf } from '@mag/core'
import type { Store } from './store'
import type { Orchestrator } from './orchestrator'
import { prFeedback, prState, removeWorktree } from './git'

const PICK_EVERY_MS = 5_000
const PR_POLL_EVERY_MS = 60_000

/** Runs the plan of every project in order, one unit at a time, and watches open PRs. */
export function startScheduler(store: Store, orch: Orchestrator) {
  const pick = () => {
    for (const project of store.data.projects) {
      const tasks = store.data.tasks.filter((t) => t.projectId === project.id)
      // A task with subtasks is never developed itself; its status follows them.
      for (const task of planQueue(tasks)) {
        const subs = subtasksOf(task.id, tasks)
        const status = subs.length ? rollupStatus(subs) : task.status
        if (status !== task.status) store.updateTask(task.id, { status })
      }
      const next = nextWork(tasks)
      const busy = store.data.sessions.some((s) => s.taskId === next?.id && s.role === 'developer' && orch.isRunning(s.id))
      if (next && !busy) void orch.develop(next.id)
    }
  }

  let polling = false
  const pollPrs = async () => {
    if (polling) return
    polling = true
    try {
      for (const task of store.data.tasks.filter((t) => t.status === 'in_review' && t.work?.prUrl)) {
        const work = task.work!
        const fail = (e: unknown) => {
          const msg = (e as Error).message ?? String(e)
          console.warn(`[mag] PR check failed for ${task.key}:`, msg)
          store.updateTask(task.id, { work: { ...work, checkError: msg.split('\n')[0] } })
        }
        let state: Awaited<ReturnType<typeof prState>>
        try {
          state = await prState(work.prUrl!)
        } catch (e) {
          fail(e)
          continue
        }
        if (state === 'MERGED') {
          store.updateTask(task.id, { status: 'done', needsInput: null, work: { ...work, checkError: null } })
          await removeWorktree(work.repo, work.worktree)
          // Merged code changes the architecture; refresh it if the project keeps one.
          if (store.project(task.projectId).architecture) {
            try {
              orch.architect(task.projectId)
            } catch {}
          }
          continue
        }
        if (state === 'CLOSED') {
          store.updateTask(task.id, { needsInput: 'PR was closed without merging', work: { ...work, checkError: null } })
          continue
        }
        // Feedback problems must not block merge detection above.
        try {
          const fresh = (await prFeedback(work.prUrl!)).filter((f) => f.at > work.feedbackSeenAt)
          const seen = fresh.length ? Math.max(...fresh.map((f) => f.at)) : work.feedbackSeenAt
          if (fresh.length && !orch.feedback(task.id, fresh)) continue
          store.updateTask(task.id, { work: { ...work, feedbackSeenAt: seen, checkError: null } })
        } catch (e) {
          fail(e)
        }
      }
    } finally {
      polling = false
    }
  }

  pick()
  void pollPrs()
  setInterval(pick, PICK_EVERY_MS)
  setInterval(pollPrs, PR_POLL_EVERY_MS)
  return { pollNow: pollPrs }
}
