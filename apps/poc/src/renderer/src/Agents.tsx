import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { agentAllowed, findModel, type AgentInfo, type AgentJob, type AgentKind, type ModelChoice } from '@mag/core'
import { choiceLabel, effortLabel, effortsFor, fillPercent, formatTokens, gaugeLevel, keptEffort } from './modelChoice'
import { popupPlace } from './popupPlace'

let catalogue: Promise<AgentInfo[]> | null = null

/** Provider catalogue, loaded once per window. */
export function useAgents(): AgentInfo[] {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  useEffect(() => {
    let live = true
    catalogue ??= window.mag.listAgents()
    catalogue.then((a) => live && setAgents(a)).catch(() => (catalogue = null))
    return () => {
      live = false
    }
  }, [])
  return agents
}

export function agentName(agents: AgentInfo[], id: AgentKind) {
  return agents.find((a) => a.id === id)?.displayName ?? id
}

/** Closes a popover on Escape or a mousedown outside `ref`. */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void) {
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

/**
 * A chip that opens a popover (`children`), fixed to the window where it fits (popupPlace: below, else above, kept
 * inside the window's edges), so a narrow drawer or a header that clips does not cut it; it closes on a scroll or
 * resize outside it. Without children it is a plain label, e.g. a subagent's model, which nobody sets.
 */
export function ChoiceChip({ label, title, children }: { label: ReactNode; title: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  useDismiss(open, box, setOpen)
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return setPlace(null)
    setPlace(popupPlace(btn.current.getBoundingClientRect(), { width: pop.current.offsetWidth, height: pop.current.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }))
  }, [open])
  // Once placed (hidden while measured, it can't take focus): the chosen row, else the first, so the arrows start there.
  useEffect(() => {
    const rows = place && pop.current ? pop.current.querySelectorAll<HTMLElement>('[role=option]:not(:disabled)') : null
    if (rows) (pop.current!.querySelector<HTMLElement>('[role=option][aria-selected=true]:not(:disabled)') ?? rows[0])?.focus()
  }, [place])
  useEffect(() => {
    if (!open) return
    const onMove = (e: Event) => { if (!(e.target instanceof Node && pop.current?.contains(e.target))) setOpen(false) }
    document.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])
  if (!children) return <span className="modelchip"><span className="chip static" title={title}>{label}</span></span>
  return (
    <div ref={box} className="modelchip">
      <button ref={btn} type="button" className="chip" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" title={title}>
        {label} <span className="caret">▾</span>
      </button>
      {open && (
        <div ref={pop} className="chippop" style={place ?? { top: 0, left: 0, visibility: 'hidden' }}>
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * The agent, model and effort of a role or a session (model-picker-full-model-list.2, mockup canvas:08554ac6): one list
 * with a section per provider, one line per model (name, its context window; the id on hover), effort as segments of
 * what the chosen model takes, and in a session its context fill. `choice` null = the default (`fallback`, e.g. the
 * project's for this role), picked with "Project default"; without `fallback` there is no such row. A provider that may
 * not run `job` (Codex on a review, see agentAllowed) or is not installed is greyed with why. Another model keeps the
 * effort if it takes it. Up / Down move between the rows (ChoiceChip focuses the chosen one on open), Enter picks, Esc closes.
 */
export function ModelPopover({ agents, choice, fallback, job, context, onChange }: {
  agents: AgentInfo[]
  choice: ModelChoice | null
  fallback?: ModelChoice
  job?: AgentJob
  /** A session's context fill, shown under the efforts. */
  context?: { used: number; window: number | null } | null
  onChange: (c: ModelChoice | null) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const current = choice ?? fallback
  if (!current) return null
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role=option]:not(:disabled)') ?? [])]
    if (!rows.length) return
    e.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    rows[(at + (e.key === 'ArrowDown' ? 1 : rows.length - 1 + (at < 0 ? 1 : 0))) % rows.length].focus()
  }
  const currentProvider = agents.find((a) => a.id === current.agent)
  const efforts = effortsFor(currentProvider, current.model)
  const percent = context ? fillPercent(context.used, context.window) : null
  return (
    <div className="modelpop" role="dialog" aria-label="Agent, model and effort">
      <div ref={list} className="mprows" role="listbox" aria-label="Model" onKeyDown={onKey}>
        {fallback && (
          <button type="button" role="option" aria-selected={!choice} className={`mprow${choice ? '' : ' on'}`} onClick={() => onChange(null)}>
            <span className="mpname">Project default</span>
            <span className="mpwin">{choiceLabel(agents, fallback)}</span>
          </button>
        )}
        {agents.map((a) => {
          const why = !a.detected ? `${a.displayName} was not found on this machine.` : job ? agentAllowed(job, a.id).why : ''
          const own = choice?.agent === a.id ? choice : null
          const ownModel = own && findModel(a.models, own.model)
          const pick = (model: string | null) => onChange({ agent: a.id, model, effort: keptEffort(a, model, current.effort) })
          const row = (key: string, model: string | null, name: string, win: string, on: boolean, hint?: string) => (
            <button key={key} type="button" role="option" aria-selected={on} disabled={!!why} className={`mprow${on ? ' on' : ''}`} onClick={() => pick(model)} title={why || hint}>
              <span className="mpname">{name}</span>
              <span className="mpwin">{win}</span>
            </button>
          )
          return (
            <div key={a.id} role="group" aria-label={a.displayName} className={`mpsec${why ? ' off' : ''}`}>
              <div className="mpsechead">{a.displayName}</div>
              {why && <div className="mpwhy">{why}</div>}
              {row('default', null, 'Default', '', !!own && !own.model, `${a.displayName} picks the model`)}
              {own?.model && !ownModel && row('own', own.model, own.model, '', true, 'Not in the catalogue')}
              {a.models.map((m) => row(m.id, m.id, m.label, m.contextWindow ? formatTokens(m.contextWindow) : '', ownModel?.id === m.id, m.id))}
            </div>
          )
        })}
      </div>
      <div className="mpeffort">
        <span className="mplabel">Effort</span>
        {efforts.length ? (
          <div className="mpseg" role="radiogroup" aria-label="Effort">
            {[null, ...efforts].map((e) => (
              <button key={e ?? 'auto'} type="button" role="radio" aria-checked={current.effort === e} className={current.effort === e ? 'on' : ''} title={e ? undefined : "The provider's default effort"} onClick={() => onChange({ ...current, effort: e })}>
                {effortLabel(e)}
              </button>
            ))}
          </div>
        ) : (
          <span className="muted small">this model takes none</span>
        )}
      </div>
      {context && (
        <div className="mpcontext">
          <span className="mplabel">Context</span>
          <span className={`mpbar ${percent === null ? 'ok' : gaugeLevel(percent)}`}><span style={{ width: `${percent ?? 0}%` }} /></span>
          <span className="small">{formatTokens(context.used)}{context.window ? ` of ${formatTokens(context.window)} (${percent}%)` : ' used, window unknown'}</span>
        </div>
      )}
    </div>
  )
}

/** A ring and how full the context is: "42%", or the tokens used when the window is not known. */
export function ContextGauge({ used, window }: { used: number; window: number | null }) {
  const percent = fillPercent(used, window)
  const title = `Context: ${formatTokens(used)}${window ? ` of ${formatTokens(window)} tokens` : ' tokens (window unknown)'}`
  const r = 5
  const c = 2 * Math.PI * r
  return (
    <span className={`gauge ${percent === null ? 'ok' : gaugeLevel(percent)}`} title={title} aria-label={title}>
      {percent !== null && (
        <svg className="ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <circle cx="7" cy="7" r={r} className="track" />
          <circle cx="7" cy="7" r={r} className="fill" strokeDasharray={`${(c * percent) / 100} ${c}`} transform="rotate(-90 7 7)" />
        </svg>
      )}
      <span>{percent !== null ? `${percent}%` : formatTokens(used)}</span>
    </span>
  )
}
