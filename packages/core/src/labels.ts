// Labels as every layer reads them (workspaces-and-labels-project-as.2); the labels service keeps and changes them.
import { projectColor, type ItemLabel, type ItemRef, type Label, type LabelGroup, type Project, type Workspace } from './index.ts'

/** The id of a workspace's Project group. */
export const projectGroupId = (workspaceId: string) => `${workspaceId}:project`

/** A project as its Project label: its id, name and color, the rules stored for it. */
export function projectLabel(p: Project, labels: Label[]): Label {
  const groupId = projectGroupId(p.workspaceId)
  return { id: p.id, groupId, name: p.name, color: projectColor(p), rules: labels.find((l) => l.id === p.id && l.groupId === groupId)?.rules ?? [] }
}

/** A workspace as the project of its topics without one: id '', its notes, repos and settings, nothing of its own. */
export function workspaceAsProject(w: Workspace): Project {
  return { id: '', name: 'No project', workspaceId: w.id, repos: w.repos, notes: w.notes, playbook: w.playbook, enforceArchitecture: false, architecture: null, archRun: null, agents: w.agents, integrations: w.integrations, sidebar: [], createdAt: w.createdAt }
}

/** A group with its labels; the Project group's are its workspace's projects. */
export interface LabelGroupView {
  group: LabelGroup
  labels: Label[]
}

/** A workspace's groups with their labels, Project first. */
export function workspaceLabels(workspaceId: string, data: { labelGroups: LabelGroup[]; labels: Label[]; projects: Project[] }): LabelGroupView[] {
  const groups = data.labelGroups.filter((g) => g.workspaceId === workspaceId)
  return [...groups.filter((g) => g.system), ...groups.filter((g) => !g.system)].map((group) => ({
    group,
    labels: group.system === 'project' ? data.projects.filter((p) => p.workspaceId === workspaceId).map((p) => projectLabel(p, data.labels)) : data.labels.filter((l) => l.groupId === group.id),
  }))
}

/** The ids of an item's labels: its project's (when it has one), then its item labels'. */
export function itemLabelIds(ref: ItemRef, projectId: string | null, itemLabels: ItemLabel[]): string[] {
  return [...(projectId ? [projectId] : []), ...itemLabels.filter((r) => r.itemRef === ref && !r.removed).map((r) => r.labelId)]
}
