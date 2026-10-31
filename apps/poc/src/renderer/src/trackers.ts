// Settings → Trackers (T-10): what keeps a tracker scope from being imported through.
import { integrationMode, resolveChoice, type Integration, type Project, type TrackerScope } from '@mag/core'

/** Why the tracker agent cannot read this scope's tickets yet, or null when it can. */
export function scopeWarning(project: Project, scope: TrackerScope, integrations: Integration[]): string | null {
  if (resolveChoice(project, 'tracker').agent !== 'claude-code') return 'The Tracker agent must be Claude Code: only it uses integrations'
  if (!integrations.some((i) => i.id === scope.integrationId)) return 'Integration not detected: run any Claude Code agent'
  if (integrationMode(project, 'tracker', scope.integrationId) === 'off') return 'Turn this integration on for Tracker in Integrations (Ask or Auto)'
  return null
}

/** A scope as typed: trimmed, upper case (ticket keys are). Null when empty or not a key prefix. */
export function scopeKey(text: string): string | null {
  const s = text.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]*$/.test(s) ? s : null
}
