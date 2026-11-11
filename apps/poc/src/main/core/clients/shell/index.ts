import { spawn } from 'node:child_process'

/** A command the user runs from a chat: its output as it comes, its end, and a way to stop it. */
export interface ShellRun {
  done: Promise<{ code: number | null }>
  stop: () => void
}

/** Output kept per run; the rest is cut, as a terminal's scrollback is. */
const MAX_OUTPUT = 200_000

/**
 * Runs `command` in the user's login shell in `cwd`, as their terminal would (their PATH, aliases off), without stdin:
 * a prompt for input ends it instead of hanging. `onOutput` gets stdout and stderr as they come.
 */
export function runShell(command: string, cwd: string, onOutput: (chunk: string) => void): ShellRun {
  const shell = process.env.SHELL || '/bin/zsh'
  const child = spawn(shell, ['-lc', command], { cwd, env: { ...process.env, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let sent = 0
  const out = (b: Buffer) => {
    if (sent >= MAX_OUTPUT) return
    const text = b.toString('utf8').slice(0, MAX_OUTPUT - sent)
    sent += text.length
    onOutput(sent >= MAX_OUTPUT ? `${text}\n… output cut at ${MAX_OUTPUT} characters` : text)
  }
  child.stdout.on('data', out)
  child.stderr.on('data', out)
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.on('error', (e) => { onOutput(`${e.message}\n`); resolve({ code: null }) })
    child.on('close', (code) => resolve({ code }))
  })
  // The whole process group: a command's own children stop with it.
  const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
  return { done, stop }
}
