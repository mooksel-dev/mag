// Tracker import (T-10): a ticket from Jira / Linear becomes a backlog task whose brief the tracker agent writes.
// Read only: nothing here, nor the agent, writes to the tracker.
import { linkedTask, parseTrackerRef, type Project, type Task, type TaskType, type TrackerLink } from '@mag/core'

/** The task storage the service needs (the app's store fits it). */
export interface TrackerStore {
  project(projectId: string): Project
  data: { tasks: Task[] }
  createTask(n: { projectId: string; title: string; type: TaskType; description: string; tracker?: TrackerLink }): Task
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
  }
}
