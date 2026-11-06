import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { TASK_KEY_RE, backgroundLabel, chatCommands, liveSession, resolveChoice, resolveRef, turnMeta, interimReplies, uniqueRefs, type AgentSession, type Attachment, type BackgroundTask, type Canvas, type CanvasRef, type ChatItem, type ChatRef, type Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import { ModelPicker, agentName, useAgents } from './Agents'
import { inputPreview, jobPreview } from './format'
import { useAppliedTheme } from './useTheme'
import { mdSegments } from './markdown'
import { DiagramView, type DiagramItem } from './diagrams/DiagramView'
import { foldEvents, type EventItem } from './conversationCards'
import { IntegrationCard } from './Cards'
import { SearchPalette } from './SearchPalette'

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
 * inline canvases (canvas:<id>#<node> focuses a node of a diagram). Agent output is sanitized: it may echo repo or web content.
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
        return canvas ? <div key={i} className="canvasslot"><CanvasCard key={canvas.version} canvas={canvas} focus={seg.node} /></div> : <p key={i}>{seg.title}</p>
      })}
    </div>
  )
}

const fileUrl = (a: Attachment) => `mag-file://att/${encodeURIComponent(a.path.split(/[\\/]/).pop() ?? '')}`

/**
 * A canvas's content: an HTML page in a sandboxed frame, or a diagram drawn by mag. `height`: of the frame; a diagram
 * takes the height it needs (scrolling past a cap), or fills its box at '100%'. `focus`: a node of a diagram to show.
 * `siblings`: the task's diagrams, for the flows of methods (see DiagramView).
 */
export function CanvasFrame({ canvas, height = 340, focus, siblings }: { canvas: CanvasRef; height?: number | string; focus?: string; siblings?: DiagramItem[] }) {
  const [content, setContent] = useState<Pick<Canvas, 'kind' | 'html' | 'diagram'> | null | undefined>(undefined)
  useEffect(() => {
    mag.getCanvas(canvas.id).then(setContent)
  }, [canvas.id, canvas.version])
  if (content === undefined) return <div className="muted small">Loading…</div>
  if (content?.kind === 'diagram' && content.diagram)
    return (
      <div className={`canvasdiagram${height === '100%' ? ' fill' : ''}`}>
        <DiagramView diagram={content.diagram} focus={focus} siblings={siblings} />
      </div>
    )
  // No allow-same-origin: the page can run scripts but cannot reach window.mag.
  return <iframe className="canvasframe" title={canvas.title} sandbox="allow-scripts allow-popups" srcDoc={content?.html ?? ''} style={{ height }} />
}

/**
 * Opens a canvas in the screen's diagram drawer (redesign-start-screen-big-composer.3): a work's or a discussion's
 * screen provides it. Without one (a pop-out window) a canvas expands to a full-screen overlay.
 */
export const CanvasOpener = createContext<((canvas: CanvasRef, focus?: string) => void) | null>(null)

/** A canvas in a chat or a doc: its preview; Open shows it in the drawer (or the overlay), ⧉ in its own window. */
export function CanvasCard({ canvas, latest = true, focus, onOpen }: { canvas: CanvasRef; latest?: boolean; focus?: string; onOpen?: (canvas: CanvasRef, focus?: string) => void }) {
  const [full, setFull] = useState(false)
  const opener = useContext(CanvasOpener)
  const open = onOpen ?? opener
  return (
    <div className="canvascard">
      <div className="canvashead">
        <span className="title">{canvas.title}</span>
        <span className="muted small">v{canvas.version}</span>
        <div className="grow" />
        {latest && !open && <OpenCanvasWindow canvas={canvas} />}
        {latest && <button className="link" onClick={() => (open ? open(canvas, focus) : setFull(true))}>{open ? 'Open' : 'Expand'}</button>}
      </div>
      {latest ? <CanvasFrame canvas={canvas} focus={focus} /> : <div className="muted small pad">Revised later; see the newer version below.</div>}
      {full && <CanvasOverlay canvas={canvas} focus={focus} onClose={() => setFull(false)} />}
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
export function CanvasOverlay({ canvas, focus, onClose }: { canvas: CanvasRef; focus?: string; onClose: () => void }) {
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
        <CanvasFrame canvas={canvas} height="100%" focus={focus} />
      </div>
    </div>
  )
}

/** The small name over an agent's replies, by its role. */
const AGENT_NAMES: Record<string, string> = { chat: 'agent', groomer: 'owner', developer: 'developer', reviewer: 'reviewer', architect: 'architect' }

/**
 * A session's chat (redesign-start-screen-big-composer.4): the user's messages as bubbles, the agent's replies as text
 * under a small name, runs of events (tools, mag's notices and jobs) folded into one thin line, cards for the rest.
 * `readOnly`: an agent's log, without a composer (ux-odna-rozmova-na-robotu.2): the user talks to the work's owner only.
 * `cards`: what the work needs from the user, after the last item. `name`: over the agent's replies (default by role).
 * `tasks`: the project's; with them the composer references chats ("@") and a bubble's ref chips open with `onOpenRef`.
 * `self`: the chat this is, which it does not reference.
 */
export function Chat({ session, sessions, onOpenTask, placeholder, chip, readOnly, cards, name, tasks, onOpenRef, self }: {
  session: AgentSession
  sessions: AgentSession[]
  onOpenTask?: (key: string) => void
  placeholder?: string
  chip?: ReactNode
  readOnly?: boolean
  cards?: ReactNode
  name?: string
  tasks?: Task[]
  onOpenRef?: (ref: ChatRef) => void
  self?: ChatRef
}) {
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

  // Replies followed by another one in the same turn are interim: muted and clamped, so the turn reads as one answer.
  const interim = interimReplies(session.items)

  // Runs of events render as one collapsible line; n = index of the (first) item, used as key.
  const lines = foldEvents(session.items)
  const who = name ?? AGENT_NAMES[session.role] ?? session.role

  return (
    <div className="chatbox">
      <div className="items">
        {lines.map((line, k) => {
          if (line.kind === 'events') return <EventLine key={line.n} label={line.label} mark={line.mark} items={line.items.map((x) => x.item)} />
          const { n, item: i } = line
          // The name goes over the first reply of a run of replies.
          const prev = lines[k - 1]
          const first = !(prev?.kind === 'item' && prev.item.kind === 'assistant')
          switch (i.kind) {
            case 'user':
              return (
                <div key={n} className="msg user">
                  {i.text && <div className="plain">{i.text}</div>}
                  {i.attachments && <Attachments items={i.attachments} />}
                  {i.refs && <RefChips refs={i.refs} tasks={tasks ?? []} sessions={sessions} onOpen={onOpenRef} />}
                </div>
              )
            case 'assistant': {
              const meta = metaAt.get(n)
              return (
                <AgentReply key={n} name={who} first={first}>
                  {interim.has(n) ? (
                    <InterimReply text={i.text} onOpenTask={onOpenTask} />
                  ) : (
                    <div className="reply">
                      <Markdown className="msg agent md" text={i.text} onOpenTask={onOpenTask} />
                      {meta && <div className="turnmeta">{meta}</div>}
                    </div>
                  )}
                </AgentReply>
              )
            }
            case 'canvas':
              return <CanvasCard key={n} canvas={i.canvas} latest={lastCanvasAt.get(i.canvas.id) === n} />
            case 'result':
              // An ok end is an event (foldEvents); only a failed turn shows.
              return <div key={n} className="small err">Turn failed</div>
            case 'error':
              return <div key={n} className="msg error">{i.text}</div>
            case 'approval':
              return <ApprovalCard key={n} sessionId={session.id} item={i} />
            case 'integration':
              return <IntegrationCard key={n} sessionId={session.id} item={i} />
          }
        })}
        {busy && <div className="muted small">Agent is working…</div>}
        {cards}
        <div ref={end} />
      </div>
      {!!session.background?.length && <BackgroundTasks sessionId={session.id} tasks={session.background} />}
      {!readOnly && <Composer
        busy={busy}
        queue={liveSession(session)}
        placeholder={placeholder ?? 'Answer, push back, ask why…'}
        commands={chatCommands(session, sessions)}
        onSend={(text, att, refs) => mag.send(session.id, text, att, refs)}
        onStop={() => mag.stop(session.id)}
        chip={chip}
        refsFrom={tasks && { tasks, sessions: sessions.filter((s) => s.projectId === session.projectId), self: self ?? { kind: 'topic', id: session.id } }}
      />}
    </div>
  )
}

/** An agent's reply: a small avatar and name over the first of a run of replies, the next ones aligned under it. */
function AgentReply({ name, first, children }: { name: string; first: boolean; children: ReactNode }) {
  return (
    <div className={`agentmsg${first ? '' : ' cont'}`}>
      <span className="av" aria-hidden>{first ? name[0]?.toUpperCase() : ''}</span>
      <div className="agb">
        {first && <div className="agn">{name}</div>}
        {children}
      </div>
    </div>
  )
}

/** An interim reply: two muted lines; a click (not on a link) expands or collapses it. */
function InterimReply({ text, onOpenTask }: { text: string; onOpenTask?: (key: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="interimwrap" onClick={(e) => !(e.target as HTMLElement).closest('a') && setOpen(!open)}>
      <Markdown className={`msg agent md interim${open ? ' open' : ''}`} text={text} onOpenTask={onOpenTask} />
    </div>
  )
}

type JobItem = Extract<ChatItem, { kind: 'job' }>

/** mag's job for the agent, not the user's message: "⚙ <title>" and its first line; a click shows the whole job. */
function JobCard({ item }: { item: JobItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="jobcard">
      <button className="jobhead" aria-expanded={open} title={open ? 'Hide the job' : 'Show the whole job mag gave the agent'} onClick={() => setOpen((o) => !o)}>
        <span>⚙ <b>{item.title}</b></span>
        {!open && <span className="muted small">{jobPreview(item.text)}</span>}
      </button>
      {open && <pre className="jobtext">{item.text}</pre>}
    </div>
  )
}
type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

const APPROVAL_STATUS: Record<ApprovalItem['status'], string> = { pending: 'Waiting for you', allowed: 'Allowed', denied: 'Denied', expired: 'Expired: the run ended first' }

/** An ask-mode integration call: Allow / Deny while pending, then its outcome. `who`: the agent, when not this chat's. */
export function ApprovalCard({ sessionId, item, who }: { sessionId: string; item: ApprovalItem; who?: string }) {
  return (
    <div className="approval">
      <div>{who ? `The ${who}` : 'Agent'} wants <b>{item.server}</b> · {item.tool}</div>
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

/**
 * A run of events as one thin line ("▸ x.3 started · PR ready · update_doc ×2"); it expands to a line per event, a job
 * to its card. A failed or running tool shows through when folded.
 */
function EventLine({ label, mark, items }: { label: string; mark: string; items: EventItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="eventline">
      <button className="eventrow" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={label}>
        <span className="eventlabel">{open ? '▾' : '▸'} {mark && <span className={mark === '✗' ? 'err' : ''}>{mark} </span>}{label}</span>
      </button>
      {open && (
        <div className="eventitems">
          {items.map((t, i) =>
            t.kind === 'tool' ? <div key={i} className="tool">{toolMark(t.ok)} {t.name} <span className="muted">{t.summary}</span></div>
            : t.kind === 'job' ? <JobCard key={i} item={t} />
            : t.kind === 'notice' ? <div key={i} className="notice muted small">{t.text}</div>
            : null,
          )}
        </div>
      )}
    </div>
  )
}

/** "▸ 1 background task · Monitor" above the composer; expands to one line per task, each with its own stop. */
function BackgroundTasks({ sessionId, tasks }: { sessionId: string; tasks: BackgroundTask[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bgtasks">
      <button className="toolsrow" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {backgroundLabel(tasks)}
      </button>
      {open && tasks.map((t) => (
        <div key={t.id} className="bgtask">
          <span>{t.name}</span>
          <span className="muted small">{t.id}</span>
          <div className="grow" />
          <button type="button" className="iconbtn stop" onClick={() => void mag.stopBackground(sessionId, t.id)} title={`Stop ${t.name}`} aria-label={`Stop ${t.name}`}>■</button>
        </div>
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

/**
 * Referenced chats as chips: the title, an Archived mark; a click opens the chat (`onOpen`), × removes it (`onRemove`).
 * A ref to a deleted chat shows as one.
 */
function RefChips({ refs, tasks, sessions, onOpen, onRemove }: { refs: ChatRef[]; tasks: Task[]; sessions: AgentSession[]; onOpen?: (ref: ChatRef) => void; onRemove?: (ref: ChatRef) => void }) {
  return (
    <div className="refchips">
      {refs.map((r) => {
        const t = resolveRef(r, tasks, sessions)
        const label = t ? `${t.key ? `${t.key} · ` : ''}${t.title}` : 'Deleted chat'
        return (
          <span key={`${r.kind}:${r.id}`} className={`refchip${t ? '' : ' gone'}`}>
            <button type="button" className="link" disabled={!t || !onOpen} title={t ? `Open ${label}` : undefined} onClick={() => onOpen?.(r)}>
              @ {label}{t?.archived && <span className="sparch">Archived</span>}
            </button>
            {onRemove && <button type="button" className="x" aria-label={`Remove ${label}`} onClick={() => onRemove(r)}>×</button>}
          </span>
        )
      })}
    </div>
  )
}

/** Composers that take refs, the open conversation's last: the row menu's "Reference in current chat" adds to it. */
const refTargets: { self: ChatRef | undefined; add: (ref: ChatRef) => void }[] = []

/** Whether "Reference in current chat" can add `ref`: a conversation's composer is open and it is another chat. */
export function canReference(ref: ChatRef): boolean {
  const target = refTargets.at(-1)
  return !!target && !(target.self?.kind === ref.kind && target.self.id === ref.id)
}

/** The row menu's "Reference in current chat": a chip in the open conversation's composer. */
export function referenceInCurrentChat(ref: ChatRef) {
  if (canReference(ref)) refTargets.at(-1)!.add(ref)
}

export function Composer({
  busy,
  queue = false,
  placeholder,
  commands = [],
  onSend,
  onStop,
  chip,
  intent,
  onFiles,
  autoFocus,
  refsFrom,
}: {
  busy: boolean
  /** Messages may be sent while busy: the agent gets them in its current turn (live sessions). */
  queue?: boolean
  placeholder: string
  /** Slash commands to offer after "/", without the slash; empty = text starting with "/" is plain text. */
  commands?: string[]
  /** `refs`: the chats referenced ("@"), only with refsFrom. */
  onSend: (text: string, attachments: Attachment[], refs: ChatRef[]) => Promise<void>
  onStop?: () => void
  /** Shown next to the attach button, e.g. the model chip. */
  chip?: ReactNode
  /** What send will do with the text, next to the send button (Home: the route chip). */
  intent?: (text: string) => ReactNode
  /** Files dropped or picked go here first; true = taken (Home: a review's .zip imports), else they are attached. */
  onFiles?: (files: File[]) => boolean
  autoFocus?: boolean
  /** The project's chats to reference: "@" or the @ button pick one (SearchPalette) as a chip; `self` is this chat. */
  refsFrom?: { tasks: Task[]; sessions: AgentSession[]; self?: ChatRef }
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [refs, setRefs] = useState<ChatRef[]>([])
  /** The palette is open; `at`: where the "@" that opened it is in the text (null: the button). */
  const [picking, setPicking] = useState<{ at: number | null } | null>(null)
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

  const canRef = !!refsFrom
  const selfKey = refsFrom?.self && `${refsFrom.self.kind}:${refsFrom.self.id}`
  useEffect(() => {
    if (!canRef) return
    const target = { self: refsFrom?.self, add: (ref: ChatRef) => { setRefs((x) => uniqueRefs([...x, ref])); ta.current?.focus() } }
    refTargets.push(target)
    return () => { refTargets.splice(refTargets.indexOf(target), 1) }
    // The target changes only with the chat it is; add uses setters and a ref.
  }, [canRef, selfKey])
  const pickRef = (ref: ChatRef) => {
    const at = picking?.at
    // The "@" that opened the palette gives way to the chip.
    if (at != null && text[at] === '@') setText(text.slice(0, at) + text.slice(at + 1))
    if (!(refsFrom?.self?.kind === ref.kind && refsFrom.self.id === ref.id)) setRefs((x) => uniqueRefs([...x, ref]))
    ta.current?.focus()
  }
  const onText = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const at = e.target.selectionStart - 1
    // "@" typed at the start or after a space opens the palette.
    if (canRef && value.length === text.length + 1 && value[at] === '@' && (at === 0 || /\s/.test(value[at - 1]))) setPicking({ at })
    setText(value)
  }

  const add = async (list: FileList | File[]) => {
    if (onFiles?.(Array.from(list))) return
    for (const f of Array.from(list)) {
      const path = mag.pathForFile(f)
      const a = path
        ? await mag.saveAttachment({ name: f.name, path })
        : await mag.saveAttachment({ name: f.name || `pasted-${Date.now()}.png`, bytes: new Uint8Array(await f.arrayBuffer()) })
      setFiles((x) => [...x, a])
    }
  }
  const submit = async () => {
    if ((busy && !queue) || (!text.trim() && !files.length && !refs.length)) return
    // Files and refs never go with a command; they stay for the next message. A failed send keeps all; the caller shows why.
    try {
      await onSend(text.trim(), isCommand ? [] : files, isCommand ? [] : refs)
    } catch (err) {
      console.error(err)
      return
    }
    setText('')
    if (!isCommand) {
      setFiles([])
      setRefs([])
    }
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

  const keys = `↵ to send, ⇧↵ for a new line, paste or drop screenshots${commands.length ? ', / for commands' : ''}${refsFrom ? ', @ to reference a chat' : ''}`
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
        {refsFrom && refs.length > 0 && <RefChips refs={refs} tasks={refsFrom.tasks} sessions={refsFrom.sessions} onRemove={(r) => setRefs((x) => x.filter((y) => y !== r))} />}
        {files.length > 0 && <Attachments items={files} onRemove={(a) => setFiles((x) => x.filter((f) => f !== a))} />}
        <textarea
          ref={ta}
          value={text}
          onChange={onText}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files)
            if (imgs.length) { e.preventDefault(); void add(imgs) }
          }}
          onKeyDown={onKeyDown}
          placeholder={busy && !queue ? 'Wait for the agent to finish…' : placeholder}
          rows={2}
          aria-label="Message"
          autoFocus={autoFocus}
        />
        <div className="composerbar">
          <button type="button" className="iconbtn" title={isCommand ? 'Commands take no files' : 'Attach files'} aria-label="Attach files" disabled={isCommand} onClick={() => picker.current?.click()}>＋</button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
          {refsFrom && <button type="button" className="iconbtn" title={isCommand ? 'Commands take no references' : 'Reference another chat: its summary goes with the message (or type @)'} aria-label="Reference a chat" disabled={isCommand} onClick={() => setPicking({ at: null })}>@</button>}
          {chip}
          <div className="grow" />
          {commands.length > 0 && <span className="muted small nowrap">/ commands</span>}
          {intent?.(text)}
          {busy && onStop && <button type="button" className="iconbtn stop" onClick={onStop} title="Stop the agent" aria-label="Stop">■</button>}
          {(!busy || !onStop || queue) && (
            <button type="submit" className="iconbtn send" disabled={busy && !queue} title={`Send (${keys})`} aria-label="Send">↑</button>
          )}
        </div>
      </div>
      {/* Out of the form: the palette's rows are buttons. */}
      {picking && refsFrom && createPortal(
        <SearchPalette tasks={refsFrom.tasks} sessions={refsFrom.sessions} placeholder="Reference a chat or a work, archive included" onPick={pickRef} onClose={() => { setPicking(null); ta.current?.focus() }} />,
        document.body,
      )}
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

/** "Claude Code · Opus ▾": the project chat's agent and model, picked in a popover. */
export function ModelChip({ project, activeModel }: { project: AppState['projects'][number]; activeModel?: string }) {
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
