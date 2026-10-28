import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Days of daily log files kept; older ones are deleted on start. */
export const KEEP_DAYS = 7
/** Log lines kept in memory for crash reports. */
const TAIL = 100

let dir: string | null = null
let mirror = true
const tail: string[] = []

/** `main-YYYY-MM-DD.log`, one file per (local) day. */
export function logFileName(at: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `main-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.log`
}

/** Deletes daily log files older than `keepDays`; returns the deleted names. */
export function pruneLogs(logsDir: string, now = new Date(), keepDays = KEEP_DAYS) {
  const oldest = logFileName(new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays + 1))
  const old = readdirSync(logsDir).filter((f) => /^main-\d{4}-\d\d-\d\d\.log$/.test(f) && f < oldest)
  for (const f of old) rmSync(join(logsDir, f), { force: true })
  return old
}

/** Starts writing to `logsDir`; until then lines only go to the console. `mirrorToConsole` is for dev. */
export function initLog(logsDir: string, mirrorToConsole: boolean) {
  mkdirSync(logsDir, { recursive: true })
  dir = logsDir
  mirror = mirrorToConsole
}

/** The last log lines (JSON), oldest first. */
export function logTail(): string[] {
  return [...tail]
}

type Level = 'info' | 'warn' | 'error'

function write(level: Level, scope: string, msg: string, data?: unknown) {
  const at = new Date()
  const line = JSON.stringify({ time: at.toISOString(), level, scope, msg, ...(data !== undefined && { data: plain(data) }) })
  tail.push(line)
  if (tail.length > TAIL) tail.shift()
  if (mirror || !dir) console[level === 'info' ? 'log' : level](`[mag:${scope}] ${msg}`, ...(data !== undefined ? [data] : []))
  if (!dir) return
  try {
    // Sync, so the line is on disk even if the process dies right after.
    appendFileSync(join(dir, logFileName(at)), line + '\n')
  } catch {
    // a full disk must not take the app down
  }
}

/** Errors serialize to {} in JSON; keep their message and stack. */
function plain(data: unknown): unknown {
  if (data instanceof Error) return { message: data.message, stack: data.stack }
  if (data && typeof data === 'object' && !Array.isArray(data))
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Error ? plain(v) : v]))
  return data
}

/** JSON-lines logger of the main process: `log.info('agent', 'developer started', { task: 'T-3' })`. */
export const log = {
  info: (scope: string, msg: string, data?: unknown) => write('info', scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => write('warn', scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => write('error', scope, msg, data),
}
