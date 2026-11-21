// People (who-is-who-people-from.1): the people service over the store, with the directories the user already has,
// and the People section's calls. Read-only towards every directory.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { createDirectories } from './core/clients/directories/index.ts'
import { createPeople, type OverrideInput, type People, type PeopleSystem } from './core/services/people/index.ts'
import { log } from './log'
import type { Store } from './store'

/** The Slack MCP server the CLI reported: tools mcp__<id>__…; null when there is none. */
export function slackServer(store: Pick<Store, 'data'>): string | null {
  const all = store.data.integrations.filter((i) => /slack/i.test(i.id) || /slack/i.test(i.name))
  return all.find((i) => i.id === 'plugin_slack_slack')?.id ?? all[0]?.id ?? null
}

/** Jira keys of the workspace's label rules. */
export function workspaceJiraKeys(store: Pick<Store, 'data'>, workspaceId: string): string[] {
  const groups = new Set(store.data.labelGroups.filter((g) => g.workspaceId === workspaceId).map((g) => g.id))
  const keys = store.data.labels.filter((l) => groups.has(l.groupId)).flatMap((l) => l.rules.filter((r) => r.kind === 'jiraKey').map((r) => r.value.trim().toUpperCase()))
  return [...new Set(keys)]
}

export function createStorePeople(store: Store, runsDir: string): People {
  const cwd = join(runsDir, 'people')
  mkdirSync(cwd, { recursive: true })
  return createPeople(
    store.data,
    {
      workspace: (id) => store.data.workspaces.find((w) => w.id === id),
      repos: (id) => store.data.workspaces.find((w) => w.id === id)?.repos ?? [],
      jiraKeys: (id) => workspaceJiraKeys(store, id),
    },
    createDirectories({ cwd, slackServer: () => slackServer(store) }),
    () => store.changed(),
  )
}

/** The People section's calls; `people:changed` tells every window to read its list again. */
export function startPeopleIpc(people: People) {
  const changed = () => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('people:changed')
  }
  const handle = (channel: string, fn: (...args: never[]) => unknown) =>
    ipcMain.handle(channel, async (_, ...args) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (e) {
        log.warn('people', `${channel} failed`, e)
        throw e
      }
    })
  handle('people:list', (ws: string) => people.list(ws))
  handle('people:sync', async (ws: string) => {
    const p = people.sync(ws)
    changed()
    try {
      return await p
    } finally {
      changed()
    }
  })
  handle('people:override', (o: OverrideInput) => (people.override(o), changed()))
  handle('people:reject', (ws: string, system: PeopleSystem, handle: string, personId: string) => (people.reject(ws, system, handle, personId), changed()))
  handle('people:notPerson', (ws: string, personId: string) => (people.notPerson(ws, personId), changed()))
  return { changed }
}
