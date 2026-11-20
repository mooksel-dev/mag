import { useEffect, useState } from 'react'
import { findModel, type AgentInfo, type AgentKind, type ModelChoice } from '@mag/core'

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

/**
 * Provider + model selects. Changing the provider resets the model and effort to its defaults; another model keeps the
 * effort if it takes it.
 */
export function ModelPicker({ agents, choice, onChange, label }: { agents: AgentInfo[]; choice: ModelChoice; onChange: (c: ModelChoice) => void; label: string }) {
  const provider = agents.find((a) => a.id === choice.agent)
  return (
    <>
      <select value={choice.agent} onChange={(e) => onChange({ agent: e.target.value as AgentKind, model: null, effort: null })} aria-label={`${label} provider`}>
        {!provider && <option value={choice.agent}>{choice.agent}</option>}
        {agents.map((a) => (
          <option key={a.id} value={a.id} disabled={!a.detected && a.id !== choice.agent}>
            {a.displayName}{a.detected ? '' : ' (not found)'}
          </option>
        ))}
      </select>
      <select value={choice.model ?? ''} onChange={(e) => onChange({ agent: choice.agent, model: e.target.value || null, effort: keptEffort(provider, e.target.value || null, choice) })} aria-label={`${label} model`}>
        <option value="">Default</option>
        {choice.model && !provider?.models.some((m) => m.id === choice.model) && <option value={choice.model}>{findModel(provider?.models ?? [], choice.model)?.label ?? choice.model}</option>}
        {provider?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </>
  )
}

/** The effort a new model keeps: the current one if the model takes it (its default model: any); else the default. */
function keptEffort(provider: AgentInfo | undefined, model: string | null, choice: ModelChoice): ModelChoice['effort'] {
  if (!choice.effort) return null
  const m = findModel(provider?.models ?? [], model)
  return !model || !m || m.efforts.includes(choice.effort) ? choice.effort : null
}
