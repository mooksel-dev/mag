// search_meetings and read_meeting (meetings-local-recording-transcript-and.3): every role in every project reads the
// user's meetings, which are workspace-wide, when the user asks. search_meetings is search_workspace over meetings
// (unified-search-across-the-workspace.1), with the meetings' own filters.
import { parseRef } from './core/lib/search-rows/index.ts'
import { filterMeetings, type MeetingHit, type Meetings, type SearchFilters } from './core/services/meetings/index.ts'
import { MARK_END, MARK_START, type Search } from './core/services/search/index.ts'

/** A page of read_meeting, in characters. */
export const MEETING_PAGE = 40_000

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : undefined)
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Meetings matching `q` within the filters (started between the dates, with any of the people), best first: one hit per meeting. */
export function meetingHits(search: Pick<Search, 'query'>, meetings: Pick<Meetings, 'list'>, q: string, filters: SearchFilters = {}): MeetingHit[] {
  const byId = new Map(filterMeetings(meetings.list(), filters).map((m) => [m.id, m]))
  const hits = search.query(q, { workspaceId: '', scope: 'all', kinds: ['meeting'], sources: [...byId.keys()].map((id) => `mtg:${id}`), limit: filters.limit })
  return hits.flatMap((h) => {
    const ref = parseRef(h.ref)
    const m = ref?.kind === 'mtg' ? byId.get(ref.id) : undefined
    return m && ref?.kind === 'mtg' ? [{ meetingId: m.id, part: ref.at ? ('transcript' as const) : ('summary' as const), at: ref.at ?? null, snippet: h.snippet, title: m.title, startedAt: m.startedAt }] : []
  })
}

/** A meeting as read_meeting shows it: its header, then its summary and transcript (or the part asked). */
export function meetingText(meetings: Pick<Meetings, 'read'>, id: string, part?: 'summary' | 'transcript'): string {
  const { meta, summary, transcript } = meetings.read(id)
  const head = [`Meeting ${meta.id}: ${meta.title}`, `Started ${meta.startedAt}${meta.endedAt ? `, ended ${meta.endedAt}` : ''}`, meta.participants?.length ? `Participants: ${meta.participants.join(', ')}` : '', meta.error ? `Transcript has gaps: ${meta.error}` : ''].filter(Boolean).join('\n')
  const body = [part !== 'transcript' ? `## Summary\n${summary.trim() || '(none yet)'}` : '', part !== 'summary' ? `## Transcript\n${transcript.trim()}` : ''].filter(Boolean).join('\n\n')
  return `${head}\n\n${body}`
}

export function meetingTool(deps: { meetings?: Pick<Meetings, 'list' | 'read'>; search?: Pick<Search, 'query'> }, name: 'search_meetings' | 'read_meeting', args: Record<string, unknown>): string {
  const { meetings, search } = deps
  if (!meetings || !search) throw new Error('Meetings are not ready yet')
  if (name === 'search_meetings') {
    const query = text(args.query)
    if (!query) throw new Error('Pass query: the words to find')
    const hits = meetingHits(search, meetings, query, { from: text(args.from), to: text(args.to), people: strings(args.people), limit: 30 })
    if (!hits.length) return `No meeting line matches "${query}".`
    const lines = hits.map((h) => `- ${h.meetingId} · ${h.title} · ${h.startedAt.slice(0, 16).replace('T', ' ')} UTC · ${h.part}${h.at ? ` [${h.at}]` : ''}: ${h.snippet.replaceAll(MARK_START, '**').replaceAll(MARK_END, '**')}`)
    return `${lines.join('\n')}\n\nRead one with read_meeting(id).`
  }
  const id = text(args.id)
  if (!id) throw new Error('Pass id: a meeting id from search_meetings')
  const part = args.part === 'summary' || args.part === 'transcript' ? args.part : undefined
  const all = meetingText(meetings, id, part)
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0
  const page = all.slice(offset, offset + MEETING_PAGE)
  const next = offset + MEETING_PAGE < all.length ? offset + MEETING_PAGE : null
  return `${page}\n\n${next === null ? '(end of the meeting)' : `(more: call read_meeting with offset ${next})`}`
}
