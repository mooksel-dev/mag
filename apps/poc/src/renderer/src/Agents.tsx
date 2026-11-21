import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { agentAllowed, findModel, type AgentInfo, type AgentJob, type AgentKind, type ModelChoice } from '@mag/core'
import { choiceLabel, effortsFor, fillPercent, formatTokens, gaugeLevel, keptEffort } from './modelChoice'
import { Icon } from './ui/Icon'
import { Seg } from './ui/Seg'

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
 * A chip that opens a popover (`children`) below it, or above it with `up` (in a composer). Without children it is a
 * plain label, e.g. a subagent's model, which nobody sets.
 */
export function ChoiceChip({ label, title, up, children }: { label: ReactNode; title: string; up?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, setOpen)
  if (!children) return <span className="modelchip"><span className="chip static" title={title}>{label}</span></span>
  return (
    <div ref={box} className="modelchip">
      <button type="button" className="chip" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" title={title}>
        {label} <Icon name="chev-d" size={12} className="caret" />
      </button>
      {open && <div className={`chippop${up ? ' up' : ''}`}>{children}</div>}
    </div>
  )
}

/**
 * The agent, model and effort of a role or a session (model-picker-full-model-list.2): provider tabs, one row per model
 * with its version and context window, effort as segments of what the model takes. `choice` null = the default
 * (`fallback`, e.g. the project's for this role), picked with "Use project default"; without `fallback` there is no
 * such row. A provider that may not run `job` (Codex on a review, see agentAllowed) or is not installed shows greyed
 * with why. A provider's tab resets the model and effort; another model keeps the effort if it takes it.
 */
export function ModelPopover({ agents, choice, fallback, job, onChange }: {
  agents: AgentInfo[]
  choice: ModelChoice | null
  fallback?: ModelChoice
  job?: AgentJob
  onChange: (c: ModelChoice | null) => void
}) {
  const current = choice ?? fallback
  const [tab, setTab] = useState<AgentKind | undefined>(current?.agent)
  if (!current) return null
  const shown = tab ?? current.agent
  const provider = agents.find((a) => a.id === shown)
  const why = !provider ? '' : !provider.detected ? `${provider.displayName} was not found on this machine.` : job ? agentAllowed(job, provider.id).why : ''
  const own = choice?.agent === shown ? choice : null
  const ownModel = own && findModel(provider?.models ?? [], own.model)
  const pick = (model: string | null) => onChange({ agent: shown, model, effort: keptEffort(provider, model, current.agent === shown ? current.effort : null) })
  const currentProvider = agents.find((a) => a.id === current.agent)
  const efforts = effortsFor(currentProvider, current.model)
  return (
    <div className="modelpop" role="dialog" aria-label="Agent, model and effort">
      {fallback && (
        <button type="button" className={`mprow${choice ? '' : ' on'}`} onClick={() => onChange(null)}>
          <span className="mpname">Use project default</span>
          <span className="muted">{choiceLabel(agents, fallback)}</span>
        </button>
      )}
      <Seg
        className="fill"
        label="Provider"
        value={shown}
        onChange={setTab}
        options={agents.map((a) => ({
          value: a.id,
          label: `${a.displayName}${a.id === current.agent ? ' •' : ''}`,
          title: !a.detected ? 'Not found on this machine' : job && !agentAllowed(job, a.id).ok ? agentAllowed(job, a.id).why : a.displayName,
        }))}
      />
      {why && <p className="mpwhy muted small">{why}</p>}
      <div className="mprows" role="listbox" aria-label="Model">
        <button type="button" role="option" aria-selected={!!own && !own.model} disabled={!!why} className={`mprow${own && !own.model ? ' on' : ''}`} onClick={() => pick(null)}>
          <span className="mpname">Default</span>
          <span className="muted small">{provider?.displayName ?? shown} picks</span>
        </button>
        {own?.model && !ownModel && (
          <button type="button" role="option" aria-selected className="mprow on" disabled={!!why} onClick={() => pick(own.model)}>
            <span className="mpname">{own.model}</span>
            <span className="muted small">not in the catalogue</span>
          </button>
        )}
        {provider?.models.map((m) => (
          <button key={m.id} type="button" role="option" aria-selected={ownModel?.id === m.id} disabled={!!why} className={`mprow${ownModel?.id === m.id ? ' on' : ''}`} onClick={() => pick(m.id)} title={m.id}>
            <span className="mpname">{m.label}</span>
            <span className="mpwin">{m.contextWindow ? formatTokens(m.contextWindow) : '—'}</span>
            <code className="mpid">{m.id}</code>
          </button>
        ))}
      </div>
      <div className="mpeffort">
        <span className="muted small">Effort</span>
        {efforts.length ? (
          <Seg className="fill" label="Effort" value={current.effort} onChange={(e) => onChange({ ...current, effort: e })} options={[null, ...efforts].map((e) => ({ value: e, label: e ?? 'Default' }))} />
        ) : (
          <span className="muted small">this model takes none</span>
        )}
      </div>
    </div>
  )
}

/** A context bar and how full it is: "62%", or the tokens used when the window is not known. */
export function ContextGauge({ used, window }: { used: number; window: number | null }) {
  const percent = fillPercent(used, window)
  const title = `Context: ${formatTokens(used)}${window ? ` of ${formatTokens(window)} tokens` : ' tokens (window unknown)'}`
  return (
    <span className={`gauge ${percent === null ? 'ok' : gaugeLevel(percent)}`} title={title} aria-label={title}>
      {percent !== null && <span className="gaugebar"><span style={{ width: `${percent}%` }} /></span>}
      <span>{percent !== null ? `${percent}%` : formatTokens(used)}</span>
    </span>
  )
}
