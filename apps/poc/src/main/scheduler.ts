import { rmdir } from 'node:fs'
import { nextWork, prRollup, repoWorkName, type PrState, type RepoWork } from '@mag/core'
import type { Store } from './store'
import type { Orchestrator } from './orchestrator'
import { prFeedback, prState, removeWorktree, type PrFeedback } from './git'

const PICK_EVERY_MS = 5_000
const PR_POLL_EVERY_MS = 60_000

const STATES: Record<Awaited<ReturnType<typeof prState>>, PrState> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/** Runs the plan of every project in order, one task at a time, and watches every PR of the tasks in review. */
export function startScheduler(store: Store, orch: Orchestrator) {
  const pick = () => {
    for (const project of store.data.projects) {
      const tasks = store.data.tasks.filter((t) => t.projectId === project.id)
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
      for (const task of store.data.tasks.filter((t) => t.status === 'in_review' && t.work?.repos.some((r) => r.prUrl))) {
        const work = task.work!
        const repos: RepoWork[] = []
        const feedback: (PrFeedback & { repo: string })[] = []
        for (const r of work.repos) {
          if (!r.prUrl || r.prState === 'merged') {
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
        // The task is already in review, so only merges and closes can change its status here.
        const status = prRollup(next, [])
        if (status === 'done') {
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
        if (status === 'in_progress') {
          const closed = repos.filter((r) => r.prState === 'closed').map((r) => repoWorkName(work, r))
          store.updateTask(task.id, { status: 'in_progress', needsInput: `PR for ${closed.join(', ')} was closed without merging`, work: next })
          continue
        }
        if (!feedback.length) {
          store.updateTask(task.id, { work: next })
          continue
        }
        // Save PR states first: the resumed run reads them. Feedback counts as seen only once the developer has it.
        store.updateTask(task.id, { work: next })
        if (orch.feedback(task.id, feedback)) store.updateTask(task.id, { work: { ...next, feedbackSeenAt: Math.max(...feedback.map((f) => f.at)) } })
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

function checkError(key: string, e: unknown) {
  const msg = (e as Error).message ?? String(e)
  console.warn(`[mag] PR check failed for ${key}:`, msg)
  return msg.split('\n')[0]
}
