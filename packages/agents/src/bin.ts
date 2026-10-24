import { execFileSync } from 'node:child_process'

const cache = new Map<string, string | null>()

/**
 * Absolute path of a CLI: `envVar` if set, otherwise `command -v <name>` in a login shell.
 * GUI-launched apps on macOS don't get the shell PATH, so ask the shell. Cached per name.
 */
export function findBin(name: string, envVar: string): string | null {
  if (process.env[envVar]) return process.env[envVar]!
  if (cache.has(name)) return cache.get(name)!
  const shell = process.env.SHELL || '/bin/zsh'
  let bin: string | null = null
  try {
    const out = execFileSync(shell, ['-ilc', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 })
    const line = out.trim().split('\n').pop()
    bin = line && line.startsWith('/') ? line : null
  } catch {
    bin = null
  }
  cache.set(name, bin)
  return bin
}
