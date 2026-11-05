// What the big composer will do with its input (redesign-start-screen-big-composer.1): the routing that lived inline in
// the work list's New work field, as one pure function. The chip next to send and the submit both read it.

/** import: a review's .zip; review: a GitHub PR; ticket: any other link; ask: words open a discussion; none: nothing to send. */
export type ComposerRoute =
  | { kind: 'import'; file: string; label: string }
  | { kind: 'review'; url: string; label: string }
  | { kind: 'ticket'; url: string; label: string }
  | { kind: 'ask'; text: string; label: string }
  | { kind: 'none'; label: string }

const PR_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/
const URL_RE = /^https?:\/\/\S+$/

/**
 * The route of the composer's text and the names (or paths) of files dropped on it: a .zip imports a review before any
 * text; then a text starting with a GitHub PR link reviews it, a text that is one other link starts a work from that
 * ticket, and any other words open a discussion. The url is the whole trimmed text, as the old field sent it.
 */
export function composerRoute(text: string, files: string[] = []): ComposerRoute {
  const zip = files.find((f) => f.toLowerCase().endsWith('.zip'))
  if (zip) return { kind: 'import', file: zip, label: 'Import review' }
  const t = text.trim()
  if (!t) return { kind: 'none', label: '' }
  if (PR_RE.test(t)) return { kind: 'review', url: t, label: 'Review PR' }
  if (URL_RE.test(t)) return { kind: 'ticket', url: t, label: 'From ticket' }
  return { kind: 'ask', text: t, label: 'Ask · opens a discussion' }
}
