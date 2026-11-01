import type { Change, ChangeSet } from './types.ts'

const MARK: Record<Change['diff'], string> = { add: '+', mod: '~', del: '-', move: '>' }
const NO_MODULE = '(no module)'

const where = (c: Change) => {
  if (c.path && c.line) return `  ${c.path}:${c.line}`
  const h = c.hunks[0]
  return h ? `  ${h.path}:${h.newLines ? h.newStart : h.oldStart}` : ''
}

function elementLine(c: Change): string[] {
  const label = c.name === '(top-level)' ? 'top-level statements' : `${c.decl ?? c.elementKind} ${c.name}${c.exported ? '' : ' (internal)'}`
  if (c.diff === 'mod' && c.part === 'signature') return [`  ~ ${label}${where(c)}`, `      - ${c.before}`, `      + ${c.after}`]
  if (c.diff === 'mod') return [`  ~ ${label}: body${where(c)}`]
  if (c.diff === 'move') return [`  > ${label}: moved from ${c.from}${where(c)}`]
  const sig = c.diff === 'del' ? c.before : c.after
  return [`  ${MARK[c.diff]} ${label}${sig && sig !== c.name && sig !== c.name!.split('.').at(-1) ? `: ${sig}` : ''}${where(c)}`]
}

/** Compact text for agents: changes by module; elements, then dependencies, then files. */
export function formatChangeSet(cs: ChangeSet): string {
  const files = cs.changes.filter((c) => c.kind === 'file')
  const lines = [
    `${cs.repo}: ${cs.baseSha.slice(0, 12)} → ${cs.headSha.slice(0, 12)}, ${files.length} file(s) changed, ${cs.deterministic ? 'deterministic' : `NOT deterministic: no adapter for ${cs.unparsed.join(', ')}; read those files`}.`,
    'Marks: + added, - removed, ~ changed, > moved. (internal) = not exported.',
  ]
  if (!files.length) return lines.join('\n')
  const modules = [...new Set(cs.changes.filter((c) => !c.test).map((c) => c.module ?? NO_MODULE))].sort((a, b) => (a === NO_MODULE ? 1 : b === NO_MODULE ? -1 : a.localeCompare(b)))
  for (const m of modules) {
    const of = cs.changes.filter((c) => !c.test && (c.module ?? NO_MODULE) === m)
    lines.push('', m)
    for (const c of of.filter((c) => c.kind === 'element').sort((a, b) => a.path!.localeCompare(b.path!) || a.name!.localeCompare(b.name!))) lines.push(...elementLine(c))
    for (const c of of.filter((c) => c.kind === 'edge').sort((a, b) => a.name!.localeCompare(b.name!))) lines.push(`  ${MARK[c.diff]} uses ${c.name}${where(c)}`)
    for (const c of of.filter((c) => c.kind === 'file'))
      lines.push(`  file ${MARK[c.diff]} ${c.path}${c.from ? ` (from ${c.from})` : ''}, ${c.hunks.length} hunk(s)`)
  }
  const tests = files.filter((c) => c.test)
  if (tests.length) lines.push('', `tests: ${tests.map((c) => `${MARK[c.diff]} ${c.path}`).join(', ')}`)
  return lines.join('\n')
}
