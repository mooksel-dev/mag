/**
 * T-40.1 spike driver, not product code. Runs `claude -p` with stream-json on stdin and stdout, plays a scenario
 * and logs everything as JSONL: `{ t, line }` per stdout line, `{ t, in }` per stdin write, then close and exit
 * (`t` in ms since spawn). The second form turns such a log into a test fixture in src/__fixtures__.
 *
 *   node packages/agents/spike/claude-stream.ts <scenario> <log.jsonl> [cwd]
 *   node packages/agents/spike/claude-stream.ts fixture <log.jsonl> <fixture.jsonl> [--no-exit]
 *
 * Env: SPIKE_MODEL (default haiku), SPIKE_RESUME=<session id>, MAG_CLAUDE_BIN.
 * Run scenarios one at a time: in parallel, API calls stalled for minutes.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** Wait for all that is set (in this order: `result` results seen, a stdout line containing `match`, `ms`), then act. */
type Step = { result?: number; match?: string; ms?: number } & (
  | { send: string }
  | { control: Record<string, unknown> }
  | { stopTaskFromLast: true }
  | { closeStdin: true }
  | { kill: NodeJS.Signals }
)

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })

const scenarios: Record<string, Step[]> = {
  // Is the process alive after `result` with stdin open? Is a message sent mid-turn queued?
  queue: [
    { ms: 0, send: 'Run `sleep 8 && echo one` with Bash (foreground), then reply "done one".' },
    { ms: 2000, send: 'Now reply with the single word "two".' },
    { result: 1, ms: 3000, closeStdin: true },
  ],
  // Background Bash: does the agent wake up by itself when the task ends?
  bgBash: [
    { ms: 0, send: 'Start `sleep 15 && echo bg-finished` with Bash run_in_background=true. Do not wait for it, reply "started" and end your turn. When it finishes, reply "seen: <its output>".' },
    { result: 2, ms: 2000, closeStdin: true },
  ],
  // Monitor: events per fire, wakeups.
  monitor: [
    { ms: 0, send: 'Use the Monitor tool on the command `for i in 1 2; do sleep 6; echo tick $i; done` (description "ticks"). Reply "watching" and end your turn. On each notification reply "got <line>".' },
    { result: 3, ms: 3000, closeStdin: true },
  ],
  // Interrupt mid-turn (during a foreground tool); does the background task survive and still wake the agent?
  interrupt: [
    { ms: 0, send: 'First start `sleep 15 && echo bg-done` with Bash run_in_background=true. Then, in a separate Bash call in the foreground, run `for i in $(seq 40); do sleep 1; done; echo fg-done`. Then reply "finished". When the background command finishes, reply "bg seen".' },
    { match: '"is_backgrounded":false', control: { subtype: 'interrupt' } },
    { result: 1, ms: 0, send: 'Reply with the single word "after".' },
    { result: 3, ms: 2000, closeStdin: true },
  ],
  // Stop one background task via control request.
  stopTask: [
    { ms: 0, send: 'Start `sleep 60 && echo never` with Bash run_in_background=true. Reply "started" and end your turn.' },
    { result: 1, ms: 1000, stopTaskFromLast: true },
    { ms: 6000, send: 'Did the background task finish or get stopped? One sentence.' },
    { result: 2, ms: 2000, closeStdin: true },
  ],
  // Close stdin while a background task runs: does the process wait, exit, or kill the task?
  closeWithBg: [
    { ms: 0, send: 'Start `sleep 20 && echo late` with Bash run_in_background=true. Reply "started" and end your turn. When it finishes, reply "late seen".' },
    { result: 1, ms: 500, closeStdin: true },
  ],
  // SIGTERM while a background task runs: exit code, what is reported.
  sigterm: [
    { ms: 0, send: 'Start `sleep 60 && echo late` with Bash run_in_background=true. Reply "started" and end your turn.' },
    { result: 1, ms: 500, kill: 'SIGTERM' },
  ],
  // Reopen a session with --resume (SPIKE_RESUME=<session id>): is the history there?
  resume: [
    { ms: 0, send: 'What was the last word you replied with in this conversation? Answer with that word only.' },
    { result: 1, ms: 500, closeStdin: true },
  ],
  // A user message sent while a wake-up turn runs.
  sendDuringWake: [
    { ms: 0, send: 'Start `sleep 8 && echo bg-done` with Bash run_in_background=true. Reply "started" and end your turn. When it finishes, run `for i in $(seq 8); do sleep 1; done` in the foreground and then reply "bg seen".' },
    { result: 1, match: '"is_backgrounded":false', send: 'Also reply with the word "queued".' },
    { result: 3, ms: 2000, closeStdin: true },
  ],
}

/** Keep a log's stdout lines minus noise (hooks, thinking, rate limits, usage), our writes as `__stdin`, the end as `__exit`. */
function toFixture(log: string, out: string, keepExit: boolean) {
  const rows: unknown[] = []
  for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(l)
    if (o.in) rows.push({ __stdin: o.in })
    else if (o.closeStdin || o.exit) keepExit && rows.push(o.exit ? { __exit: o.exit } : { __stdin: 'close' })
    else {
      let j: any
      try {
        j = JSON.parse(o.line)
      } catch {
        continue
      }
      if (j.type === 'rate_limit_event' || j.type === 'tool_progress') continue
      if (['hook_started', 'hook_response', 'thinking_tokens'].includes(j.subtype)) continue
      if (j.subtype === 'init') j = { type: j.type, subtype: j.subtype, cwd: j.cwd, session_id: j.session_id, model: j.model, permissionMode: j.permissionMode, tools: ['Bash', 'Monitor', 'Read'] }
      if (j.type === 'assistant') {
        const m = j.message
        m.content = m.content.filter((b: any) => b.type !== 'thinking')
        if (!m.content.length) continue
        for (const k of ['usage', 'container', 'context_management', 'stop_details']) delete m[k]
      }
      if (j.type === 'user') delete j.tool_result_meta
      if (j.type === 'result') for (const k of ['usage', 'modelUsage', 'subagent_stats', 'fast_mode_state', 'fast_mode_disabled_reason', 'iterations']) delete j[k]
      delete j.uuid
      rows.push(j)
    }
  }
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  writeFileSync(out, text.replace(/\/Users\/[^/"]+/g, '/Users/me').replace(/\/claude-\d+\//g, '/claude-0/'))
}

if (process.argv[2] === 'fixture') {
  const [log, out] = process.argv.slice(3)
  toFixture(log, out, !process.argv.includes('--no-exit'))
  process.exit(0)
}

const [name, out, cwd = process.cwd()] = process.argv.slice(2)
const steps = scenarios[name]
if (!steps || !out) throw new Error(`usage: claude-stream.ts <${Object.keys(scenarios).join('|')}> <out.jsonl> [cwd]`)

const t0 = Date.now()
const now = () => Date.now() - t0
const log = createWriteStream(out)
const child = spawn(
  process.env.MAG_CLAUDE_BIN ?? 'claude',
  [
    ...['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    ...['--model', process.env.SPIKE_MODEL ?? 'haiku', '--allowedTools', 'Bash,Monitor'],
    ...(process.env.SPIKE_RESUME ? ['--resume', process.env.SPIKE_RESUME] : []),
  ],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
)
let results = 0
let lastTaskId: string | undefined
let req = 0
const waiters: Array<(line: string) => void> = []
const write = (o: unknown) => {
  const s = JSON.stringify(o)
  console.log(`${now()} >> ${s}`)
  log.write(JSON.stringify({ t: now(), in: o }) + '\n')
  child.stdin.write(s + '\n')
}
child.stderr.on('data', (d) => console.log(`${now()} stderr ${d}`))
createInterface({ input: child.stdout }).on('line', (line) => {
  console.log(`${now()} << ${line.slice(0, 300)}`)
  log.write(JSON.stringify({ t: now(), line }) + '\n')
  try {
    const j = JSON.parse(line)
    if (j.type === 'result') results++
    const id = j.task_id ?? j.tasks?.[0]?.task_id
    if (typeof id === 'string') lastTaskId = id
  } catch {}
  for (const w of [...waiters]) w(line)
})
child.on('exit', (code, signal) => {
  console.log(`${now()} exit code=${code} signal=${signal}`)
  log.write(JSON.stringify({ t: now(), exit: { code, signal } }) + '\n')
  log.end()
  process.exit(0)
})

const until = (ok: (line: string) => boolean) =>
  new Promise<void>((resolve) => {
    const w = (line: string) => {
      if (ok(line)) waiters.splice(waiters.indexOf(w), 1), resolve()
    }
    waiters.push(w)
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Safety net for the spike.
setTimeout(() => child.kill('SIGTERM'), 400_000)
for (const s of steps) {
  const want = s.result
  if (want && results < want) await until(() => results >= want)
  if (s.match) await until((l) => l.includes(s.match!))
  if (s.ms) await sleep(s.ms)
  if ('send' in s) write(user(s.send))
  else if ('control' in s) write({ type: 'control_request', request_id: `req_${++req}`, request: s.control })
  else if ('stopTaskFromLast' in s) write({ type: 'control_request', request_id: `req_${++req}`, request: { subtype: 'stop_task', task_id: lastTaskId } })
  else if ('closeStdin' in s) console.log(`${now()} -- close stdin`), log.write(JSON.stringify({ t: now(), closeStdin: true }) + '\n'), child.stdin.end()
  else child.kill(s.kill)
}
