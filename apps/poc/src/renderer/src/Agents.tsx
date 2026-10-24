import { useEffect, useState } from 'react'
import type { AgentInfo, AgentKind, ModelChoice } from '@mag/core'

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

/** Provider + model selects. Changing the provider resets the model to its default. */
export function ModelPicker({ agents, choice, onChange, label }: { agents: AgentInfo[]; choice: ModelChoice; onChange: (c: ModelChoice) => void; label: string }) {
  const provider = agents.find((a) => a.id === choice.agent)
  return (
    <>
      <select value={choice.agent} onChange={(e) => onChange({ agent: e.target.value as AgentKind, model: null })} aria-label={`${label} provider`}>
        {!provider && <option value={choice.agent}>{choice.agent}</option>}
        {agents.map((a) => (
          <option key={a.id} value={a.id} disabled={!a.detected && a.id !== choice.agent}>
            {a.displayName}{a.detected ? '' : ' (not found)'}
          </option>
        ))}
      </select>
      <select value={choice.model ?? ''} onChange={(e) => onChange({ agent: choice.agent, model: e.target.value || null })} aria-label={`${label} model`}>
        <option value="">Default</option>
        {choice.model && !provider?.models.some((m) => m.id === choice.model) && <option value={choice.model}>{choice.model}</option>}
        {provider?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </>
  )
}
