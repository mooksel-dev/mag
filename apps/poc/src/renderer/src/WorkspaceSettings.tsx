import { useState } from 'react'
import type { Project, Workspace } from '@mag/core'

const mag = window.mag

/** The projects using each repo of the workspace: such a repo can't be removed. */
function repoUsers(workspace: Pick<Workspace, 'id' | 'repos'>, projects: Pick<Project, 'name' | 'workspaceId' | 'repos'>[]): Record<string, string[]> {
  const mine = projects.filter((p) => p.workspaceId === workspace.id)
  return Object.fromEntries(workspace.repos.map((r) => [r, mine.filter((p) => p.repos.includes(r)).map((p) => p.name)]))
}

const message = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** A workspace's name, the user's profile in it, its notes and repos (workspaces-and-labels-project-as.1). */
export function WorkspaceSettings({ workspace, projects }: { workspace: Workspace; projects: Project[] }) {
  const [error, setError] = useState<string | null>(null)
  const update = (patch: Partial<Omit<Workspace, 'id' | 'createdAt'>>) => {
    setError(null)
    mag.updateWorkspace(workspace.id, patch).catch((e) => setError(message(e)))
  }
  const users = repoUsers(workspace, projects)
  const addRepo = (d: string) => { if (d && !workspace.repos.includes(d)) update({ repos: [...workspace.repos, d] }) }
  return (
    <section className="page">
      <h1>Workspace</h1>
      <span className="muted small">Projects: {projects.filter((p) => p.workspaceId === workspace.id).map((p) => p.name).join(', ') || 'none'}</span>
      <label className="field">Name
        <input key={workspace.name} defaultValue={workspace.name} onBlur={(e) => { if (e.target.value.trim() !== workspace.name) update({ name: e.target.value }) }} />
      </label>
      <label className="field">Profile
        <textarea defaultValue={workspace.profile} rows={4} placeholder="Your role here, what you lead, how you work" onChange={(e) => update({ profile: e.target.value })} />
        <span className="muted small">Who you are in this workspace; agents read it.</span>
      </label>
      <label className="field">Notes for agents
        <textarea defaultValue={workspace.notes} rows={4} onChange={(e) => update({ notes: e.target.value })} />
        <span className="muted small">Knowledge for every project here; a project's notes override it.</span>
      </label>
      <div className="field">
        Repositories
        {workspace.repos.map((r) => (
          <div key={r} className="repo">
            <code>{r}</code>
            {users[r].length ? (
              <span className="muted small">used by {users[r].join(', ')}</span>
            ) : (
              <button className="link" onClick={() => update({ repos: workspace.repos.filter((x) => x !== r) })}>remove</button>
            )}
          </div>
        ))}
        <button onClick={async () => { const d = await mag.pickDir(); if (d) addRepo(d) }}>+ Add repository</button>
        <form onSubmit={(e) => { e.preventDefault(); const input = e.currentTarget.elements.namedItem('workspaceRepo') as HTMLInputElement; addRepo(input.value.trim()); input.value = '' }}>
          <input name="workspaceRepo" placeholder="…or paste an absolute path and press Enter" aria-label="Repository path" style={{ width: '100%' }} />
        </form>
        <span className="muted small">A project's repositories are always here too.</span>
      </div>
      {error && <p className="err small" role="alert">{error}</p>}
    </section>
  )
}
