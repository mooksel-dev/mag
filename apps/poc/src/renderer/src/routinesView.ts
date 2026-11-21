// What the Routines section shows (routines-scheduled-drafts-and-a.1): pure, so it is tested without a window.
import { cronError, nextSlot } from '../../main/core/lib/cron/index.ts'
import type { Routine, RoutineRun } from '../../main/core/services/routines/types.ts'

const pad = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Thu 19 Nov 09:00", local time; the year when it is not this one. */
export function slotText(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${DAYS[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** What the form shows under a schedule: its error, or when it runs next. */
export function scheduleHint(schedule: string, now = Date.now()): { ok: boolean; text: string } {
  const bad = cronError(schedule)
  if (bad) return { ok: false, text: bad }
  const next = nextSlot(schedule, now)
  return next === null ? { ok: false, text: 'This schedule never fires' } : { ok: true, text: `Next: ${slotText(next, now)}` }
}

/** The routine's line under its title: off, or its next slot. */
export function routineNext(r: Pick<Routine, 'enabled' | 'nextAt'>, now = Date.now()): string {
  if (!r.enabled) return 'Off'
  return r.nextAt === null ? 'Never fires' : `Next ${slotText(r.nextAt, now)}`
}

/** "42 s", "3 min", "1 h 5 min"; a run going on counts to now. */
export function runDuration(run: Pick<RoutineRun, 'startedAt' | 'endedAt'>, now = Date.now()): string {
  const s = Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

export const RUN_STATUS: Record<RoutineRun['status'], string> = { running: 'Running', drafted: 'Drafted', failed: 'Failed' }

/** A routine's runs, newest first. */
export const runsOf = (runs: RoutineRun[], routineId: string) => runs.filter((r) => r.routineId === routineId).sort((a, b) => b.startedAt - a.startedAt)

/** Sources as the form edits them: one per line. */
export const sourcesText = (sources: string[]) => sources.join('\n')
export const sourcesOf = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
