import type { FileChange } from './types.ts'

const MARK: Record<FileChange['status'], string> = { add: '+', mod: '~', del: '-', rename: '>' }
const NO_MODULE = '(no module)'

const range = (start: number, lines: number) => (lines === 1 ? `${start}` : lines ? `${start}-${start + lines - 1}` : `${start} (none)`)

/**
 * Compact text for agents (get_pr_changes, T-58): the changed files of a repo by owner module, with their hunks (their
 * ids when numbered); files that are not code (tests, styles, lock files, generated, docs) listed apart, as nothing a
 * fact's inventory has to cite.
 */
export function formatFiles(repo: string, baseSha: string, headSha: string, files: FileChange[]): string {
  const code = files.filter((f) => f.kind === 'code')
  const lines = [
    `${repo}: ${baseSha.slice(0, 12)} → ${headSha.slice(0, 12)}, ${files.length} file(s) changed, ${code.length} of them code.`,
    'Marks: + added, - removed, ~ changed, > renamed. Hunks: id, old lines → new lines.',
  ]
  const modules = [...new Set(code.map((f) => f.module ?? NO_MODULE))].sort((a, b) => (a === NO_MODULE ? 1 : b === NO_MODULE ? -1 : a.localeCompare(b)))
  for (const m of modules) {
    lines.push('', m)
    for (const f of code.filter((f) => (f.module ?? NO_MODULE) === m)) {
      const hunks = f.hunks.map((h) => `${h.id ? `${h.id} ` : ''}${range(h.oldStart, h.oldLines)} → ${range(h.newStart, h.newLines)}`)
      lines.push(`  ${MARK[f.status]} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}: ${f.hunks.length} hunk(s)${hunks.length ? ` ${hunks.slice(0, 8).join(', ')}${hunks.length > 8 ? ', …' : ''}` : ''}`)
    }
  }
  const rest = files.filter((f) => f.kind !== 'code')
  if (rest.length) lines.push('', `not code: ${rest.map((f) => `${MARK[f.status]} ${f.path} (${f.kind})`).join(', ')}`)
  return lines.join('\n')
}

/**
 * The hunks of code files with their ids and lines, as an inventory cites them (diff-iak-inventar-zmin-ai.1): a header per
 * hunk (id, repo:path, owner module, git's header), each block of changed lines marked [<id>.<k>] on the line before it,
 * context lines as git gives them. Files that are not code are named, without lines: they need not be cited.
 */
export function formatHunks(files: FileChange[]): string {
  const out: string[] = []
  for (const f of files.filter((x) => x.kind === 'code'))
    for (const h of f.hunks) {
      if (!h.id) continue
      out.push(`### ${h.id}  ${f.repo}:${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}  [module: ${f.module ?? NO_MODULE}]  @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header ? ` ${h.header}` : ''}`)
      let k = 0
      let changed = false
      for (const l of h.lines ?? []) {
        const c = l[0] === '+' || l[0] === '-'
        if (c && !changed) out.push(`[${h.id}.${++k}]`)
        changed = c
        out.push(l)
      }
    }
  const rest = files.filter((x) => x.kind !== 'code' && x.hunks.length)
  if (rest.length) out.push('', `Not code, need not be cited: ${rest.map((x) => `${x.repo}:${x.path} (${x.kind}: ${x.hunks.map((h) => h.id).filter(Boolean).join(', ')})`).join('; ')}`)
  return out.join('\n')
}
