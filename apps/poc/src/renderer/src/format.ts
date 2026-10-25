/** Time since `ts`, short: 5m, 3h, 2d. */
export const ago = (ts: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - ts) / 60000))
  return m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 60 / 24)}d`
}

/** "PR #12" from a GitHub pull request URL. */
export const prName = (url: string) => `PR #${url.match(/\/pull\/(\d+)/)?.[1] ?? '?'}`
export const prLabel = (url: string) => `${prName(url)} ↗`
