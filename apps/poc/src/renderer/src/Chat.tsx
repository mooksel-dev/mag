import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { resolveChoice, type AgentSession, type Attachment, type CanvasRef } from '@mag/core'
import type { AppState } from '../../preload/api'
import { ModelPicker, useAgents } from './Agents'

const mag = window.mag

/** Markdown with task keys (T-12) as links. Agent output is sanitized: it may echo repo or web content. */
export function Markdown({ text, onOpenTask, className = 'md' }: { text: string; onOpenTask?: (key: string) => void; className?: string }) {
  const html = useMemo(() => {
    // Link keys outside fenced and inline code only.
    const linked = text
      .split(/(```[\s\S]*?```|`[^`\n]*`)/)
      .map((part, i) => (i % 2 ? part : part.replace(/(^|[^\w/[-])(T-\d+)\b/g, '$1[$2](#task:$2)')))
      .join('')
    return DOMPurify.sanitize(marked.parse(linked, { async: false }) as string)
  }, [text])
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (href.startsWith('#task:')) onOpenTask?.(href.slice(6))
        else if (/^https:\/\//.test(href)) mag.open(href)
      }}
    />
  )
}

const fileUrl = (a: Attachment) => `mag-file://att/${encodeURIComponent(a.path.split(/[\\/]/).pop() ?? '')}`

export function CanvasFrame({ canvas, height = 340 }: { canvas: CanvasRef; height?: number | string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    mag.getCanvas(canvas.id).then(setHtml)
  }, [canvas.id, canvas.version])
  if (html === null) return <div className="muted small">Loading…</div>
  // No allow-same-origin: the page can run scripts but cannot reach window.mag.
  return <iframe className="canvasframe" title={canvas.title} sandbox="allow-scripts allow-popups" srcDoc={html} style={{ height }} />
}

export function CanvasCard({ canvas, latest = true }: { canvas: CanvasRef; latest?: boolean }) {
  const [full, setFull] = useState(false)
  return (
    <div className="canvascard">
      <div className="canvashead">
        <span className="title">{canvas.title}</span>
        <span className="muted small">v{canvas.version}</span>
        <div className="grow" />
        {latest && <button className="link" onClick={() => setFull(true)}>Expand</button>}
      </div>
      {latest ? <CanvasFrame canvas={canvas} /> : <div className="muted small pad">Revised later; see the newer version below.</div>}
      {full && (
        <div className="overlay" onClick={() => setFull(false)}>
          <div className="overlaybox" onClick={(e) => e.stopPropagation()}>
            <div className="canvashead">
              <span className="title">{canvas.title}</span>
              <span className="muted small">v{canvas.version}</span>
              <div className="grow" />
              <button onClick={() => setFull(false)}>Close</button>
            </div>
            <CanvasFrame canvas={canvas} height="100%" />
          </div>
        </div>
      )}
    </div>
  )
}

export function Chat({ session, onOpenTask, placeholder }: { session: AgentSession; onOpenTask?: (key: string) => void; placeholder?: string }) {
  const busy = session.status === 'running'
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [session.items.length, busy])
  // Only the last mention of a canvas renders it; earlier ones point forward.
  const lastCanvasAt = new Map<string, number>()
  session.items.forEach((i, n) => i.kind === 'canvas' && lastCanvasAt.set(i.canvas.id, n))

  return (
    <div className="chatbox">
      <div className="items">
        {session.items.map((i, n) => {
          switch (i.kind) {
            case 'user':
              return (
                <div key={n} className="msg user">
                  {i.text && <div className="plain">{i.text}</div>}
                  {i.attachments && <Attachments items={i.attachments} />}
                </div>
              )
            case 'assistant':
              return <Markdown key={n} className="msg agent md" text={i.text} onOpenTask={onOpenTask} />
            case 'canvas':
              return <CanvasCard key={n} canvas={i.canvas} latest={lastCanvasAt.get(i.canvas.id) === n} />
            case 'tool':
              return <div key={n} className="tool">{i.ok === false ? '✗' : i.ok ? '✓' : '…'} {i.name} <span className="muted">{i.summary}</span></div>
            case 'result':
              return <div key={n} className="muted small">turn done{i.costUsd != null ? ` · $${i.costUsd.toFixed(3)}` : ''}</div>
            case 'error':
              return <div key={n} className="msg error">{i.text}</div>
          }
        })}
        {busy && <div className="muted small">Agent is working…</div>}
        <div ref={end} />
      </div>
      <Composer
        busy={busy}
        placeholder={placeholder ?? 'Answer, push back, ask why…'}
        onSend={(text, att) => mag.send(session.id, text, att)}
        onStop={() => mag.stop(session.id)}
      />
    </div>
  )
}

function Attachments({ items, onRemove }: { items: Attachment[]; onRemove?: (a: Attachment) => void }) {
  return (
    <div className="attachments">
      {items.map((a) => (
        <span key={a.path} className="attachment" title={a.path}>
          {a.mime.startsWith('image/') ? (
            <img src={fileUrl(a)} alt={a.name} onClick={() => mag.open(a.path)} />
          ) : (
            <button className="link" onClick={() => mag.open(a.path)}>📎 {a.name}</button>
          )}
          {onRemove && <button className="x" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a)}>×</button>}
        </span>
      ))}
    </div>
  )
}

export function Composer({
  busy,
  placeholder,
  onSend,
  onStop,
}: {
  busy: boolean
  placeholder: string
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  onStop?: () => void
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  // Grow with the content; CSS caps it at 40vh and scrolls. Clearing the text after send shrinks it back.
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px` // + borders (box-sizing: border-box)
  }, [text])

  const add = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      const path = mag.pathForFile(f)
      const a = path
        ? await mag.saveAttachment({ name: f.name, path })
        : await mag.saveAttachment({ name: f.name || `pasted-${Date.now()}.png`, bytes: new Uint8Array(await f.arrayBuffer()) })
      setFiles((x) => [...x, a])
    }
  }
  const submit = async () => {
    if (busy || (!text.trim() && !files.length)) return
    await onSend(text.trim(), files)
    setText('')
    setFiles([])
  }

  return (
    <form
      className={`composer ${drag ? 'drag' : ''}`}
      onSubmit={(e) => { e.preventDefault(); void submit() }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void add(e.dataTransfer.files) }}
    >
      {files.length > 0 && <Attachments items={files} onRemove={(a) => setFiles((x) => x.filter((f) => f !== a))} />}
      <div className="composerrow">
        <button type="button" className="icon" title="Attach files" aria-label="Attach files" onClick={() => picker.current?.click()}>+</button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files)
            if (imgs.length) { e.preventDefault(); void add(imgs) }
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }}
          placeholder={busy ? 'Wait for the agent to finish…' : `${placeholder}  (↵ to send, ⇧↵ for a new line, paste screenshots)`}
          rows={1}
          aria-label="Message"
        />
        {busy && onStop ? <button type="button" onClick={onStop}>Stop</button> : <button type="submit" className="primary" disabled={busy}>Send</button>}
      </div>
    </form>
  )
}

/** Project-level conversation, available next to every tab. */
export function ProjectChat({ projectId, state, onOpenTask, onClose }: { projectId: string; state: AppState; onOpenTask: (key: string) => void; onClose: () => void }) {
  const chats = state.sessions.filter((s) => s.projectId === projectId && s.role === 'chat').sort((a, b) => b.createdAt - a.createdAt)
  const [chatId, setChatId] = useState<string | null>(null)
  const chat = chats.find((c) => c.id === chatId) ?? chats[0] ?? null
  const project = state.projects.find((p) => p.id === projectId)
  const agents = useAgents()

  const startNew = async (text?: string, att?: Attachment[]) => {
    const id = await mag.newChat(projectId)
    setChatId(id)
    if (text !== undefined) await mag.send(id, text, att)
  }

  return (
    <aside className="projectchat">
      <div className="pchead">
        <select value={chat?.id ?? ''} onChange={(e) => setChatId(e.target.value)} aria-label="Chat thread" disabled={!chats.length}>
          {!chats.length && <option value="">No chats yet</option>}
          {chats.map((c) => <option key={c.id} value={c.id}>{c.status === 'running' ? '● ' : ''}{c.title ?? 'Chat'}</option>)}
        </select>
        <button onClick={() => startNew()} title="New thread">New</button>
        <button className="link" onClick={onClose} aria-label="Close chat">×</button>
      </div>
      {project && (
        <div className="pchead">
          <ModelPicker
            agents={agents}
            label="Chat"
            choice={resolveChoice(project, 'chat')}
            onChange={(c) => mag.updateProject(project.id, { agents: { ...project.agents, chat: c } })}
          />
          {chat?.activeModel && <span className="muted small" title="Model of this thread's last run">{chat.activeModel}</span>}
        </div>
      )}
      {chat && chat.items.length > 0 ? (
        <Chat session={chat} onOpenTask={onOpenTask} placeholder="Talk about the project…" />
      ) : (
        <div className="chatbox">
          <div className="items">
            <p className="muted small">
              Talk about the project: ideas, design, architecture, priorities. The agent reads the code, draws mockups,
              and turns decisions into tasks and notes. It never edits code itself.
            </p>
          </div>
          <Composer busy={false} placeholder="Talk about the project…" onSend={(t, a) => (chat ? mag.send(chat.id, t, a) : startNew(t, a))} />
        </div>
      )}
    </aside>
  )
}
