import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { createPortal } from 'react-dom'
import { TASK_KEY_RE, chatCommands, resolveChoice, type AgentSession, type Attachment, type CanvasRef, type ChatItem } from '@mag/core'
import type { AppState } from '../../preload/api'
import { ModelPicker, useAgents } from './Agents'
import { useAppliedTheme } from './useTheme'

const mag = window.mag
// A trailing period is not part of the key: "see T-1." links T-1.
const KEY_LINK = new RegExp(`(^|[^\\w/[-])(${TASK_KEY_RE.source})(?![\\w-]|\\.\\d)`, 'g')

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

let mermaidSeq = 0

/** Replaces ```mermaid code blocks under `root` with SVG; a block that fails to parse stays as code. */
async function renderMermaid(root: HTMLElement, theme: 'light' | 'dark', cancelled: () => boolean) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
  if (!blocks.length) return
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default' })
  for (const code of blocks) {
    const id = `mermaid-${++mermaidSeq}`
    try {
      const { svg } = await mermaid.render(id, code.textContent ?? '')
      if (cancelled()) return
      const box = document.createElement('div')
      box.className = 'mermaid'
      box.innerHTML = svg
      code.parentElement?.replaceWith(box)
    } catch {
      document.getElementById(`d${id}`)?.remove() // mermaid leaves its error diagram in <body>
    }
  }
}

/**
 * Markdown with task keys (T-12, T-12.3) as links, ```mermaid blocks as diagrams and [title](canvas:<id>) links as
 * inline canvases. Agent output is sanitized: it may echo repo or web content.
 */
export function Markdown({ text, onOpenTask, canvases, className = 'md' }: { text: string; onOpenTask?: (key: string) => void; canvases?: CanvasRef[]; className?: string }) {
  const theme = useAppliedTheme()
  const ref = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<HTMLElement[]>([])
  const html = useMemo(() => {
    // Rewrite outside fenced and inline code only. Canvas links become slots: DOMPurify drops the canvas: scheme.
    const linked = text
      .split(/(```[\s\S]*?```|`[^`\n]*`)/)
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(/\[([^\]\n]*)\]\(canvas:([\w-]+)\)/g, (_, title: string, id: string) => `<span class="canvasslot" data-canvas="${id}">${escapeHtml(title)}</span>`)
              .replace(KEY_LINK, '$1[$2](#task:$2)'),
      )
      .join('')
    return DOMPurify.sanitize(marked.parse(linked, { async: false }) as string)
  }, [text])
  useLayoutEffect(() => {
    const found = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-canvas]') ?? []).filter((el) => canvases?.some((c) => c.id === el.dataset.canvas))
    for (const el of found) el.textContent = '' // the card shows the title; unknown ids keep it as plain text
    setSlots(found)
  }, [html, theme, canvases])
  useEffect(() => {
    let cancelled = false
    if (ref.current) void renderMermaid(ref.current, theme, () => cancelled)
    return () => { cancelled = true }
  }, [html, theme])
  return (
    <>
      <div
        ref={ref}
        key={theme} // a theme change re-renders mermaid from the source, so start from fresh HTML
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
      {slots.map((el, i) => {
        const canvas = canvases?.find((c) => c.id === el.dataset.canvas)
        return canvas && createPortal(<CanvasCard key={canvas.version} canvas={canvas} />, el, i)
      })}
    </>
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
      {full && <CanvasOverlay canvas={canvas} onClose={() => setFull(false)} />}
    </div>
  )
}

/** Full-screen view of one canvas. */
export function CanvasOverlay({ canvas, onClose }: { canvas: CanvasRef; onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlaybox" onClick={(e) => e.stopPropagation()}>
        <div className="canvashead">
          <span className="title">{canvas.title}</span>
          <span className="muted small">v{canvas.version}</span>
          <div className="grow" />
          <button onClick={onClose}>Close</button>
        </div>
        <CanvasFrame canvas={canvas} height="100%" />
      </div>
    </div>
  )
}

/** Project canvases that belong to no task; otherwise they are only reachable by scrolling a chat. */
function CanvasMenu({ canvases }: { canvases: AppState['canvases'] }) {
  const [open, setOpen] = useState(false)
  const [shownId, setShownId] = useState<string | null>(null)
  const shown = canvases.find((c) => c.id === shownId)
  if (!canvases.length) return null
  return (
    <div className="menu">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title="Project canvases">
        ▣ Canvases ({canvases.length})
      </button>
      {open && (
        <>
          <div className="menuscrim" onClick={() => setOpen(false)} />
          <div className="menulist" role="menu">
            {canvases.map((c) => (
              <button key={c.id} role="menuitem" onClick={() => { setShownId(c.id); setOpen(false) }}>
                <span className="title" title={c.title}>{c.title}</span>
                <span className="muted small">v{c.version}</span>
                <span className="muted small">{new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {shown && <CanvasOverlay canvas={shown} onClose={() => setShownId(null)} />}
    </div>
  )
}

export function Chat({ session, sessions, onOpenTask, placeholder }: { session: AgentSession; sessions: AgentSession[]; onOpenTask?: (key: string) => void; placeholder?: string }) {
  const busy = session.status === 'running'
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [session.items.length, busy])
  // Only the last mention of a canvas renders it; earlier ones point forward.
  const lastCanvasAt = new Map<string, number>()
  session.items.forEach((i, n) => i.kind === 'canvas' && lastCanvasAt.set(i.canvas.id, n))

  // Runs of consecutive tool calls render as one collapsible row. n = index of the (first) item, used as key.
  const rows: { n: number; item?: ChatItem; tools?: ToolItem[] }[] = []
  session.items.forEach((item, n) => {
    const last = rows[rows.length - 1]
    if (item.kind !== 'tool') rows.push({ n, item })
    else if (last?.tools) last.tools.push(item)
    else rows.push({ n, tools: [item] })
  })

  return (
    <div className="chatbox">
      <div className="items">
        {rows.map(({ n, item: i, tools }) => {
          if (!i) return <ToolGroup key={n} tools={tools!} />
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
            case 'result':
              return <div key={n} className="muted small">turn done{i.costUsd != null ? ` · $${i.costUsd.toFixed(3)}` : ''}</div>
            case 'error':
              return <div key={n} className="msg error">{i.text}</div>
            case 'notice':
              return <div key={n} className="notice muted small">{i.text}</div>
          }
        })}
        {busy && <div className="muted small">Agent is working…</div>}
        <div ref={end} />
      </div>
      <Composer
        busy={busy}
        placeholder={placeholder ?? 'Answer, push back, ask why…'}
        commands={chatCommands(session, sessions)}
        onSend={(text, att) => mag.send(session.id, text, att)}
        onStop={() => mag.stop(session.id)}
      />
    </div>
  )
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const toolMark = (ok: boolean | undefined) => (ok === false ? '✗' : ok ? '✓' : '…')

/** "▸ 8 tools · update_doc, create_subtask ×3"; expands to one line per call. */
function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
  const names = [...counts].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name)).join(', ')
  // Surface what still matters when collapsed: a failure, or a call that is still running.
  const mark = tools.some((t) => t.ok === false) ? '✗ ' : tools.some((t) => t.ok === undefined) ? '… ' : ''
  return (
    <div className="toolgroup">
      <button className="toolsrow" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {mark}{tools.length} {tools.length === 1 ? 'tool' : 'tools'} · {names}
      </button>
      {open && tools.map((t, i) => (
        <div key={i} className="tool">{toolMark(t.ok)} {t.name} <span className="muted">{t.summary}</span></div>
      ))}
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
  commands = [],
  onSend,
  onStop,
}: {
  busy: boolean
  placeholder: string
  /** Slash commands to offer after "/", without the slash; empty = text starting with "/" is plain text. */
  commands?: string[]
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  onStop?: () => void
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [sel, setSel] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  // "/" + a name being typed (no space yet) opens the menu, filtered by prefix.
  const isCommand = commands.length > 0 && text.startsWith('/')
  const typed = isCommand ? /^\/(\S*)$/.exec(text)?.[1] : undefined
  const matches = typed === undefined ? [] : commands.filter((c) => c.startsWith(typed))
  const menuOpen = matches.length > 0 && !menuClosed
  const pick = (name: string) => {
    setText(`/${name} `)
    ta.current?.focus()
  }
  useEffect(() => {
    setSel(0)
    setMenuClosed(false)
  }, [typed])
  useEffect(() => {
    menu.current?.children[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel])

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
    // Files never go with a command; they stay for the next message.
    await onSend(text.trim(), isCommand ? [] : files)
    setText('')
    if (!isCommand) setFiles([])
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (menuOpen) {
      const exact = typed !== undefined && commands.includes(typed)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuClosed(true)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
        e.preventDefault()
        pick(matches[Math.min(sel, matches.length - 1)])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <form
      className={`composer ${drag ? 'drag' : ''}`}
      onSubmit={(e) => { e.preventDefault(); void submit() }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void add(e.dataTransfer.files) }}
    >
      {menuOpen && (
        <div ref={menu} className="cmdmenu" role="listbox" aria-label="Commands">
          {matches.map((c, i) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={i === sel}
              className={i === sel ? 'sel' : ''}
              onMouseDown={(e) => e.preventDefault()} // keep focus in the textarea
              onClick={() => pick(c)}
            >
              /{c}
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && <Attachments items={files} onRemove={(a) => setFiles((x) => x.filter((f) => f !== a))} />}
      <div className="composerrow">
        <button type="button" className="icon" title={isCommand ? 'Commands take no files' : 'Attach files'} aria-label="Attach files" disabled={isCommand} onClick={() => picker.current?.click()}>+</button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files)
            if (imgs.length) { e.preventDefault(); void add(imgs) }
          }}
          onKeyDown={onKeyDown}
          placeholder={busy ? 'Wait for the agent to finish…' : `${placeholder}  (↵ to send, ⇧↵ for a new line, paste screenshots${commands.length ? ', / for commands' : ''})`}
          rows={1}
          aria-label="Message"
        />
        {busy && onStop ? <button type="button" onClick={onStop}>Stop</button> : <button type="submit" className="primary" disabled={busy}>Send</button>}
      </div>
    </form>
  )
}

/** Project-level conversation: a closable aside next to every tab, or `embedded` in the task screen's chat panel. */
export function ProjectChat({ projectId, state, onOpenTask, onClose, embedded }: { projectId: string; state: AppState; onOpenTask: (key: string) => void; onClose?: () => void; embedded?: boolean }) {
  const chats = state.sessions.filter((s) => s.projectId === projectId && s.role === 'chat').sort((a, b) => b.createdAt - a.createdAt)
  const [chatId, setChatId] = useState<string | null>(null)
  const chat = chats.find((c) => c.id === chatId) ?? chats[0] ?? null
  const project = state.projects.find((p) => p.id === projectId)
  const canvases = state.canvases.filter((c) => c.projectId === projectId && c.taskId === null).sort((a, b) => b.updatedAt - a.updatedAt)
  const agents = useAgents()

  const startNew = async (text?: string, att?: Attachment[]) => {
    const id = await mag.newChat(projectId)
    setChatId(id)
    if (text !== undefined) await mag.send(id, text, att)
  }

  const Box = embedded ? 'div' : 'aside'
  return (
    <Box className={embedded ? 'projectchat embedded' : 'projectchat'}>
      <div className="pchead">
        <select value={chat?.id ?? ''} onChange={(e) => setChatId(e.target.value)} aria-label="Chat thread" disabled={!chats.length}>
          {!chats.length && <option value="">No chats yet</option>}
          {chats.map((c) => <option key={c.id} value={c.id}>{c.status === 'running' ? '● ' : ''}{c.title ?? 'Chat'}</option>)}
        </select>
        <button onClick={() => startNew()} title="New thread">New</button>
        <CanvasMenu canvases={canvases} />
        {onClose && <button className="link" onClick={onClose} aria-label="Close chat">×</button>}
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
        <Chat session={chat} sessions={state.sessions} onOpenTask={onOpenTask} placeholder="Talk about the project…" />
      ) : (
        <div className="chatbox">
          <div className="items">
            <p className="muted small">
              Talk about the project: ideas, design, architecture, priorities. The agent reads the code, draws mockups,
              and turns decisions into tasks and notes. It never edits code itself.
            </p>
          </div>
          <Composer
            busy={false}
            placeholder="Talk about the project…"
            commands={chatCommands(chat ?? { projectId, agent: project ? resolveChoice(project, 'chat').agent : 'claude-code' }, state.sessions)}
            onSend={(t, a) => (chat ? mag.send(chat.id, t, a) : startNew(t, a))} />
        </div>
      )}
    </Box>
  )
}
