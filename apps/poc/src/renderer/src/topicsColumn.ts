/**
 * What the topics column lists (slack-like-shell-rail-resizable.1): a workspace's rows, one section per Project label
 * (its project) in the workspace's order, then its topics without a project; Starred on top takes the starred open rows
 * out of their sections.
 */
import { cardFilter, cardRef, countedCards, workCards, type ItemRef, type Project, type SessionLike, type Task, type WorkCard } from '@mag/core'

export interface ProjectCards {
  project: Project
  cards: WorkCard[]
}

export interface ColumnCards {
  projects: ProjectCards[]
  /** The workspace's topics without a project. */
  loose: WorkCard[]
}

/** The rows of workspace `workspaceId`: per project of it (the order of `projects`), then those without a project. */
export function columnCards(workspaceId: string, projects: Project[], tasks: Task[], sessions: SessionLike[], now: number): ColumnCards {
  return {
    projects: projects.filter((p) => p.workspaceId === workspaceId).map((project) => ({
      project,
      cards: workCards(project.id, tasks.filter((t) => t.projectId === project.id), sessions, now),
    })),
    loose: workCards(null, [], sessions.filter((s) => s.projectId === null && s.workspaceId === workspaceId), now),
  }
}

/** The column of a window filtered to project `projectId` (null: not filtered): its section only, no loose topics. */
export function onlyProject(c: ColumnCards, projectId: string | null): ColumnCards {
  return projectId ? { projects: c.projects.filter((p) => p.project.id === projectId), loose: [] } : c
}

/** Every row of the column, sections in order. */
export const allCards = (c: ColumnCards): WorkCard[] => [...c.projects.flatMap((p) => p.cards), ...c.loose]

/** The open rows starred, in the order starred; a starred row gone or closed is not listed. */
export function starredCards(c: ColumnCards, starred: readonly string[] | undefined): WorkCard[] {
  const open = new Map(allCards(c).filter((x) => !x.closed).map((x) => [cardRef(x), x]))
  return (starred ?? []).flatMap((ref) => open.get(ref) ?? [])
}

/** What waits on the user among `cards`, a topic's works counted each: a section's count, the rail's badge. */
export const waitingCount = (cards: WorkCard[]): number => cardFilter(countedCards(cards), 'waiting').length

/** Starred with `ref` added at the end, or taken out when it is there. */
export function toggleStar(starred: readonly ItemRef[] | undefined, ref: ItemRef): ItemRef[] {
  const list = starred ?? []
  return list.includes(ref) ? list.filter((r) => r !== ref) : [...list, ref]
}
