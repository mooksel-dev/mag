import type { Project, RepoWork, Task } from '@mag/core'

/** A repository's base branch: its own (RepoWork.base), else the project's, for works from before it was recorded. */
export const baseOf = (project: Project, r: RepoWork) => r.base ?? project.baseBranch

/** Every base branch of the project and of its works' repositories, once each: what no agent pushes to. */
export const projectBases = (project: Project, tasks: Task[]) => [
  ...new Set([project.baseBranch, ...tasks.filter((t) => t.projectId === project.id).flatMap((t) => (t.work?.repos ?? []).map((r) => baseOf(project, r)))]),
]

/** Shell words of a command, split into its simple commands (`&&`, `||`, `;`, `|`, `&`, newline); quotes kept together. */
function commands(line: string): string[][] {
  const out: string[][] = [[]]
  let word: string | null = null
  let quote: '"' | "'" | null = null
  const end = () => {
    if (word !== null) out.at(-1)!.push(word)
    word = null
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]!
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      word ??= ''
    } else if (c === '\\' && i + 1 < line.length) word = (word ?? '') + line[++i]!
    else if (/\s/.test(c) && c !== '\n') end()
    else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      end()
      out.push([])
    } else word = (word ?? '') + c
  }
  end()
  return out.filter((c) => c.length)
}

/** git options before the subcommand that take the next word as their value. */
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
/** `git push` options that take the next word as their value. */
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const SAYS_NO_BRANCH = (cmd: string) =>
  `\`${cmd}\` does not name the branch it pushes to, and it may be a base branch. Name it: git push <remote> <branch> (never HEAD, never a base branch).`

/**
 * Why mag blocks a push in a Bash command, or null (topics-a-tree-of-agent.1): a push to one of `bases`, or one whose
 * target branch the command does not name (bare `git push`, `git push origin`, `HEAD`, `--all`, a glob), since that
 * resolves to the current branch, which in the user's checkout is usually a base. The deny rules catch a base named in
 * the command before the ask card; this catches what they cannot see.
 */
export function blockedPush(line: string, bases: string[]): string | null {
  for (const words of commands(line)) {
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++
    if (words[i] === 'env' || words[i] === 'command') i++
    if (!/(^|\/)git$/.test(words[i] ?? '')) continue
    i++
    while (i < words.length && words[i]!.startsWith('-')) i += GIT_VALUED.has(words[i]!) ? 2 : 1
    if (words[i] !== 'push') continue
    const cmd = words.join(' ')
    const positional: string[] = []
    let tags = false
    let options = true
    for (i++; i < words.length; i++) {
      const w = words[i]!
      if (options && w === '--') options = false
      else if (options && w.startsWith('-')) {
        if (w === '--all' || w === '--mirror' || w === '--branches') return SAYS_NO_BRANCH(cmd)
        if (w === '--tags') tags = true
        if (PUSH_VALUED.has(w)) i++
      } else positional.push(w)
    }
    const refspecs = positional.slice(1)
    if (!refspecs.length) {
      if (tags) continue
      return SAYS_NO_BRANCH(cmd)
    }
    for (const spec of refspecs) {
      const bare = spec.replace(/^\+/, '')
      const colon = bare.indexOf(':')
      const src = colon < 0 ? bare : bare.slice(0, colon)
      const dst = (colon < 0 ? bare : bare.slice(colon + 1)).replace(/^refs\/heads\//, '')
      if (colon < 0 && /^(HEAD|@)([~^].*)?$/.test(src)) return SAYS_NO_BRANCH(cmd)
      if (!dst || dst === 'HEAD' || dst.includes('*')) return SAYS_NO_BRANCH(cmd)
      if (dst.startsWith('refs/')) continue
      if (bases.includes(dst)) return `\`${cmd}\` pushes to the base branch ${dst}: mag never lets an agent push to a base branch; the user merges.`
    }
  }
  return null
}
