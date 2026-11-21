// Cron strings for routines (routines-scheduled-drafts-and-a.1): 5 fields (minute hour day-of-month month day-of-week),
// in local time. Each field takes *, numbers, ranges a-b, steps */n or a-b/n, lists a,b; months and weekdays also take
// names (jan, mon). Day-of-month and day-of-week both restricted: either matches, as in cron.

export interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Day-of-month and day-of-week were both restricted (not *). */
  either: boolean
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface Field {
  name: string
  min: number
  max: number
  /** Names of the values from `base` on. */
  names?: readonly string[]
  base?: number
}

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, base: 0 },
]

function field(text: string, f: Field): Set<number> {
  const out = new Set<number>()
  const num = (s: string) => {
    const lower = s.toLowerCase()
    const named = f.names?.indexOf(lower) ?? -1
    if (named >= 0) return named + (f.base ?? 0)
    if (!/^\d+$/.test(s)) throw new Error(`${f.name}: "${s}" is not a number`)
    const n = Number(s)
    if (n < f.min || n > f.max) throw new Error(`${f.name}: ${n} is outside ${f.min}-${f.max}`)
    return n
  }
  for (const part of text.split(',')) {
    const [range, stepText, extra] = part.split('/')
    if (extra !== undefined || !range) throw new Error(`${f.name}: "${part}" is not a value, range or step`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`${f.name}: step "${stepText}" must be a whole number of 1 or more`)
    let lo: number
    let hi: number
    if (range === '*') [lo, hi] = [f.min, f.max]
    else if (range.includes('-')) {
      const [a, b, more] = range.split('-')
      if (more !== undefined) throw new Error(`${f.name}: "${range}" is not a range`)
      ;[lo, hi] = [num(a), num(b)]
      if (lo > hi) throw new Error(`${f.name}: range ${range} goes backwards`)
    } else {
      lo = num(range)
      // "5/15": from 5 to the end, as cron reads it.
      hi = stepText === undefined ? lo : f.max
    }
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return out
}

/** Parses a cron string; throws with what is wrong. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) throw new Error(`A schedule has 5 fields (minute hour day month weekday), e.g. "0 9 * * thu"; got ${parts.length}`)
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, FIELDS[i]))
  // 7 is Sunday too.
  if (weekdays.delete(7)) weekdays.add(0)
  return { minutes, hours, days, months, weekdays, either: parts[2] !== '*' && parts[4] !== '*' }
}

/** Whether `expr` is a valid cron string: null when it is, else what is wrong. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

const dayMatches = (c: Cron, d: Date) => {
  const dom = c.days.has(d.getDate())
  const dow = c.weekdays.has(d.getDay())
  return c.either ? dom || dow : dom && dow
}

/** Years searched for the next slot: a schedule like "0 0 31 2 *" never fires. */
const HORIZON_YEARS = 5

/** The first slot (ms, local time, whole minute) strictly after `after`; null when there is none within 5 years. */
export function nextSlot(expr: string | Cron, after: number): number | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const end = new Date(after).getFullYear() + HORIZON_YEARS
  while (d.getFullYear() <= end) {
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
    } else if (!c.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
    } else if (!c.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
    } else return d.getTime()
  }
  return null
}
