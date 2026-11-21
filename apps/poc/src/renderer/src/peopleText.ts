import type { PersonView, SyncReport } from '../../main/core/services/people/types.ts'

/** "12 matched · 3 new · 4 unmatched", then each failed directory. */
export function syncReportText(r: SyncReport): string {
  const counts = `${r.matched} matched · ${r.new} new · ${r.unmatched} unmatched`
  return r.errors.length ? `${counts}; ${r.errors.join('; ')}` : counts
}

/** The person's handles as "github:bezpaluy89", Slack first. */
export function handleLabels(p: Pick<PersonView, 'handles'>): string[] {
  const order = ['slack', 'atlassian', 'github', 'meeting']
  return [...p.handles].sort((a, b) => order.indexOf(a.system) - order.indexOf(b.system)).map((h) => `${h.system}:${h.system === 'atlassian' && h.name ? h.name : h.handle}`)
}

/** Persons whose name, email, title or handle has `q`, any case. */
export function filterPeople<T extends Pick<PersonView, 'name' | 'email' | 'title' | 'handles'>>(persons: T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return persons
  return persons.filter((p) => [p.name, p.email ?? '', p.title ?? '', ...p.handles.map((h) => h.handle)].some((s) => s.toLowerCase().includes(needle)))
}
