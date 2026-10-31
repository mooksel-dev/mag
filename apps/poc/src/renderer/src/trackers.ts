// Settings → Trackers (T-10, T-37): what a scope is typed as.

/** A scope as typed: trimmed, upper case (ticket keys are). Null when empty or not a key prefix. */
export function scopeKey(text: string): string | null {
  const s = text.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]*$/.test(s) ? s : null
}
