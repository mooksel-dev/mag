// One-shot answers from the Claude Code CLI the user already has (`claude -p`, no tools, no MCP): no API key of mag's.
import { claudeCode, type AgentAdapter } from '@mag/agents'

export interface ClaudeCli {
  /** `prompt` (the instructions), then `input` (the material); the reply's text. Rejects when the run fails. */
  complete(prompt: string, input: string): Promise<string>
}

export interface ClaudeCliOptions {
  /** Where the CLI runs; nothing is read from it. */
  cwd: string
  model?: string
  adapter?: Pick<AgentAdapter, 'start'>
}

export function createClaudeCli(opts: ClaudeCliOptions): ClaudeCli {
  const adapter = opts.adapter ?? claudeCode
  return {
    async complete(prompt, input) {
      let text = ''
      let error: string | null = null
      const run = adapter.start({ cwd: opts.cwd, prompt: `${prompt}\n\n${input}`, model: opts.model ?? 'sonnet', noTools: true }, (e) => {
        if (e.type === 'message' && !e.parentToolUseId) text += e.text
        else if (e.type === 'error') error = e.message
        else if (e.type === 'turn.done' && !e.ok) error ??= 'the run failed'
      })
      await run.done
      if (error) throw new Error(`Claude CLI: ${error}`)
      if (!text.trim()) throw new Error('Claude CLI answered nothing')
      return text.trim()
    },
  }
}
