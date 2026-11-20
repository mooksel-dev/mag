import type { MeetingStatus } from '../../preload/api'

const KEYS: Record<string, string> = { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' }
const ORDER = ['⌃', '⌥', '⇧', '⌘']

/** An Electron accelerator as macOS writes it: CommandOrControl+Alt+Shift+R → ⌥⇧⌘R. */
export function hotkeyLabel(accelerator: string): string {
  const parts = accelerator.split('+')
  const mods = parts.slice(0, -1).map((p) => KEYS[p] ?? p).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  return mods.join('') + parts[parts.length - 1]
}

/** 75 → 1:15, 3725 → 1:02:05. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60) % 60)
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

const mb = (n: number) => `${Math.round(n / 1e6)} MB`

/** What the recording is busy with besides recording; null when nothing. */
export function recordingNote(rec: NonNullable<MeetingStatus['recording']>): string | null {
  if (rec.phase === 'starting') return 'Starting: the first time, allow mag-audio to use the microphone and record system audio'
  if (rec.phase === 'stopping') return rec.pending ? `Transcribing the last ${rec.pending} ${rec.pending === 1 ? 'piece' : 'pieces'}…` : 'Saving…'
  const s = rec.setup
  if (s?.step === 'install') return 'Installing whisper.cpp (brew)…'
  if (s?.step === 'model') return `Downloading the speech model${s.total ? ` ${Math.floor((s.done / s.total) * 100)}% of ${mb(s.total)}` : `: ${mb(s.done)}`}; recording meanwhile`
  if (s?.step === 'load') return 'Loading the speech model…'
  return rec.error ?? null
}
