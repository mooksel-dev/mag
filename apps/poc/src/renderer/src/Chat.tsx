import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { TASK_KEY_RE, chatCommands, liveSession, resolveChoice, turnMeta, type AgentSession, type Attachment, type CanvasRef, type ChatItem } from '@mag/core'
import type { AppState } from '../../preload/api'
import { ModelPicker, agentName, useAgents } from './Agents'
import { inputPreview, threadTime } from './format'
import { useAppliedTheme } from './useTheme'
import { mdSegments } from './markdown'

const mag = window.mag
// A trailing period is not part of the key: "see T-1." links T-1.
const KEY_LINK = new RegExp(`(^|[^\\w/[-])(${TASK_KEY_RE.source})(?![\\w-]|\\.\\d)`, 'g')

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
  // Canvases are React siblings of the HTML chunks, never portals into them: React must own every node it removes.
  const segments = useMemo(
    () =>
      mdSegments(text, (s) => s.replace(KEY_LINK, '$1[$2](#task:$2)')).map((seg) =>
        seg.kind === 'md' ? { ...seg, html: DOMPurify.sanitize(marked.parse(seg.text, { async: false }) as string) } : seg,
      ),
    [text],
  )
  useEffect(() => {
    let cancelled = false
    if (ref.current) void renderMermaid(ref.current, theme, () => cancelled)
    return () => { cancelled = true }
  }, [segments, theme])
  return (
    <div
      ref={ref}
      className={className}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (href.startsWith('#task:')) onOpenTask?.(href.slice(6))
        else if (/^https:\/\//.test(href)) mag.open(href)
      }}
    >
      {segments.map((seg, i) => {
        // A theme change re-renders mermaid from the source, so start from fresh HTML.
        if (seg.kind === 'md') return <div key={`${i}-${theme}`} dangerouslySetInnerHTML={{ __html: seg.html }} />
        const canvas = canvases?.find((c) => c.id === seg.id)
        return canvas ? <div key={i} className="canvasslot"><CanvasCard key={canvas.version} canvas={canvas} /></div> : <p key={i}>{seg.title}</p>
      })}
    </div>
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
        {latest && <OpenCanvasWindow canvas={canvas} />}
        {latest && <button className="link" onClick={() => setFull(true)}>Expand</button>}
      </div>
      {latest ? <CanvasFrame canvas={canvas} /> : <div className="muted small pad">Revised later; see the newer version below.</div>}
      {full && <CanvasOverlay canvas={canvas} onClose={() => setFull(false)} />}
    </div>
  )
}

function OpenCanvasWindow({ canvas }: { canvas: CanvasRef }) {
  return (
    <button className="link" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: canvas.id })}>
      ⧉ Open in window
    </button>
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
          <OpenCanvasWindow canvas={canvas} />
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
      <button className="iconbtn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" aria-label="Canvases" title="Canvases">
        ▣<span className="cnt">{canvases.length}</span>
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

export function Chat({ session, sessions, onOpenTask, placeholder, chip }: { session: AgentSession; sessions: AgentSession[]; onOpenTask?: (key: string) => void; placeholder?: string; chip?: ReactNode }) {
  const busy = session.status === 'running'
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [session.items.length, busy])
  // Only the last mention of a canvas renders it; earlier ones point forward.
  const lastCanvasAt = new Map<string, number>()
  session.items.forEach((i, n) => i.kind === 'canvas' && lastCanvasAt.set(i.canvas.id, n))

  // A turn's model, cost and duration go under its last reply, shown on hover.
  const metaAt = new Map<number, string>()
  let lastReply = -1
  session.items.forEach((i, n) => {
    if (i.kind === 'assistant') lastReply = n
    else if (i.kind === 'result') {
      if (lastReply >= 0) metaAt.set(lastReply, turnMeta(session.items, n, session.activeModel))
      lastReply = -1
    }
  })

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
            case 'assistant': {
              const meta = metaAt.get(n)
              if (!meta) return <Markdown key={n} className="msg agent md" text={i.text} onOpenTask={onOpenTask} />
              return (
                <div key={n} className="reply">
                  <Markdown className="msg agent md" text={i.text} onOpenTask={onOpenTask} />
                  <div className="turnmeta">{meta}</div>
                </div>
              )
            }
            case 'canvas':
              return <CanvasCard key={n} canvas={i.canvas} latest={lastCanvasAt.get(i.canvas.id) === n} />
            case 'result':
              return i.ok ? null : <div key={n} className="small err">Turn failed</div>
            case 'error':
              return <div key={n} className="msg error">{i.text}</div>
            case 'notice':
              return <div key={n} className="notice muted small">{i.text}</div>
            case 'approval':
              return <ApprovalCard key={n} sessionId={session.id} item={i} />
          }
        })}
        {busy && <div className="muted small">Agent is working…</div>}
        <div ref={end} />
      </div>
      <Composer
        busy={busy}
        queue={liveSession(session)}
        placeholder={placeholder ?? 'Answer, push back, ask why…'}
        commands={chatCommands(session, sessions)}
        onSend={(text, att) => mag.send(session.id, text, att)}
        onStop={() => mag.stop(session.id)}
        chip={chip}
      />
    </div>
  )
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

const APPROVAL_STATUS: Record<ApprovalItem['status'], string> = { pending: 'Waiting for you', allowed: 'Allowed', denied: 'Denied', expired: 'Expired: the run ended first' }

/** An ask-mode integration call: Allow / Deny while pending, then its outcome. */
function ApprovalCard({ sessionId, item }: { sessionId: string; item: ApprovalItem }) {
  return (
    <div className="approval">
      <div>Agent wants <b>{item.server}</b> · {item.tool}</div>
      <div className="input muted">{inputPreview(item.input, 400)}</div>
      {item.status === 'pending' ? (
        <div className="actions">
          <button onClick={() => mag.decideApproval(sessionId, item.id, false)}>Deny</button>
          <button className="primary" onClick={() => mag.decideApproval(sessionId, item.id, true)}>Allow</button>
        </div>
      ) : (
        <div className="muted small">{APPROVAL_STATUS[item.status]}</div>
      )}
    </div>
  )
}

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
            <button type="button" className="link" onClick={() => mag.open(a.path)}>📎 {a.name}</button>
          )}
          {onRemove && <button type="button" className="x" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a)}>×</button>}
        </span>
      ))}
    </div>
  )
}

export function Composer({
  busy,
  queue = false,
  placeholder,
  commands = [],
  onSend,
  onStop,
  chip,
}: {
  busy: boolean
  /** Messages may be sent while busy: the agent gets them in its current turn (live sessions). */
  queue?: boolean
  placeholder: string
  /** Slash commands to offer after "/", without the slash; empty = text starting with "/" is plain text. */
  commands?: string[]
  onSend: (text: string, attachments: Attachment[]) => Promise<void>
  onStop?: () => void
  /** Shown next to the attach button, e.g. the model chip. */
  chip?: ReactNode
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
    if ((busy && !queue) || (!text.trim() && !files.length)) return
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

  const keys = `↵ to send, ⇧↵ for a new line, paste or drop screenshots${commands.length ? ', / for commands' : ''}`
  return (
    <form
      className="composer"
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
      <div className={`composerbox ${drag ? 'drag' : ''}`}>
        {files.length > 0 && <Attachments items={files} onRemove={(a) => setFiles((x) => x.filter((f) => f !== a))} />}
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files)
            if (imgs.length) { e.preventDefault(); void add(imgs) }
          }}
          onKeyDown={onKeyDown}
          placeholder={busy && !queue ? 'Wait for the agent to finish…' : placeholder}
          rows={1}
          aria-label="Message"
        />
        <div className="composerbar">
          <button type="button" className="iconbtn" title={isCommand ? 'Commands take no files' : 'Attach files'} aria-label="Attach files" disabled={isCommand} onClick={() => picker.current?.click()}>＋</button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
          {chip}
          <div className="grow" />
          {commands.length > 0 && <span className="muted small nowrap">/ commands</span>}
          {busy && onStop && <button type="button" className="iconbtn stop" onClick={onStop} title="Stop the agent" aria-label="Stop">■</button>}
          {(!busy || !onStop || queue) && (
            <button type="submit" className="iconbtn send" disabled={busy && !queue} title={`Send (${keys})`} aria-label="Send">↑</button>
          )}
        </div>
      </div>
    </form>
  )
}

/** Closes a popover on Escape or a mousedown outside `ref`. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref, setOpen])
}

/** Thread title as a button; opens the list of threads with "New chat" at the bottom. */
function ThreadPicker({ chats, current, onPick, onNew }: { chats: AgentSession[]; current: AgentSession | null; onPick: (id: string) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, setOpen)
  const live = (c: AgentSession) => c.status === 'running'
  return (
    <div ref={box} className="threadpicker">
      <button className="threadbtn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox" title={current?.title}>
        {current && live(current) && <span className="dot live" />}
        <span className="title">{current?.title ?? 'New chat'}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="threadlist" role="listbox" aria-label="Chat threads">
          {chats.map((c) => (
            <button key={c.id} role="option" aria-selected={c === current} className={c === current ? 'on' : ''} onClick={() => { onPick(c.id); setOpen(false) }}>
              {live(c) && <span className="dot live" />}
              <span className="title" title={c.title}>{c.title ?? 'Chat'}</span>
              <span className="muted small">{threadTime(c.createdAt)}</span>
            </button>
          ))}
          <button className="newthread" onClick={() => { onNew(); setOpen(false) }}>＋ New chat</button>
        </div>
      )}
    </div>
  )
}

/** "Claude Code · Opus ▾": the project chat's agent and model, picked in a popover. */
function ModelChip({ project, activeModel }: { project: AppState['projects'][number]; activeModel?: string }) {
  const agents = useAgents()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, setOpen)
  const choice = resolveChoice(project, 'chat')
  const model = choice.model ? (agents.find((a) => a.id === choice.agent)?.models.find((m) => m.id === choice.model)?.label ?? choice.model) : 'Default'
  return (
    <div ref={box} className="modelchip">
      <button type="button" className="chip" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={activeModel ? `Last run: ${activeModel}` : 'Agent and model for project chats'}>
        {agentName(agents, choice.agent)} · {model} ▾
      </button>
      {open && (
        <div className="chippop">
          <ModelPicker agents={agents} label="Chat" choice={choice} onChange={(c) => mag.updateProject(project.id, { agents: { ...project.agents, chat: c } })} />
        </div>
      )}
    </div>
  )
}

/** Project-level conversation: a closable aside next to every tab, or `embedded` in the task screen's chat panel. */
export function ProjectChat({ projectId, state, onOpenTask, onClose, embedded }: { projectId: string; state: AppState; onOpenTask: (key: string) => void; onClose?: () => void; embedded?: boolean }) {
  const chats = state.sessions.filter((s) => s.projectId === projectId && s.role === 'chat').sort((a, b) => b.createdAt - a.createdAt)
  const [chatId, setChatId] = useState<string | null>(null)
  const chat = chats.find((c) => c.id === chatId) ?? chats[0] ?? null
  const project = state.projects.find((p) => p.id === projectId)
  const canvases = state.canvases.filter((c) => c.projectId === projectId && c.taskId === null).sort((a, b) => b.updatedAt - a.updatedAt)

  const startNew = async (text?: string, att?: Attachment[]) => {
    const id = await mag.newChat(projectId)
    setChatId(id)
    if (text !== undefined) await mag.send(id, text, att)
  }

  const chip = project && <ModelChip project={project} activeModel={chat?.activeModel} />
  const Box = embedded ? 'div' : 'aside'
  return (
    <Box className={embedded ? 'projectchat embedded' : 'projectchat'}>
      <div className="pchead">
        <ThreadPicker chats={chats} current={chat} onPick={setChatId} onNew={() => void startNew()} />
        <button className="iconbtn" onClick={() => startNew()} aria-label="New chat" title="New chat">✎</button>
        <CanvasMenu canvases={canvases} />
        {onClose && <button className="iconbtn" onClick={onClose} aria-label="Close chat" title="Close">✕</button>}
      </div>
      {chat && chat.items.length > 0 ? (
        <Chat session={chat} sessions={state.sessions} onOpenTask={onOpenTask} placeholder="Message…" chip={chip} />
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
            placeholder="Message…"
            commands={chatCommands(chat ?? { projectId, agent: project ? resolveChoice(project, 'chat').agent : 'claude-code' }, state.sessions)}
            onSend={(t, a) => (chat ? mag.send(chat.id, t, a) : startNew(t, a))}
            chip={chip}
          />
        </div>
      )}
    </Box>
  )
}
