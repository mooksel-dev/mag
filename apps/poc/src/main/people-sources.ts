// What the people service counts activity from (who-is-who-people-from.2): the workspace's Project labels with their
// repos and Jira keys, and its linked meetings with who took part.
import { projectLabel } from '@mag/core'
import type { Meetings } from './core/services/meetings/index.ts'
import type { MeetingFacts, ProjectScope } from './core/services/people/index.ts'
import type { Store } from './store'

const folder = (path: string) => path.replace(/\/+$/, '').split('/').at(-1)?.toLowerCase() ?? path

/** The workspace's Project labels: each project's repos and the workspace repos its repo rules match, its Jira keys. */
export function projectScopes(store: Pick<Store, 'data'>, workspaceId: string): ProjectScope[] {
  const ws = store.data.workspaces.find((w) => w.id === workspaceId)
  return store.data.projects
    .filter((p) => p.workspaceId === workspaceId)
    .map((p) => {
      const rules = projectLabel(p, store.data.labels).rules
      const repoRules = rules.filter((r) => r.kind === 'repo').map((r) => r.value.trim())
      const matched = (ws?.repos ?? []).filter((repo) => repoRules.some((v) => v.toLowerCase() === repo.toLowerCase() || folder(v) === folder(repo)))
      const jiraKeys = [...new Set(rules.filter((r) => r.kind === 'jiraKey').map((r) => r.value.trim().toUpperCase().replace(/-\d*$/, '')))]
      return { id: p.id, name: p.name, repos: [...new Set([...p.repos, ...matched])], jiraKeys }
    })
}

/** Meetings started in [from, to] that are linked to a project of the workspace, with who took part. */
export function meetingFacts(store: Pick<Store, 'data'>, meetings: Pick<Meetings, 'list' | 'participants'> | undefined, workspaceId: string, from: number, to: number): MeetingFacts[] {
  if (!meetings) return []
  const projects = new Set(store.data.projects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id))
  return meetings.list().flatMap((m) => {
    const startedAt = Date.parse(m.startedAt)
    const projectIds = [...new Set((m.links ?? []).map((l) => l.projectId).filter((id) => projects.has(id)))]
    if (!(startedAt >= from && startedAt <= to) || !projectIds.length) return []
    try {
      return [{ id: m.id, startedAt, projectIds, names: meetings.participants(m.id) }]
    } catch {
      return []
    }
  })
}
