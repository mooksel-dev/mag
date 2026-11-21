// who and people (who-is-who-people-from.1), where_works and pr_stats (who-is-who-people-from.2): every role reads the
// people of its workspace and what they work on, read-only.
import { bound } from './core/services/meetings/index.ts'
import { ACTIVITY_DAYS, PEOPLE_SYSTEMS, type People, type PeopleSystem, type PersonView } from './core/services/people/index.ts'

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

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The one person `q` is in the workspace: by who, else by people when exactly one matches; throws with the candidates otherwise. */
export function onePerson(people: Pick<People, 'who' | 'find'>, workspaceId: string, q: string): PersonView {
  const r = people.who(workspaceId, q)
  if (r.kind === 'person') return r.person
  if (r.kind === 'notPerson') throw new Error(`${q} is not a person (a bot, by the user's override)`)
  const found = people.find(workspaceId, q)
  if (found.length === 1) return found[0]
  if (found.length) throw new Error(`${q} is more than one person; pass an id:\n${found.map((p) => `- ${personLine(p)}`).join('\n')}`)
  if (r.suggestion) throw new Error(`${q} is not matched to anyone. Maybe ${personLine(r.suggestion)}; pass its id if so.`)
  throw new Error(`${q} is not anyone in this workspace. Try people(q) with a part of the name.`)
}

export async function activityTool(people: Pick<People, 'who' | 'find' | 'activity' | 'prStats'> | undefined, workspaceId: string, name: 'where_works' | 'pr_stats', args: Record<string, unknown>): Promise<string> {
  if (!people) throw new Error('People are not ready yet')
  const missing = (errors: string[]) => (errors.length ? `\n\nNot counted (a source failed): ${errors.join('; ')}` : '')
  if (name === 'where_works') {
    const q = typeof args.person === 'string' ? args.person.trim() : ''
    if (!q) throw new Error('Pass person: a person id, handle, email or name')
    const days = args.days === undefined ? ACTIVITY_DAYS : Number(args.days)
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days is a whole number from 1 to 365')
    const p = onePerson(people, workspaceId, q)
    const w = await people.activity(p.id, days)
    const head = `Where ${p.name} (id ${p.id}) works, by activity of the last ${days} days (since ${day(w.from)}):`
    const lines = w.projects.map((a) => `- ${a.label} (label ${a.labelId}): ${plural(a.prs, 'PR')}, ${plural(a.reviews, 'review')}, ${plural(a.tickets, 'ticket')}, ${plural(a.meetings, 'meeting')}`)
    return `${head}\n${lines.length ? lines.join('\n') : '- no activity in any Project label'}${missing(w.errors)}`
  }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const fromArg = text(args.from)
  const toArg = text(args.to)
  if (!fromArg || !toArg) throw new Error('Pass from and to: dates (YYYY-MM-DD, whole local days) or ISO times')
  const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string' && !!l.trim()) : typeof args.labels === 'string' ? [args.labels] : undefined
  const s = await people.prStats(workspaceId, bound(fromArg, false), bound(toArg, true), labels)
  if (!s.rows.length) return `No PRs or reviews from ${fromArg} to ${toArg}${labels?.length ? ` in ${labels.join(', ')}` : ''}.${missing(s.errors)}`
  const rows = s.rows.map((r) => `| ${r.label} | ${r.name}${r.personId ? ` (id ${r.personId})` : ' (no person)'} | ${r.logins.join(', ')} | ${r.prs} | ${r.merged} | ${r.reviews} |`)
  return `PRs and reviews from ${fromArg} to ${toArg}, by person and Project label (a person's logins folded; reviews: others' PRs, each once):\n\n| Label | Person | Logins | PRs opened | Merged | Reviews |\n|---|---|---|---|---|---|\n${rows.join('\n')}${missing(s.errors)}`
}
