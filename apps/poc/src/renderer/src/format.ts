/** Time since `ts`, short: 5m, 3h, 2d. */
export const ago = (ts: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - ts) / 60000))
  return m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 60 / 24)}d`
}

/** "PR #12" from a GitHub pull request URL. */
export const prName = (url: string) => `PR #${url.match(/\/pull\/(\d+)/)?.[1] ?? '?'}`
export const prLabel = (url: string) => `${prName(url)} ↗`

/** One-line JSON of a tool input, cut at `max` characters. */
export const inputPreview = (input: unknown, max = 160) => {
  const s = JSON.stringify(input) ?? ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** When a chat thread started, for the thread list: now, 5m, 2h, yesterday, Oct 3. */
export const threadTime = (ts: number, now = Date.now()) => {
  const m = Math.floor((now - ts) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0)
  if (day(ts) === day(now)) return `${Math.floor(m / 60)}h`
  if (day(ts) === day(now - 86400000)) return 'yesterday'
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
