import type { Bounds } from './bounds'

/**
 * What a main window shows (slack-like-shell-rail-resizable.2): a workspace, its column filtered to one project when
 * `projectId` is set (a project window).
 */
export interface WindowView {
  workspaceId: string
  projectId: string | null
}

/** A workspace window that was open, to reopen on start. */
export interface WorkspaceWindow extends WindowView {
  bounds: Bounds
}

/** A project window saved before workspace windows. */
export interface LegacyProjectWindow {
  projectId: string
  bounds: Bounds
}

interface Place {
  workspaces: { id: string }[]
  projects: { id: string; workspaceId: string }[]
}

/** Old project windows as workspace windows filtered to their project; a deleted project's is dropped. */
export function fromProjectWindows(old: LegacyProjectWindow[], projects: Place['projects']): WorkspaceWindow[] {
  return old.flatMap((w) => {
    const p = projects.find((x) => x.id === w.projectId)
    return p ? [{ workspaceId: p.workspaceId, projectId: p.id, bounds: w.bounds }] : []
  })
}

/**
 * The view a saved window reopens as, null when there is nothing left to show: a filtered window follows its project
 * to the workspace it is in now; its project deleted, it shows its workspace whole.
 */
export function resolveView(view: WindowView, place: Place): WindowView | null {
  const p = view.projectId ? place.projects.find((x) => x.id === view.projectId) : undefined
  if (p) return { workspaceId: p.workspaceId, projectId: p.id }
  return place.workspaces.some((w) => w.id === view.workspaceId) ? { workspaceId: view.workspaceId, projectId: null } : null
}

/** The URL hash a main window loads with; the preload reads it back. */
export function viewHash(view: WindowView): string {
  return new URLSearchParams({ workspace: view.workspaceId, ...(view.projectId && { project: view.projectId }) }).toString()
}

/** Whether a window with `view` shows project `p` (of workspace `wid`): filtered to it, or its workspace whole. */
export const viewShows = (view: WindowView, p: { id: string; workspaceId: string }): boolean =>
  view.projectId ? view.projectId === p.id : view.workspaceId === p.workspaceId
