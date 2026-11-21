/** Just enough shell parsing for the known CLIs: words, simple commands, flags. No expansion. */

/** Shell words of one command, quotes removed; enough for the CLIs below (no expansion). */
export function words(command: string): string[] {
  const out: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      word ??= ''
    } else if (c === '\\' && i + 1 < command.length) word = (word ?? '') + command[++i]
    else if (/\s/.test(c)) {
      if (word !== null) out.push(word)
      word = null
    } else word = (word ?? '') + c
  }
  if (word !== null) out.push(word)
  return out
}

/** The simple commands of a command line: split at |, ;, & and newlines outside quotes. */
export function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\' && quote !== "'") {
      cur += c + (command[++i] ?? '')
      continue
    }
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '|' || c === ';' || c === '&' || c === '\n') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** The value of the first of `flags` (`--key X` or `--key=X`). */
export function flag(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const f of flags) {
      if (args[i] === f) return args[i + 1]
      if (f.startsWith('--') && args[i].startsWith(`${f}=`)) return args[i].slice(f.length + 1)
    }
  }
  return undefined
}
