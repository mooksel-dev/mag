import { BrowserWindow, Notification, app, globalShortcut, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { join } from 'node:path'
import type { MeetingStatus } from '../preload/api'
import { openCapture } from './core/clients/audio-capture/index.ts'
import { createMeetingFiles } from './core/clients/meeting-files/index.ts'
import { createStt } from './core/clients/stt/index.ts'
import { createMeetings } from './core/services/meetings/index.ts'
import { log } from './log'
import { ICON } from './windows'

/** ⌘⇧R is a browser's hard reload; the hotkey is global, so it takes one no app uses. */
export const RECORD_HOTKEY = 'CommandOrControl+Alt+Shift+R'
/** Quitting mid-call waits this long for the last chunks' text. */
const QUIT_WAIT_MS = 30_000

/** The app icon with a red dot in its top right corner: the dock shows a call is being recorded. */
function recordingIcon(): NativeImage {
  const icon = nativeImage.createFromPath(ICON)
  const { width, height } = icon.getSize()
  const px = Buffer.from(icon.toBitmap())
  const r = width * 0.13
  const cx = width * 0.8
  const cy = height * 0.2
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d > r || x < 0 || y < 0 || x >= width || y >= height) continue
      const i = (y * width + x) * 4
      // BGRA; a white ring around the dot.
      const ring = d > r * 0.82
      px[i] = ring ? 255 : 0x30
      px[i + 1] = ring ? 255 : 0x3b
      px[i + 2] = ring ? 255 : 0xff
      px[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(px, { width, height })
}

/**
 * Meetings, workspace-wide (meetings-local-recording-transcript-and.1): Record / Stop from any window or the global
 * hotkey, the recording shown in every window and on the dock, a notification when the transcript is saved.
 */
export function startMeetings() {
  const root = join(app.getPath('documents'), 'mag', 'meetings')
  const stt = createStt({ modelsDir: join(app.getPath('userData'), 'whisper') })
  const helper = join(app.getAppPath(), 'native', 'mag-audio', 'build', 'mag-audio')
  let status: MeetingStatus = { recording: null, last: null, root, hotkey: RECORD_HOTKEY }
  let dotted: NativeImage | null = null
  // Electron drops click handlers of notifications that are garbage-collected.
  const shown = new Set<Notification>()

  const send = (next: Partial<MeetingStatus>) => {
    const was = !!status.recording
    status = { ...status, ...next }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meetings:status', status)
    if (was !== !!status.recording) app.dock?.setIcon(status.recording ? (dotted ??= recordingIcon()) : ICON)
  }

  const meetings = createMeetings({
    capture: (onChunk) => openCapture(helper, onChunk),
    stt,
    files: createMeetingFiles(root),
    onChange: (recording) => send({ recording }),
    onError: (message, e) => log.warn('meetings', message, e),
    onStopped: (meeting, dir) => {
      send({ last: { meeting, dir } })
      log.info('meetings', `${meeting.id} saved`, { error: meeting.error })
      if (!Notification.isSupported()) return
      const n = new Notification({ title: meeting.error ? 'Transcript incomplete' : 'Transcript saved', body: meeting.error ?? `${meeting.title}: click to show in Finder` })
      shown.add(n)
      n.on('click', () => (shown.delete(n), shell.showItemInFolder(join(dir, 'transcript.md'))))
      n.on('close', () => shown.delete(n))
      n.show()
    },
  })

  const start = async (title?: string) => {
    try {
      await meetings.start(title)
      return { ok: true as const }
    } catch (e) {
      log.warn('meetings', 'start failed', e)
      send({ error: (e as Error).message })
      return { error: (e as Error).message }
    }
  }
  const toggle = () => {
    const rec = meetings.status()
    if (rec?.phase === 'recording') void meetings.stop().catch((e) => log.warn('meetings', 'stop failed', e))
    else if (!rec) void start()
  }

  ipcMain.handle('meetings:status', () => status)
  ipcMain.handle('meetings:start', (_, title?: string) => (send({ error: undefined }), start(title)))
  ipcMain.handle('meetings:stop', async () => void (await meetings.stop()))
  if (!globalShortcut.register(RECORD_HOTKEY, () => (send({ error: undefined }), toggle()))) {
    log.warn('meetings', `${RECORD_HOTKEY} is taken by another app`)
    status.hotkey = null
  }
  app.on('will-quit', () => {
    globalShortcut.unregister(RECORD_HOTKEY)
    stt.close()
  })
  // Quitting mid-call still saves what was said.
  let saved = false
  app.on('before-quit', (e) => {
    if (saved || !meetings.status()) return
    e.preventDefault()
    const stopped = meetings.status()?.phase === 'starting' ? Promise.resolve() : meetings.stop().catch(() => {})
    void Promise.race([stopped, new Promise((r) => setTimeout(r, QUIT_WAIT_MS))]).finally(() => ((saved = true), app.quit()))
  })
}
