// What the Routines section shows (routines-scheduled-drafts-and-a.1, .2): pure, so it is tested without a window.
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

/** What the form shows under a schedule: its error, or its next `count` runs. */
export function scheduleHint(schedule: string, now = Date.now(), count = 3): { ok: boolean; text: string } {
  const bad = cronError(schedule)
  if (bad) return { ok: false, text: bad }
  const next: number[] = []
  for (let t = now; next.length < count; ) {
    const slot = nextSlot(schedule, t)
    if (slot === null) break
    next.push(slot)
    t = slot
  }
  return next.length ? { ok: true, text: `Next: ${next.map((n) => slotText(n, now)).join(', ')}` } : { ok: false, text: 'This schedule never fires' }
}

/** The schedule picker: every day, weekdays or one day a week at a time, or a cron typed in. */
export type ScheduleMode = 'daily' | 'weekdays' | 'weekly' | 'custom'

export interface SchedulePick {
  mode: ScheduleMode
  /** HH:MM, local time. */
  time: string
  /** 0 Sunday … 6 Saturday (weekly). */
  day: number
  /** The cron of custom. */
  cron: string
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The cron of a pick; custom's as typed. */
export function cronOfPick(p: SchedulePick): string {
  if (p.mode === 'custom') return p.cron.trim()
  const [h, m] = p.time.split(':').map(Number)
  const at = `${m} ${h}`
  return p.mode === 'daily' ? `${at} * * *` : p.mode === 'weekdays' ? `${at} * * 1-5` : `${at} * * ${p.day}`
}

/** The pick a cron reads as: one of the simple ones when it is one, else custom. */
export function pickOfCron(cron: string): SchedulePick {
  const c = cron.trim().replace(/\s+/g, ' ')
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(c)
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return { mode: 'custom', time: '09:00', day: 1, cron: c }
  const time = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`
  if (m[3] === '*') return { mode: 'daily', time, day: 1, cron: c }
  if (m[3] === '1-5') return { mode: 'weekdays', time, day: 1, cron: c }
  return { mode: 'weekly', time, day: Number(m[3]), cron: c }
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

export const RUN_STATUS: Record<RoutineRun['status'], string> = { running: 'Running', done: 'Done', failed: 'Failed' }

/** A routine's runs, newest first. */
export const runsOf = (runs: RoutineRun[], routineId: string) => runs.filter((r) => r.routineId === routineId).sort((a, b) => b.startedAt - a.startedAt)
