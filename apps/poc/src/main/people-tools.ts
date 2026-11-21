// who and people (who-is-who-people-from.1): every role reads the people of its workspace, read-only.
import { PEOPLE_SYSTEMS, type People, type PeopleSystem, type PersonView } from './core/services/people/index.ts'

/** One line per person: name, email, title, then each handle. */
export function personLine(p: PersonView): string {
  const facts = [p.email, p.title, p.external ? 'external' : ''].filter(Boolean).join(', ')
  const handles = p.handles.map((h) => `${h.system}:${h.handle}`).join(', ')
  return `${p.name} (id ${p.id})${facts ? ` · ${facts}` : ''}${handles ? ` · handles: ${handles}` : ''}`
}

export function peopleTool(people: Pick<People, 'who' | 'find'> | undefined, workspaceId: string, name: 'who' | 'people', args: Record<string, unknown>): string {
  if (!people) throw new Error('People are not ready yet')
  if (name === 'who') {
    const handle = typeof args.handle === 'string' ? args.handle.trim() : ''
    if (!handle) throw new Error('Pass handle: a Slack id, Atlassian accountId, GitHub login, email or name')
    const system = args.system === undefined ? undefined : String(args.system)
    if (system !== undefined && !PEOPLE_SYSTEMS.includes(system as PeopleSystem)) throw new Error(`system is one of ${PEOPLE_SYSTEMS.join(', ')}`)
    const r = people.who(workspaceId, handle, system as PeopleSystem | undefined)
    if (r.kind === 'person') return `${handle} is ${personLine(r.person)} (matched by ${r.source})`
    if (r.kind === 'notPerson') return `${handle} is not a person (a bot, by the user's override).`
    if (r.suggestion) return `${handle} is not matched to anyone. Maybe ${personLine(r.suggestion)}; unconfirmed: the user confirms it in People.`
    return `${handle} is not matched to anyone in this workspace. Try people(q) with a part of the name.`
  }
  const q = typeof args.q === 'string' ? args.q.trim() : ''
  if (!q) throw new Error('Pass q: a part of a name, email, title or handle')
  const found = people.find(workspaceId, q)
  return found.length ? found.map((p) => `- ${personLine(p)}`).join('\n') : `Nobody in this workspace matches "${q}".`
}
