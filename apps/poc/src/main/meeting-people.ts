// Meeting participants as persons (who-is-who-people-from.2): each name a meeting says took part is resolved in the
// workspaces of its links (and the one looking), and kept as a meeting handle so People can suggest or match it.
import type { Meetings } from './core/services/meetings/index.ts'
import type { MeetingPerson, People, Resolution } from './core/services/people/index.ts'
import { log } from './log.ts'
import type { Store } from './store'

type Deps = { store: Pick<Store, 'data'>; people: Pick<People, 'identify'>; meetings: Pick<Meetings, 'read' | 'participants'> }

const chip = (name: string, r: Resolution): MeetingPerson => {
  if (r.kind === 'person') return { name, person: { id: r.person.id, name: r.person.name, avatar: r.person.avatar } }
  if (r.kind === 'notPerson') return { name, notPerson: true }
  return r.suggestion ? { name, suggestion: { id: r.suggestion.id, name: r.suggestion.name } } : { name }
}

/** The workspaces a meeting belongs to: those of its linked projects. */
export function meetingWorkspaces(store: Pick<Store, 'data'>, links: { projectId: string }[] | undefined): string[] {
  const ids = (links ?? []).map((l) => store.data.projects.find((p) => p.id === l.projectId)?.workspaceId).filter((w): w is string => !!w)
  return [...new Set(ids)]
}

/** The meeting's participants as `workspaceId` resolves them; each name is kept in that workspace and in the meeting's own. */
export function meetingPeople(d: Deps, id: string, workspaceId: string): MeetingPerson[] {
  const { meta } = d.meetings.read(id)
  const names = d.meetings.participants(id)
  for (const ws of meetingWorkspaces(d.store, meta.links)) if (ws !== workspaceId) for (const n of names) d.people.identify(ws, 'meeting', n)
  return names.map((n) => chip(n, d.people.identify(workspaceId, 'meeting', n)))
}

/** Keeps the participants of every linked meeting as meeting handles of its workspaces, so People shows their suggestions. */
export function noteMeetingPeople(d: Deps & { meetings: Pick<Meetings, 'list'> }): void {
  for (const m of d.meetings.list()) {
    const workspaces = meetingWorkspaces(d.store, m.links)
    if (!workspaces.length) continue
    let names: string[]
    try {
      names = d.meetings.participants(m.id)
    } catch {
      continue
    }
    for (const ws of workspaces) for (const n of names) d.people.identify(ws, 'meeting', n)
  }
}

/** Notes the linked meetings' people now and after each change of meetings (a second after the last); `changed` when People got new handles. */
export function startMeetingPeople(store: Store, people: Pick<People, 'identify'>, meetings: Pick<Meetings, 'list' | 'read' | 'participants'>, changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    timer = null
    const had = store.data.identities.length
    try {
      noteMeetingPeople({ store, people, meetings })
    } catch (e) {
      log.warn('people', 'noting meeting participants failed', e)
    }
    if (store.data.identities.length !== had) changed()
  }
  run()
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, 1000)
  }
}
