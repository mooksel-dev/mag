import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CrashReport } from '../preload/api'

/** Crash reports in `<logs>/crashes`: one JSON file per crash, native minidumps under `native/`. */
export class Crashes {
  readonly nativeDir: string
  private dismissedFile: string

  constructor(
    readonly dir: string,
    private appVersion: string,
    /** Last log lines, attached to every report. */
    private logTail: () => string[],
    /** Crashes before this time count as the previous run's. */
    private startedAt = Date.now(),
  ) {
    this.nativeDir = join(dir, 'native')
    this.dismissedFile = join(dir, '.dismissed')
    mkdirSync(this.nativeDir, { recursive: true })
  }

  /** Writes the report with the app version and the last log lines; returns its path. */
  write(crash: Pick<CrashReport, 'kind' | 'message'> & Partial<CrashReport>, now = Date.now()) {
    const report: CrashReport = { time: now, appVersion: this.appVersion, log: this.logTail(), ...crash }
    const stamp = new Date(report.time).toISOString().replace(/[:.]/g, '-')
    const path = join(this.dir, `${stamp}-${report.kind}-${Math.random().toString(36).slice(2, 6)}.json`)
    writeFileSync(path, JSON.stringify(report, null, 2))
    return path
  }

  /** The newest crash of an earlier run that the user has not dismissed: a report file or a native minidump. */
  last(): CrashReport | null {
    const after = this.dismissedAt()
    const fresh = (t: number) => t > after && t < this.startedAt
    let best: CrashReport | null = null
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const r = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as CrashReport
        if (fresh(r.time) && (!best || r.time > best.time)) best = r
      } catch {
        // a half-written report from a dying process
      }
    }
    for (const { path, time } of minidumps(this.nativeDir)) {
      if (fresh(time) && (!best || time > best.time))
        best = { kind: 'native', message: `mag crashed natively; minidump: ${path}`, time, appVersion: this.appVersion, log: [] }
    }
    return best
  }

  /** Hides every crash so far from the Home inbox. */
  dismiss(now = Date.now()) {
    writeFileSync(this.dismissedFile, String(now))
  }

  private dismissedAt() {
    try {
      return Number(readFileSync(this.dismissedFile, 'utf8')) || 0
    } catch {
      return 0
    }
  }
}

/** Crashpad keeps dumps in nested folders (completed/, pending/). */
function minidumps(dir: string): { path: string; time: number }[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.dmp'))
      .map((f) => ({ path: join(dir, f), time: statSync(join(dir, f)).mtimeMs }))
  } catch {
    return []
  }
}
