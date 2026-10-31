// Tracker import (T-10): a ticket from Jira / Linear becomes a backlog task whose brief the tracker agent writes.
// Link (T-36): a task points at a ticket by its URL, no import and no settings needed.
// Read only: nothing here, nor the agent, writes to the tracker.
import { linkedTask, parseTrackerRef, ticketLink, type Project, type Task, type TaskType, type TrackerLink } from '@mag/core'

/** The task storage the service needs (the app's store fits it). */
export interface TrackerStore {
  project(projectId: string): Project
  data: { tasks: Task[] }
  task(taskId: string): Task
  createTask(n: { projectId: string; title: string; type: TaskType; description: string; tracker?: TrackerLink }): Task
  updateTask(taskId: string, patch: Partial<Task>): void
}

/** Starts the tracker agent's import run on a task (the orchestrator). */
export interface ImportRunner {
  startImport(taskId: string): void
}

export interface TrackerService {
  /**
   * Imports the ticket a URL or key names: a new backlog task titled with the ticket key and linked to it, then the
   * tracker agent's import run in the background, which sets the title and brief (set_brief). Returns the task at once.
   * Throws when `ref` matches none of the project's tracker scopes, or the ticket is already linked to a task.
   */
  import(projectId: string, ref: string): Promise<Task>
  /**
   * Runs the import again on a linked task whose import failed or must be redone (e.g. Restart in Home); the brief is
   * replaced when the agent calls set_brief. Throws when the task is not linked to a ticket, or linked without an
   * integration (by a URL outside the tracker scopes).
   */
  retryImport(taskId: string): void
  /**
   * Links a top-level task to the ticket a Jira or Linear URL names, replacing its link if any (Change link); no import,
   * the brief stays. The integration is the matching scope's, if any. Throws when the URL names no ticket, or the
   * ticket is linked to another task.
   */
  link(taskId: string, url: string): Task
  /** Drops the task's ticket link. */
  unlink(taskId: string): Task
}

export function createTrackerService(store: TrackerStore, runner: ImportRunner): TrackerService {
  return {
    async import(projectId, ref) {
      const project = store.project(projectId)
      const scopes = project.trackers ?? []
      const found = parseTrackerRef(ref, scopes)
      if (!found) throw new Error(scopes.length ? 'Unknown tracker link or key' : 'Unknown tracker link or key: add a tracker in Settings → Trackers first')
      const linked = linkedTask(store.data.tasks.filter((t) => t.projectId === projectId), found.key)
      if (linked) throw new Error(`${found.key} is already imported as ${linked.key}`)
      const tracker: TrackerLink = { integrationId: found.scope.integrationId, kind: found.scope.kind, key: found.key, url: found.url, importedAt: null }
      const task = store.createTask({ projectId, title: found.key, type: 'dev', description: '', tracker })
      runner.startImport(task.id)
      return task
    },
    retryImport(taskId) {
      const task = store.task(taskId)
      if (!task.tracker) throw new Error(`${task.key} is not linked to a ticket`)
      if (!task.tracker.integrationId) throw new Error(`${task.key} is linked without an integration: nothing to import through`)
      runner.startImport(taskId)
    },
    link(taskId, url) {
      const task = store.task(taskId)
      if (task.parentId) throw new Error(`${task.key} is a step; link its task instead`)
      const scopes = store.project(task.projectId).trackers ?? []
      const tracker = ticketLink(store.data.tasks.filter((t) => t.projectId === task.projectId), task, url, scopes)
      store.updateTask(taskId, { tracker })
      return store.task(taskId)
    },
    unlink(taskId) {
      store.updateTask(taskId, { tracker: null })
      return store.task(taskId)
    },
  }
}
