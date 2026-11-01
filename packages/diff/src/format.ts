import type { FileChange } from './types.ts'

const MARK: Record<FileChange['status'], string> = { add: '+', mod: '~', del: '-', rename: '>' }
const NO_MODULE = '(no module)'

const range = (start: number, lines: number) => (lines === 1 ? `${start}` : lines ? `${start}-${start + lines - 1}` : `${start} (none)`)

/**
 * Compact text for agents (get_pr_changes, T-58): the changed files of a repo by owner module, with their hunks; files
 * that are not code (tests, styles, lock files, generated, docs) listed apart, as nothing a fact diagram has to show.
 */
export function formatFiles(repo: string, baseSha: string, headSha: string, files: FileChange[]): string {
  const code = files.filter((f) => f.kind === 'code')
  const lines = [
    `${repo}: ${baseSha.slice(0, 12)} → ${headSha.slice(0, 12)}, ${files.length} file(s) changed, ${code.length} of them code.`,
    'Marks: + added, - removed, ~ changed, > renamed. Hunks: old lines → new lines; read them with git diff.',
  ]
  const modules = [...new Set(code.map((f) => f.module ?? NO_MODULE))].sort((a, b) => (a === NO_MODULE ? 1 : b === NO_MODULE ? -1 : a.localeCompare(b)))
  for (const m of modules) {
    lines.push('', m)
    for (const f of code.filter((f) => (f.module ?? NO_MODULE) === m)) {
      const hunks = f.hunks.map((h) => `${range(h.oldStart, h.oldLines)} → ${range(h.newStart, h.newLines)}`)
      lines.push(`  ${MARK[f.status]} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}: ${f.hunks.length} hunk(s)${hunks.length ? ` ${hunks.slice(0, 8).join(', ')}${hunks.length > 8 ? ', …' : ''}` : ''}`)
    }
  }
  const rest = files.filter((f) => f.kind !== 'code')
  if (rest.length) lines.push('', `not code: ${rest.map((f) => `${MARK[f.status]} ${f.path} (${f.kind})`).join(', ')}`)
  return lines.join('\n')
}
