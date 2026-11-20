import { useEffect, useState } from 'react'
import type { MeetingStatus } from '../../preload/api'
import { elapsed, hotkeyLabel, recordingNote } from './recordingText'
import { useNow } from './Tasks'

const mag = window.mag

export function useMeetingStatus(): MeetingStatus | null {
  const [status, setStatus] = useState<MeetingStatus | null>(null)
  useEffect(() => {
    void mag.meetingStatus().then(setStatus)
    return mag.onMeetingStatus(setStatus)
  }, [])
  return status
}

/** Record / Stop a call, workspace-wide: the same in every window, with the global hotkey. */
export function Recorder() {
  const status = useMeetingStatus()
  const now = useNow(1000)
  const [busy, setBusy] = useState(false)
  if (!status) return null
  const rec = status.recording
  const key = status.hotkey ? hotkeyLabel(status.hotkey) : null
  const note = rec ? recordingNote(rec) : null
  const run = (f: () => Promise<unknown>) => {
    setBusy(true)
    void f().finally(() => setBusy(false))
  }
  if (rec) {
    return (
      <div className="recorder on" role="status" aria-live="polite">
        <button className="recbtn" disabled={busy || rec.phase !== 'recording'} title={key ? `Stop and save the transcript (${key})` : 'Stop and save the transcript'} onClick={() => run(() => mag.stopRecording())}>
          <span className="recdot" aria-hidden />
          {rec.phase === 'recording' ? 'Stop' : rec.phase === 'starting' ? 'Starting…' : 'Stopping…'}
          <span className="rectime">{elapsed(now - Date.parse(rec.startedAt))}</span>
          {key && <kbd>{key}</kbd>}
        </button>
        {note && <p className={`recnote${rec.error && note === rec.error ? ' err' : ''}`}>{note}</p>}
      </div>
    )
  }
  const last = status.last
  return (
    <div className="recorder">
      <button className="recbtn" disabled={busy} title={`Record the call: mic and system audio, transcribed on this Mac into ${status.root}; no audio is kept`} onClick={() => run(() => mag.startRecording())}>
        <span className="recdot idle" aria-hidden />
        Record call
        {key && <kbd>{key}</kbd>}
      </button>
      {status.error && <p className="recnote err">{status.error}</p>}
      {!status.error && last && (
        <p className={`recnote${last.meeting.error ? ' err' : ''}`}>
          {last.meeting.error ? `Saved with gaps: ${last.meeting.error}` : `Saved: ${last.meeting.title}`}{' '}
          <button className="link" onClick={() => void mag.open(last.dir)}>Show in Finder</button>
        </p>
      )}
    </div>
  )
}
