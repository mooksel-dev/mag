import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { HEIGHT_MESSAGE, TASK_KEY_RE, approvalCommand, findModel, backgroundLabel, canvasDocument, canvasPieces, canvasTheme, chatCommands, linkedCanvasIds, liveSession, resolveChoice, agentAllowed, isSubagent, sessionChoice, sessionJob, resolveRef, turnMeta, interimReplies, uniqueRefs, canRewindSession, filesRestorePoint, rewindPoint, type RewindMode, type RewindScope, type AgentSession, type Attachment, type BackgroundTask, type Canvas, type CanvasPiece, type CanvasRef, type CanvasTheme, type ChatItem, type ChatRef, type ModelChoice, type Project, type Task } from '@mag/core'
import type { AppState } from '../../preload/api'
import { ChoiceChip, ContextGauge, ModelPopover, agentName, useAgents } from './Agents'
import { choiceLabel } from './modelChoice'
import { inputPreview, jobPreview } from './format'
import { useAppliedTheme } from './useTheme'
import { canvasHref, mdSegments, parseCanvasHref } from './markdown'
import { DiagramView, type DiagramItem } from './diagrams/DiagramView'
import { foldEvents, type EventItem } from './conversationCards'
import { IntegrationCard } from './Cards'
import { SearchPalette } from './SearchPalette'
import { RichInput, type KeyHandler, type RichInputHandle } from './RichInput'

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

/** Where ▶ Run of a command block runs (its chat's session) and how its output goes to the agent; null: no Run. */
export const CommandRunner = createContext<{ sessionId: string; send: (text: string) => Promise<void> } | null>(null)

const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'console', 'terminal']

/** A console block's command lines without their "$ " prompts; other blocks as they are. */
const commandOf = (code: string) => (/^\s*\$ /.test(code) ? code.split('\n').filter((l) => /^\s*\$ /.test(l)).map((l) => l.replace(/^\s*\$ /, '')).join('\n') : code).trim()

let runSeq = 0

/**
 * ▶ Run on each shell block under `root` (topic-run-commands): it runs in the user's shell, its output under the block as
 * it comes, ■ stops it, and Send to agent sends the command with its output and exit code to the chat.
 */
function addRunButtons(root: HTMLElement, runner: { sessionId: string; send: (text: string) => Promise<void> }) {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>('pre > code'))) {
    const pre = code.parentElement!
    if (pre.dataset.run || !SHELL_LANGS.some((l) => code.classList.contains(`language-${l}`))) continue
    pre.dataset.run = '1'
    const command = commandOf(code.textContent ?? '')
    if (!command) continue
    const bar = document.createElement('div')
    bar.className = 'runbar'
    const run = document.createElement('button')
    run.type = 'button'
    run.className = 'small runbtn'
    run.textContent = '▶ Run'
    run.title = "Run it in your shell, in the project's first repository"
    bar.append(run)
    pre.after(bar)
    let id: string | null = null
    run.onclick = async () => {
      if (id) return void mag.stopCommand(id)
      id = `run-${++runSeq}-${Date.now()}`
      bar.querySelector('.runout')?.remove()
      bar.querySelector('.runsend')?.remove()
      const out = document.createElement('pre')
      out.className = 'runout'
      bar.append(out)
      run.textContent = '■ Stop'
      let text = ''
      const result = await mag.runCommand(id, runner.sessionId, command, (chunk) => { text += chunk; out.textContent = text; out.scrollTop = out.scrollHeight }).catch((e: Error) => ({ code: null, cwd: '', error: e.message }))
      id = null
      run.textContent = '▶ Run again'
      const status = document.createElement('span')
      status.className = `muted small runstatus${result.code === 0 ? '' : ' failed'}`
      status.textContent = 'error' in result ? result.error : result.code === 0 ? 'done' : `exit ${result.code ?? 'stopped'}`
      const send = document.createElement('button')
      send.type = 'button'
      send.className = 'small runsend'
      send.textContent = 'Send to agent'
      send.onclick = () => {
        send.disabled = true
        const tail = text.length > 20_000 ? `…\n${text.slice(-20_000)}` : text
        void runner.send(`I ran:\n\`\`\`bash\n${command}\n\`\`\`\n${status.textContent}${'cwd' in result && result.cwd ? ` in ${result.cwd}` : ''}:\n\`\`\`\n${tail.trim() || '(no output)'}\n\`\`\``)
      }
      bar.querySelector('.runstatus')?.remove()
      run.after(status, send)
    }
  }
}

/** Colors the code blocks under `root` (not mermaid): by their language, else by a guess; a huge one stays plain. */
async function highlightCode(root: HTMLElement, cancelled: () => boolean) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code:not(.language-mermaid):not(.hljs)')).filter((c) => (c.textContent ?? '').length < 50_000)
  if (!blocks.length) return
  const { default: hljs } = await import('highlight.js/lib/common')
  if (cancelled()) return
  for (const code of blocks) {
    const lang = /\blanguage-([\w+#-]+)/.exec(code.className)?.[1]
    // An unknown language is guessed, as a block without one is.
    if (lang && !hljs.getLanguage(lang)) code.classList.remove(`language-${lang}`)
    hljs.highlightElement(code)
  }
}

/**
 * Markdown with task keys (T-12, T-12.3) as links, ```mermaid blocks as diagrams, other code blocks colored and [title](canvas:<id>) links as
 * canvases (canvas:<id>#<node> focuses a node of a diagram): a link alone on its line shows the canvas in place, one
 * inside text is a link that opens it (see openCanvasLink). `canvases`: the ones it may show; a link to another id
 * was deleted and shows as its title (without `canvases` it stays a link). Agent output is sanitized: it may echo repo
 * or web content.
 */
export function Markdown({ text, onOpenTask, canvases, className = 'md' }: { text: string; onOpenTask?: (key: string) => void; canvases?: CanvasRef[]; className?: string }) {
  const theme = useAppliedTheme()
  const ref = useRef<HTMLDivElement>(null)
  const opener = useContext(CanvasOpener)
  const runner = useContext(CommandRunner)
  // As a string, so only a change in what this text links parses it again.
  const gone = canvases ? linkedCanvasIds(text).filter((id) => !canvases.some((c) => c.id === id)).join(' ') : ''
  // Canvases are React siblings of the HTML chunks, never portals into them: React must own every node it removes.
  const segments = useMemo(
    () =>
      mdSegments(text, (s) => s.replace(KEY_LINK, '$1[$2](#task:$2)'), new Set(gone.split(' '))).map((seg) =>
        seg.kind === 'md' ? { ...seg, html: DOMPurify.sanitize(marked.parse(seg.text, { async: false }) as string) } : seg,
      ),
    [text, gone],
  )
  useEffect(() => {
    let cancelled = false
    if (ref.current) {
      void renderMermaid(ref.current, theme, () => cancelled)
      if (runner) addRunButtons(ref.current, runner)
      void highlightCode(ref.current, () => cancelled)
    }
    return () => { cancelled = true }
  }, [segments, theme, runner])
  return (
    <div
      ref={ref}
      className={className}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') ?? ''
        const link = parseCanvasHref(href)
        if (link) openCanvasLink(link.id, link.node, canvases, opener)
        else if (href.startsWith('#task:')) onOpenTask?.(href.slice(6))
        else if (/^https:\/\//.test(href)) mag.open(href)
      }}
    >
      {segments.map((seg, i) => {
        // A theme change re-renders mermaid from the source, so start from fresh HTML.
        if (seg.kind === 'md') return <div key={`${i}-${theme}`} dangerouslySetInnerHTML={{ __html: seg.html }} />
        const canvas = canvases?.find((c) => c.id === seg.id)
        if (canvas) return <div key={i} className="canvasslot"><CanvasCard key={canvas.version} canvas={canvas} focus={seg.node} /></div>
        return <p key={i}><a href={canvasHref(seg.id, seg.node)}>{seg.title || seg.id}</a></p>
      })}
    </div>
  )
}

/**
 * Opens the canvas a link in markdown points at: a known one in the screen's drawer (CanvasOpener), else, or when the
 * screen has no drawer, in its own window by id.
 */
function openCanvasLink(id: string, node: string | undefined, canvases: CanvasRef[] | undefined, opener: ((canvas: CanvasRef, focus?: string) => void) | null) {
  const canvas = canvases?.find((c) => c.id === id)
  if (canvas && opener) opener(canvas, node)
  else void mag.openWindow({ kind: 'canvas', canvasId: id })
}

const fileUrl = (a: Attachment) => `mag-file://att/${encodeURIComponent(a.path.split(/[\\/]/).pop() ?? '')}`

/**
 * A canvas's content: an HTML page in a sandboxed frame, or a diagram drawn by mag. `height`: of the frame; a diagram
 * takes the height it needs (scrolling past a cap), or fills its box at '100%'. `focus`: a node of a diagram to show.
 * `siblings`: the task's diagrams, for the flows of methods (see DiagramView). A page with `<mag-canvas id>` tags shows
 * the canvases they name in their place, drawn the same way (one-canvas-with-real-diagrams.1); `within`: the ids of the
 * canvases this one is embedded in, outermost first, so it is as tall as its content and a cycle is drawn as a note.
 */
export function CanvasFrame({ canvas, height = 340, focus, siblings, within }: { canvas: CanvasRef; height?: number | string; focus?: string; siblings?: DiagramItem[]; within?: string[] }) {
  const [content, setContent] = useState<Pick<Canvas, 'kind' | 'html' | 'diagram'> | null | undefined>(undefined)
  const theme = useAppliedTheme()
  useEffect(() => {
    mag.getCanvas(canvas.id).then(setContent)
  }, [canvas.id, canvas.version])
  const pieces = useMemo(() => (content?.kind !== 'diagram' && content?.html ? canvasPieces(content.html) : []), [content])
  if (content === undefined) return <div className="muted small">Loading…</div>
  if (content === null && within) return <CanvasNote>Canvas {canvas.id} not found.</CanvasNote>
  if (content?.kind === 'diagram' && content.diagram)
    return (
      <div className={`canvasdiagram${height === '100%' && !within ? ' fill' : ''}`}>
        <DiagramView diagram={content.diagram} focus={focus} siblings={siblings} />
      </div>
    )
  const html = content?.html ?? ''
  const shown = canvasTheme(html, theme)
  const chain = [...(within ?? []), canvas.id]
  if (pieces.some((p) => p.kind === 'embed')) {
    const page = <CanvasPieces pieces={pieces} theme={shown} title={canvas.title} within={chain} />
    return within ? <div className="canvaspage">{page}</div> : <div className="canvasframe canvaspage" style={{ height }}>{page}</div>
  }
  if (within) return <FitFrame html={html} theme={shown} title={canvas.title} />
  // No allow-same-origin: the page can run scripts but cannot reach window.mag. mag's tokens and canvas.css, in the
  // app's theme, so the page looks like the app (prompts-use-the-models-to.7).
  const doc = html ? canvasDocument(html, theme) : ''
  return <iframe className="canvasframe" title={canvas.title} sandbox="allow-scripts allow-popups" srcDoc={doc} style={{ height }} />
}

/** The pieces of a page with embeds: its HTML in frames as tall as their content, each embedded canvas in its place. */
function CanvasPieces({ pieces, theme, title, within }: { pieces: CanvasPiece[]; theme: CanvasTheme; title: string; within: string[] }) {
  return (
    <>
      {pieces.map((p, i) => (p.kind === 'html' ? <FitFrame key={i} html={p.html} theme={theme} title={title} /> : <EmbeddedCanvas key={i} id={p.id} within={within} />))}
    </>
  )
}

/** HTML in a sandboxed frame that grows to its content: the page posts its height (canvasDocument's reportHeight). */
function FitFrame({ html, theme, title }: { html: string; theme: CanvasTheme; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const h = (e.data as Record<string, unknown> | null)?.[HEIGHT_MESSAGE]
      if (e.source === ref.current?.contentWindow && typeof h === 'number' && h >= 0) setHeight(h)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  const doc = useMemo(() => canvasDocument(html, theme, { reportHeight: true }), [html, theme])
  return <iframe ref={ref} className="canvasfit" title={title} sandbox="allow-scripts allow-popups" srcDoc={doc} style={{ height }} />
}

/** The title and version of a canvas, from the app's state; null when there is no such canvas. */
function useCanvasMeta(id: string): CanvasRef | null | undefined {
  const [meta, setMeta] = useState<{ title: string; version: number } | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const pick = (s: AppState) => {
      const c = s.canvases.find((x) => x.id === id)
      if (live) setMeta((was) => (!c ? null : was && was.title === c.title && was.version === c.version ? was : { title: c.title, version: c.version }))
    }
    void mag.getState().then(pick)
    const off = mag.onState(pick)
    return () => {
      live = false
      off()
    }
  }, [id])
  return meta && { id, ...meta }
}

/** A canvas a page embeds by `<mag-canvas id>`; one that embeds itself (a cycle) or is missing is a note. */
function EmbeddedCanvas({ id, within }: { id: string; within: string[] }) {
  const meta = useCanvasMeta(id)
  if (!id) return <CanvasNote>A &lt;mag-canvas&gt; without id.</CanvasNote>
  if (within.includes(id)) return <CanvasNote>Canvas {id} embeds itself here; not drawn again.</CanvasNote>
  if (meta === undefined) return <div className="muted small">Loading…</div>
  if (meta === null) return <CanvasNote>Canvas {id} not found.</CanvasNote>
  return (
    <div className="canvasembed" data-canvas={id}>
      <CanvasFrame key={meta.version} canvas={meta} within={within} />
    </div>
  )
}

function CanvasNote({ children }: { children: ReactNode }) {
  return <div className="callout canvasnote small">{children}</div>
}

/**
 * Opens a canvas in the screen's diagram drawer (redesign-start-screen-big-composer.3): a work's or a discussion's
 * screen provides it. Without one (a pop-out window) a canvas expands to a full-screen overlay.
 */
export const CanvasOpener = createContext<((canvas: CanvasRef, focus?: string) => void) | null>(null)

/**
 * A canvas in a chat or a doc: one line, folded, so a run of them takes little room; ▸ unfolds the preview in place,
 * Sidebar shows it in the screen's drawer (Full screen without one), ⧉ in its own window.
 */
export function CanvasCard({ canvas, latest = true, focus, onOpen }: { canvas: CanvasRef; latest?: boolean; focus?: string; onOpen?: (canvas: CanvasRef, focus?: string) => void }) {
  const [unfolded, setUnfolded] = useState(false)
  const [full, setFull] = useState(false)
  const opener = useContext(CanvasOpener)
  const open = onOpen ?? opener
  return (
    <div className={`canvascard${unfolded && latest ? '' : ' folded'}`}>
      <div className="canvashead">
        {latest ? (
          <button className="canvasfold" aria-expanded={unfolded} title={unfolded ? 'Fold' : 'Show here'} onClick={() => setUnfolded(!unfolded)}>
            <span aria-hidden>{unfolded ? '▾' : '▸'}</span> <span className="title">{canvas.title}</span>
          </button>
        ) : (
          <span className="title">{canvas.title}</span>
        )}
        <span className="muted small">v{canvas.version}</span>
        <div className="grow" />
        {latest && <button className="link" onClick={() => (open ? open(canvas, focus) : setFull(true))}>{open ? 'Sidebar' : 'Full screen'}</button>}
        {latest && <OpenCanvasWindow canvas={canvas} />}
        {!latest && <span className="muted small">revised later, see below</span>}
      </div>
      {latest && unfolded && <CanvasFrame canvas={canvas} focus={focus} />}
      {full && <CanvasOverlay canvas={canvas} focus={focus} onClose={() => setFull(false)} />}
    </div>
  )
}

function OpenCanvasWindow({ canvas }: { canvas: CanvasRef }) {
  return (
    <button className="link" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'canvas', canvasId: canvas.id })}>
      ⧉ Window
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
 * `self`: the chat this is, which it does not reference. `canvases`: the app's; its messages show the project's ones they link.
 * `onOpenSession`: opens a subtopic made by Branch from here.
 */
export function Chat({ session, sessions, canvases, onOpenTask, placeholder, chip, readOnly, cards, name, tasks, onOpenRef, self, onOpenSession }: {
  session: AgentSession
  sessions: AgentSession[]
  canvases: Pick<Canvas, 'id' | 'title' | 'version' | 'projectId'>[]
  onOpenTask?: (key: string) => void
  placeholder?: string
  chip?: ReactNode
  readOnly?: boolean
  cards?: ReactNode
  name?: string
  tasks?: Task[]
  onOpenRef?: (ref: ChatRef) => void
  self?: ChatRef
  onOpenSession?: (id: string) => void
}) {
  const busy = session.status === 'running'
  /** Edit's text for the composer: a new object each edit. */
  const [prefill, setPrefill] = useState<{ text: string } | null>(null)
  const actions = !readOnly && canRewindSession(session)
  /** Rewind or Edit waiting for what it restores (chat-message-actions-rewind-edit.2). */
  const [choosing, setChoosing] = useState<{ n: number; mode: 'rewind' | 'edit' } | null>(null)
  const rewind = (n: number, mode: RewindMode, scope?: RewindScope) => {
    setChoosing(null)
    mag.rewind(session.id, n, mode, scope).then((r) => r.text !== undefined && setPrefill({ text: r.text })).catch((e: Error) => alert(e.message))
  }
  const choice = (n: number) => {
    if (choosing?.n !== n) return null
    const point = filesRestorePoint(session.items, n, choosing.mode)
    const codeOff = !point ? 'Nothing came after this reply' : !point.nativeId ? 'No code checkpoint for this message (an older message)' : null
    return <RewindChoice mode={choosing.mode} codeOff={codeOff} busy={busy} onPick={(scope) => rewind(n, choosing.mode, scope)} onCancel={() => setChoosing(null)} />
  }
  const acts = (n: number, text: string): MessageAction[] => {
    const can = (mode: RewindMode) => actions && !!rewindPoint(session, n, mode)
    const user = session.items[n]?.kind === 'user'
    const branch = (title: string): MessageAction => ({ label: 'Branch from here', icon: 'branch', title, always: true, run: () => void mag.branchFrom(session.id, n).then((c) => onOpenSession?.(c.id)).catch((e: Error) => alert(e.message)) })
    const copy: MessageAction = { label: 'Copy', icon: 'copy', title: 'Copy as markdown', always: true, run: () => void navigator.clipboard.writeText(text) }
    // Branch on a user message forks at the reply before it: there is none before the first one.
    const branchable = user ? !!rewindPoint(session, n, 'edit')?.forkAt : can('rewind')
    return [
      copy,
      ...(user
        ? [
            ...(can('edit') ? [{ label: 'Edit', icon: 'edit', title: 'Drop this message and what follows; its text goes back to the composer', run: () => setChoosing({ n, mode: 'edit' }) } as MessageAction] : []),
            ...(can('retry') ? [{ label: 'Retry', icon: 'retry', title: 'Drop what follows this message and send it again', run: () => rewind(n, 'retry') } as MessageAction] : []),
            ...(actions && branchable ? [branch('A subtopic with the conversation before this message; this topic stays as it is')] : []),
          ]
        : [
            ...(can('rewind') ? [{ label: 'Rewind here', icon: 'rewind', title: 'Drop what came after this reply, from the chat and the agent’s context', run: () => setChoosing({ n, mode: 'rewind' }) } as MessageAction] : []),
            ...(can('retry') ? [{ label: 'Retry', icon: 'retry', title: 'Drop this reply and send the message before it again', run: () => rewind(n, 'retry') } as MessageAction] : []),
            ...(branchable ? [branch('A subtopic with the conversation up to this reply; this topic stays as it is')] : []),
          ]),
    ]
  }
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [session.items.length, busy])
  // Only the last mention of a canvas renders it; earlier ones point forward.
  const lastCanvasAt = new Map<string, number>()
  session.items.forEach((i, n) => i.kind === 'canvas' && lastCanvasAt.set(i.canvas.id, n))
  // What its messages' canvas links may show: the project's canvases, as in the doc.
  const shown = useMemo(() => canvases.filter((c) => c.projectId === session.projectId), [canvases, session.projectId])

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
  const who = name ?? (session.role ? AGENT_NAMES[session.role] ?? session.role : 'agent')
  // ▶ Run in a conversation the user writes in; its output goes to this chat's agent.
  const runner = useMemo(() => (readOnly ? null : { sessionId: session.id, send: (text: string) => mag.send(session.id, text, [], []) }), [session.id, readOnly])

  return (
    <CommandRunner.Provider value={runner}>
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
                <div key={n} className="umsg">
                  <div className="msg user">
                    {i.text && <div className="plain">{i.text}</div>}
                    {i.attachments && <Attachments items={i.attachments} />}
                    {i.refs && <RefChips refs={i.refs} tasks={tasks ?? []} sessions={sessions} onOpen={onOpenRef} />}
                  </div>
                  {i.text && <MessageActions actions={acts(n, i.text)} busy={busy} />}
                  {choice(n)}
                </div>
              )
            case 'assistant': {
              const meta = metaAt.get(n)
              return (
                <AgentReply key={n} name={who} first={first}>
                  {interim.has(n) ? (
                    <InterimReply text={i.text} canvases={shown} onOpenTask={onOpenTask} />
                  ) : (
                    <div className="reply">
                      <Markdown className="msg agent md" text={i.text} canvases={shown} onOpenTask={onOpenTask} />
                      {meta && <div className="turnmeta">{meta}</div>}
                      <MessageActions actions={acts(n, i.text)} busy={busy} />
                      {choice(n)}
                    </div>
                  )}
                </AgentReply>
              )
            }
            case 'canvas':
              // Deleted since: its title stays, as text.
              if (!shown.some((c) => c.id === i.canvas.id)) return <div key={n} className="msg agent">{i.canvas.title}</div>
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
        {session.rewound && !readOnly && (
          <div className="muted small rewound">
            Rewound · <button type="button" className="link small" disabled={busy} title={busy ? 'Stop the agent first' : 'Bring back what the rewind dropped'} onClick={() => void mag.undoRewind(session.id).catch((e: Error) => alert(e.message))}>Undo</button>
          </div>
        )}
        {cards}
        <div ref={end} />
      </div>
      {!!session.background?.length && <BackgroundTasks sessionId={session.id} tasks={session.background} />}
      {!readOnly && <Composer
        busy={busy}
        queue={liveSession(session)}
        placeholder={placeholder ?? 'Answer, push back, ask why…'}
        commands={chatCommands(session, sessions)}
        draftKey={session.id}
        prefill={prefill}
        onSend={(text, att, refs) => mag.send(session.id, text, att, refs)}
        onStop={() => mag.stop(session.id)}
        chip={chip}
        refsFrom={tasks && { tasks, sessions: sessions.filter((s) => s.projectId === session.projectId), self: self ?? { kind: 'topic', id: session.id } }}
      />}
    </div>
    </CommandRunner.Provider>
  )
}

type ActionIcon = 'copy' | 'edit' | 'retry' | 'rewind' | 'branch' | 'done'

interface MessageAction {
  label: string
  icon: ActionIcon
  title: string
  /** Works while the agent works too (Copy, Branch from here); the rest wait for its turn to end. */
  always?: boolean
  run: () => void
}

const ICON_PATHS: Record<ActionIcon, string> = {
  copy: 'M9 9h10v10H9zM5 15V5h10',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  retry: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  rewind: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5M12 8v4l3 2',
  branch: 'M6 4v12M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 8a8 8 0 0 1-8 8H8',
  done: 'M5 12l5 5L20 7',
}

function Icon({ name }: { name: ActionIcon }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

/** A message's actions as icons, shown on hover (chat-message-actions-rewind-edit.1). */
function MessageActions({ actions, busy }: { actions: MessageAction[]; busy: boolean }) {
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(null), 1500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <div className="msgacts">
      {actions.map((a) => {
        const off = busy && !a.always
        const title = off ? 'Stop the agent first' : done === a.label ? 'Copied' : a.title
        return (
          <button key={a.label} type="button" className="iconbtn" disabled={off} title={`${a.label} · ${title}`} aria-label={a.label} onClick={() => { a.run(); if (a.icon === 'copy') setDone(a.label) }}>
            <Icon name={done === a.label ? 'done' : a.icon} />
          </button>
        )
      })}
    </div>
  )
}

const SCOPE_LABELS: Record<RewindScope, string> = { conversation: 'Conversation', code: 'Code', both: 'Both' }

const SCOPE_TITLES: Record<RewindScope, string> = { conversation: 'The chat and the agent’s context; the files stay', code: 'Only the files; the chat stays', both: 'The chat and the files' }

/**
 * What a Rewind or Edit restores: the conversation (the default), the files Claude edited, or both. `codeOff`: why the
 * files cannot be restored here, if they cannot.
 */
function RewindChoice({ mode, codeOff, busy, onPick, onCancel }: { mode: 'rewind' | 'edit'; codeOff: string | null; busy: boolean; onPick: (scope: RewindScope) => void; onCancel: () => void }) {
  const what = mode === 'rewind' ? 'what came after this reply goes from the chat and the agent’s context' : 'this message and what follows go, its text back to the composer'
  return (
    <div className="rewindchoice small">
      <div>Conversation: {what}; Undo brings it back until you send.</div>
      <div className="muted">Code: the files go back to before {mode === 'rewind' ? 'the next message' : 'this message'}. Only Claude’s own file edits, not Bash’s or yours; Undo does not bring them back.</div>
      <div className="rewindbtns">
        {(['conversation', 'code', 'both'] as const).map((s) => {
          const off = busy ? 'Stop the agent first' : s !== 'conversation' ? codeOff : null
          return <button key={s} type="button" className={s === 'conversation' ? 'primary small' : 'small'} autoFocus={s === 'conversation'} disabled={!!off} title={off ?? SCOPE_TITLES[s]} onClick={() => onPick(s)}>{SCOPE_LABELS[s]}</button>
        })}
        <button type="button" className="link small" onClick={onCancel}>Cancel</button>
      </div>
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
function InterimReply({ text, canvases, onOpenTask }: { text: string; canvases?: CanvasRef[]; onOpenTask?: (key: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="interimwrap" onClick={(e) => !(e.target as HTMLElement).closest('a') && setOpen(!open)}>
      <Markdown className={`msg agent md interim${open ? ' open' : ''}`} text={text} canvases={canvases} onOpenTask={onOpenTask} />
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

/**
 * A tool call that waits for the user (an ask-mode integration's, or a GitHub write as a Bash command): Allow / Deny
 * while pending, then its outcome. `who`: the agent, when not this chat's.
 */
export function ApprovalCard({ sessionId, item, who }: { sessionId: string; item: ApprovalItem; who?: string }) {
  // A Bash call (a GitHub write, chat-publishes-to-github-prs.2) shows its whole command: that is what runs on Allow.
  const command = approvalCommand(item)
  return (
    <div className="approval">
      {command !== null ? (
        <>
          <div>{who ? `The ${who}` : 'Agent'} wants to run</div>
          <pre className="input command">{command}</pre>
        </>
      ) : (
        <>
          <div>{who ? `The ${who}` : 'Agent'} wants {item.server ? <><b>{item.server}</b> · {item.tool}</> : <b>{item.tool}</b>}</div>
          <div className="input muted">{inputPreview(item.input, 400)}</div>
        </>
      )}
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
  draftKey,
  prefill,
}: {
  /** Text put into the field (an edited message's); a new object puts it again. */
  prefill?: { text: string } | null
  /** Where its unsent text is kept (a chat's id): it is there again when the user comes back, until it is sent. */
  draftKey?: string
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
  /** The message as markdown, what is sent; `plain` its text, what a /command is read from. */
  const [text, setText] = useState('')
  const [plain, setPlain] = useState('')
  const draft = draftKey && `mag.draft.${draftKey}`
  // Another chat: its own draft (the field is made anew for it, see the key below, and reports that draft).
  const shownDraft = useRef(draft)
  if (shownDraft.current !== draft) {
    shownDraft.current = draft
    setText('')
    setPlain('')
  }
  const keep = (md: string) => {
    if (!draft) return
    try { if (md) localStorage.setItem(draft, md); else localStorage.removeItem(draft) } catch { /* full: the draft is not kept */ }
  }
  const [files, setFiles] = useState<Attachment[]>([])
  const [refs, setRefs] = useState<ChatRef[]>([])
  /** The palette is open; `at`: where the "@" that opened it is in the text (null: the button). */
  const [picking, setPicking] = useState<{ at: number | null } | null>(null)
  const [drag, setDrag] = useState(false)
  const [sel, setSel] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const ta = useRef<RichInputHandle>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (prefill) ta.current?.setMarkdown(prefill.text)
  }, [prefill])

  // "/" + a name being typed (no space yet) opens the menu, filtered by prefix. A command is sent as typed.
  const isCommand = commands.length > 0 && plain.startsWith('/')
  const typed = isCommand ? /^\/(\S*)$/.exec(plain.trimEnd() === plain ? plain : '')?.[1] : undefined
  const matches = typed === undefined ? [] : commands.filter((c) => c.startsWith(typed))
  const menuOpen = matches.length > 0 && !menuClosed
  const pick = (name: string) => ta.current?.setMarkdown(`/${name} `)
  useEffect(() => {
    setSel(0)
    setMenuClosed(false)
  }, [typed])
  useEffect(() => {
    menu.current?.children[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel])

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
    // The "@" that opened the palette gives way to the chip.
    if (picking?.at != null) ta.current?.dropCharBefore('@')
    if (!(refsFrom?.self?.kind === ref.kind && refsFrom.self.id === ref.id)) setRefs((x) => uniqueRefs([...x, ref]))
    ta.current?.focus()
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
    // The draft goes first: the send can replace this field with the chat's own (a topic's first message), which would
    // read the draft back before the send returns.
    const sent = text
    keep('')
    try {
      await onSend(sent.trim(), isCommand ? [] : files, isCommand ? [] : refs)
    } catch (err) {
      console.error(err)
      keep(sent)
      return
    }
    ta.current?.clear()
    setText('')
    setPlain('')
    if (!isCommand) {
      setFiles([])
      setRefs([])
    }
  }
  // Enter sends, except in a code block or a list item with text (a new line or item there; ⌘↵ sends anyway).
  const onKey: KeyHandler = (e, at) => {
    if (e.isComposing) return false
    if (menuOpen) {
      const exact = typed !== undefined && commands.includes(typed)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
        return true
      }
      if (e.key === 'Escape') {
        setMenuClosed(true)
        return true
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
        pick(matches[Math.min(sel, matches.length - 1)])
        return true
      }
    }
    if (e.key !== 'Enter' || e.shiftKey) return false
    if (!(e.metaKey || e.ctrlKey) && (at.inCode || (at.inList && !at.emptyItem))) return false
    if (/^```[\w+#-]*$/.test(plain.split('\n').at(-1) ?? '')) return false
    void submit()
    return true
  }

  const keys = `↵ to send, ⇧↵ for a new line, \`\`\`↵ for code, paste or drop screenshots${commands.length ? ', / for commands' : ''}${refsFrom ? ', @ to reference a chat' : ''}`
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
        <RichInput
          key={draft || undefined}
          ref={ta}
          initial={draft ? (localStorage.getItem(draft) ?? '') : ''}
          placeholder={busy && !queue ? 'Wait for the agent to finish…' : placeholder}
          autoFocus={autoFocus}
          onChange={(md, txt) => { setText(md); setPlain(txt); keep(md) }}
          onKey={onKey}
          onFiles={(imgs) => void add(imgs)}
          onAt={canRef ? () => setPicking({ at: 0 }) : undefined}
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

/**
 * "Opus 5.5 · high · ▮▮▯ 62%" (model-picker-full-model-list.2): the model and effort a session runs on (its own choice,
 * else its role's project default; see sessionChoice) and how full its context is; the popover sets the session's own
 * choice, from its next turn. A subagent's is a plain label: it runs on its parent's process. Without `session` (a
 * new chat, Home) it shows and sets the project's default for chats. `up`: the popover opens above (in a composer).
 */
export function SessionModelChip(props: { project: Project; up?: boolean } & ({ session: AgentSession; tasks: Task[] } | { session?: undefined })) {
  const { project, up } = props
  const agents = useAgents()
  if (!props.session) {
    const choice = resolveChoice(project, 'chat')
    return (
      <ChoiceChip label={choiceLabel(agents, choice)} title="Agent, model and effort of new chats in this project" up={up}>
        <ModelPopover agents={agents} choice={choice} job="chat" onChange={(c) => c && void mag.updateProject(project.id, { agents: { ...project.agents, chat: c } })} />
      </ChoiceChip>
    )
  }
  const { session, tasks } = props
  const job = sessionJob(session, tasks)
  const choice = sessionChoice(project, session, job)
  const fallback = sessionChoice(project, { role: session.role, choice: null }, job)
  // A stored choice the job refuses (Codex on a review) is not what runs: the default is.
  const own = session.choice && agentAllowed(job, session.choice.agent).ok ? session.choice : null
  const models = agents.find((a) => a.id === choice.agent)?.models ?? []
  const ran = findModel(models, session.activeModel) ?? findModel(models, choice.model)
  const window = session.context ? (session.context.window ?? ran?.contextWindow ?? null) : null
  const title = [
    `${agentName(agents, choice.agent)} · ${choice.model ? (findModel(models, choice.model)?.id ?? choice.model) : 'default model'} · effort ${choice.effort ?? 'default'}`,
    own ? 'This session\'s own choice; applies from its next turn' : 'The project default for this role',
    session.activeModel && `Last run: ${session.activeModel}`,
    session.context && `Context: ${session.context.used.toLocaleString()} / ${window ? window.toLocaleString() : '?'} tokens`,
  ].filter(Boolean).join('\n')
  const label = (
    <>
      {choiceLabel(agents, choice, session.activeModel)}
      {session.context && <> · <ContextGauge used={session.context.used} window={window} /></>}
    </>
  )
  const set = (c: ModelChoice | null) => void mag.setSessionChoice(session.id, c).catch((e: Error) => alert(e.message))
  return (
    <ChoiceChip label={label} title={title} up={up}>
      {!isSubagent(session) && <ModelPopover agents={agents} choice={own} fallback={fallback} job={job} onChange={set} />}
    </ChoiceChip>
  )
}
