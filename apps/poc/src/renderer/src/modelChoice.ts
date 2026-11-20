import { EFFORTS, findModel, type AgentInfo, type Effort, type ModelChoice } from '@mag/core'

/** Tokens, short: 950, 45k, 200k, 1M, 1.5M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${Number((n / 1_000_000).toFixed(1))}M`
}

/** The gauge's colour: neutral below 70%, amber from 70% to 90%, red above 90%. */
export function gaugeLevel(percent: number): 'ok' | 'warn' | 'full' {
  return percent > 90 ? 'full' : percent >= 70 ? 'warn' : 'ok'
}

/** How full a context is, in whole percent up to 100; null = the window is not known. */
export function fillPercent(used: number, window: number | null): number | null {
  return window ? Math.min(100, Math.round((used / window) * 100)) : null
}

const EFFORT_LABELS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

/** "High"; null (the provider's default effort) is "Auto". */
export function effortLabel(effort: Effort | null): string {
  return effort ? EFFORT_LABELS[effort] : 'Auto'
}

/** The efforts a model takes; the provider's default model (null or unknown): any its models take. */
export function effortsFor(provider: AgentInfo | undefined, model: string | null): Effort[] {
  const m = findModel(provider?.models ?? [], model)
  if (m) return m.efforts
  const any = new Set(provider?.models.flatMap((x) => x.efforts) ?? [])
  return EFFORTS.filter((e) => any.has(e))
}

/** The effort a new model keeps: the current one if the model takes it; else the provider's default. */
export function keptEffort(provider: AgentInfo | undefined, model: string | null, effort: Effort | null): Effort | null {
  return effort && effortsFor(provider, model).includes(effort) ? effort : null
}

/**
 * "Opus 5.5 · High": the model's label (a stored alias shows its model) and the effort when one is set. The provider's
 * default model shows what the last run reported, e.g. "Default (Opus 5.5)"; an id the catalogue lacks shows as is.
 */
export function choiceLabel(agents: AgentInfo[], choice: ModelChoice, activeModel?: string): string {
  const provider = agents.find((a) => a.id === choice.agent)
  const models = provider?.models ?? []
  const name = provider?.displayName ?? choice.agent
  let model: string
  if (choice.model) model = findModel(models, choice.model)?.label ?? choice.model
  else {
    const ran = findModel(models, activeModel)?.label
    model = ran ? `Default (${ran})` : `${name} default`
  }
  return choice.effort ? `${model} · ${effortLabel(choice.effort)}` : model
}
