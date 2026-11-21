import { BrowserWindow, Notification, app, dialog, globalShortcut, ipcMain, nativeImage, shell, type NativeImage } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingStatus } from '../preload/api'
import { openCapture } from './core/clients/audio-capture/index.ts'
import { createClaudeCli } from './core/clients/claude-cli/index.ts'
import { createMeetingFiles, type MeetingLink } from './core/clients/meeting-files/index.ts'
import { createStt } from './core/clients/stt/index.ts'
import { createMeetings, type Meetings, type SearchFilters } from './core/services/meetings/index.ts'
import type { Search } from './core/services/search/index.ts'
import { log } from './log'
import { meetingHits } from './meeting-tools.ts'
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

/** Workspace settings of meetings, in userData/meetings.json: where they are kept. */
function rootSetting(userData: string, fallback: string) {
  const file = join(userData, 'meetings.json')
  let root = fallback
  try {
    const saved = (JSON.parse(readFileSync(file, 'utf8')) as { root?: unknown }).root
    if (typeof saved === 'string' && saved) root = saved
  } catch {
    // none saved yet
  }
  return {
    get: () => root,
    set(next: string) {
      root = next
      writeFileSync(file, `${JSON.stringify({ root }, null, 2)}\n`)
    },
  }
}

/**
 * Meetings, workspace-wide (meetings-local-recording-transcript-and): Record / Stop from any window or the global
 * hotkey, the recording shown in every window and on the dock, a notification when the transcript is saved; the
 * Meetings section's list, meeting view, rename, delete, links, Show in Finder and the storage root.
 */
export function startMeetings(opts: { search: Pick<Search, 'query'>; onMeetingsChanged: () => void; indexPath: string }): Meetings {
  const userData = app.getPath('userData')
  const root = rootSetting(userData, join(app.getPath('documents'), 'mag', 'meetings'))
  const stt = createStt({ modelsDir: join(userData, 'whisper') })
  const helper = join(app.getAppPath(), 'native', 'mag-audio', 'build', 'mag-audio')
  const llmDir = join(userData, 'runs', 'meetings')
  mkdirSync(llmDir, { recursive: true })
  let status: MeetingStatus = { recording: null, last: null, root: root.get(), hotkey: RECORD_HOTKEY, summarizing: [] }
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
    files: createMeetingFiles(root.get),
    llm: createClaudeCli({ cwd: llmDir }),
    onChange: (recording) => send({ recording }),
    onMeetingsChanged: () => {
      send({ summarizing: meetings.summarizing() })
      opts.onMeetingsChanged()
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meetings:changed')
    },
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

  // The meetings-only index of before (unified-search-across-the-workspace.1): derived, the shared one replaces it.
  const old = join(root.get(), '.index.sqlite')
  if (old !== opts.indexPath) rmSync(old, { force: true })

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
  ipcMain.handle('meetings:list', () => meetings.list())
  ipcMain.handle('meetings:read', (_, id: string) => meetings.read(id))
  ipcMain.handle('meetings:remove', (_, id: string) => {
    meetings.remove(id)
    if (status.last?.meeting.id === id) send({ last: null })
  })
  ipcMain.handle('meetings:rename', (_, id: string, title: string) => {
    const meeting = meetings.rename(id, title)
    if (status.last?.meeting.id === id) send({ last: { ...status.last, meeting } })
    return meeting
  })
  ipcMain.handle('meetings:link', (_, id: string, ref: MeetingLink) => meetings.link(id, ref))
  ipcMain.handle('meetings:unlink', (_, id: string, ref: MeetingLink) => meetings.unlink(id, ref))
  ipcMain.handle('meetings:search', (_, q: string, filters?: SearchFilters) => meetingHits(opts.search, meetings, q, filters))
  ipcMain.handle('meetings:summarize', (_, id: string) => meetings.summarize(id))
  ipcMain.handle('meetings:reveal', (_, id?: string) => {
    if (!id) {
      mkdirSync(root.get(), { recursive: true })
      return void shell.openPath(root.get())
    }
    shell.showItemInFolder(join(meetings.read(id).dir, 'transcript.md'))
  })
  // Meetings already saved stay where they are; the list shows the new root's.
  ipcMain.handle('meetings:chooseRoot', async () => {
    if (meetings.status()) throw new Error('Stop the recording first')
    const r = await dialog.showOpenDialog({ title: 'Where mag keeps meetings', defaultPath: root.get(), properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    root.set(r.filePaths[0])
    opts.onMeetingsChanged()
    send({ root: root.get(), last: null })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('meetings:changed')
    return root.get()
  })
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
  return meetings
}
