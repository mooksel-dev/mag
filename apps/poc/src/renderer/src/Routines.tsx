import { useState } from 'react'
import { resolveChoice, type ModelChoice, type Workspace } from '@mag/core'
import type { AppState } from '../../preload/api'
import type { Routine, RoutineRun } from '../../main/core/services/routines/types.ts'
import { ArtifactDrawer } from './Drawer'
import type { ArtifactTarget } from './artifacts'
import { errorText } from './labels/LabelChips'
import { ChoiceChip, ModelPopover, useAgents } from './Agents'
import { choiceLabel } from './modelChoice'
import { RUN_STATUS, WEEKDAYS, cronOfPick, pickOfCron, routineNext, runDuration, runsOf, scheduleHint, slotText, type ScheduleMode, type SchedulePick } from './routinesView'
import type { Selection } from './WorkList'
import { Icon } from './ui/Icon'

const mag = window.mag

/** The rail's Routines section (routines-scheduled-drafts-and-a.1): the workspace's routines with their next slot and last run. */
export function RoutinesSection({ workspace, state, selectedId, onOpen }: { workspace: Workspace; state: AppState; selectedId: string | null; onOpen: (id: string) => void }) {
  const routines = (state.routines ?? []).filter((r) => r.workspaceId === workspace.id).sort((a, b) => a.name.localeCompare(b.name))
  return (
    <nav className="worklist" aria-label="Routines">
      <div className="wlhead2">
        <span className="colhead2">Routines</span>
        <div className="grow" />
        <button className="link small" onClick={() => onOpen('new')}><Icon name="plus" size={12} /> New routine</button>
      </div>
      <div className="wlscroll">
        {!routines.length && <p className="muted small pad">No routines yet. A routine runs a prompt on its schedule; what it did lands in the Inbox, and nothing is published without you. Ask a topic to "make this a routine" or add one here.</p>}
        {routines.map((r) => {
          const last = runsOf(state.routineRuns ?? [], r.id)[0]
          return (
            <button key={r.id} className={`mtgrow${selectedId === r.id ? ' on' : ''}`} aria-current={selectedId === r.id ? 'page' : undefined} onClick={() => onOpen(r.id)}>
              <span className="mtgtitle">{r.name}</span>
              <span className="wltime">{last ? `${RUN_STATUS[last.status]} · ` : ''}{routineNext(r)}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

interface Form {
  name: string
  prompt: string
  pick: SchedulePick
  projectId: string
  choice: ModelChoice | null
  enabled: boolean
}

const formOf = (r: Routine | null): Form => ({
  name: r?.name ?? '',
  prompt: r?.prompt ?? '',
  pick: pickOfCron(r?.trigger.kind === 'schedule' ? r.trigger.cron : '0 9 * * 1-5'),
  projectId: r?.projectId ?? '',
  choice: r?.choice ?? null,
  enabled: r?.enabled ?? true,
})

/**
 * A routine's page (routines-scheduled-drafts-and-a.2): prompt first, its schedule (a picker, the cron and the next 3
 * runs), an optional Project and model; Run now, and its runs with status, duration, the log and the draft, each
 * opening in the drawer.
 */
export function RoutineView({ id, workspace, state, onOpened, onClose, onSelect }: {
  /** 'new' for the form of a new routine. */
  id: string
  workspace: Workspace
  state: AppState
  onOpened: (id: string | null) => void
  onClose: () => void
  onSelect: (s: Selection) => void
}) {
  const routine = id === 'new' ? null : (state.routines ?? []).find((r) => r.id === id) ?? null
  const [form, setForm] = useState<Form>(() => formOf(routine))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<ArtifactTarget | null>(null)
  const agents = useAgents()
  if (id !== 'new' && !routine) return <main className="main empty"><p>This routine was removed.</p><button onClick={onClose}>Close</button></main>
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const setPick = (patch: Partial<SchedulePick>) => setForm((f) => ({ ...f, pick: { ...f.pick, ...patch } }))
  const cron = cronOfPick(form.pick)
  const hint = scheduleHint(cron)
  const projects = state.projects.filter((p) => p.workspaceId === workspace.id)
  const scope = projects.find((p) => p.id === form.projectId) ?? workspace
  const fallback = resolveChoice(scope, 'drafter')
  const runs = routine ? runsOf(state.routineRuns ?? [], routine.id) : []
  const running = runs.some((r) => r.status === 'running')
  const act = async (f: () => Promise<unknown>) => {
    setError(null)
    setBusy(true)
    try {
      await f()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    act(async () => {
      const saved = await mag.saveRoutine({
        ...(routine ? { id: routine.id } : { workspaceId: workspace.id }),
        name: form.name,
        prompt: form.prompt,
        trigger: { kind: 'schedule', cron },
        projectId: form.projectId || null,
        choice: form.choice,
        enabled: form.enabled,
      })
      if (!routine) onOpened(saved.id)
    })
  const remove = () => {
    if (routine && confirm(`Remove the routine ${routine.name} and its runs? Its drafts stay.`)) void act(async () => (await mag.removeRoutine(routine.id), onOpened(null)))
  }
  const draftOf = (run: RoutineRun) => (run.deliverableRef ? (state.deliverables ?? []).find((d) => `${d.folder}:dlv:${d.slug}` === run.deliverableRef) : undefined)

  return (
    <div className="routinepage">
      <main className="pagewrap">
        <div className="pagehead">
          <span>{routine ? routine.name : 'New routine'}</span>
          <div className="grow" />
          {routine && <button className="small" disabled={busy || running} title={running ? 'A run is going on' : 'Run now, outside the schedule'} onClick={() => void act(() => mag.runRoutine(routine.id))}><Icon name="play" size={12} /> Run now</button>}
          <button className="small" onClick={onClose}><Icon name="x" size={14} /> Close</button>
        </div>
        <section className="page">
          {error && <p className="err small" role="alert">{error}</p>}
          <label className="field">Name<input value={form.name} placeholder="Weekly update" onChange={(e) => set({ name: e.target.value })} /></label>
          <label className="field">
            Prompt (what a run does: its sources, rules and where the result goes)
            <textarea className="routineprompt" rows={12} value={form.prompt} placeholder="Every Thursday: read this week’s Jira and merged PRs, draft the team update…" onChange={(e) => set({ prompt: e.target.value })} />
          </label>
          <div className="field">
            Schedule
            <div className="routinesched">
              <select aria-label="Repeat" value={form.pick.mode} onChange={(e) => setPick({ mode: e.target.value as ScheduleMode, cron })}>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="custom">Custom cron</option>
              </select>
              {form.pick.mode === 'weekly' && (
                <select aria-label="Day" value={form.pick.day} onChange={(e) => setPick({ day: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              )}
              {form.pick.mode === 'custom' ? (
                <input aria-label="Cron" placeholder="minute hour day month weekday" value={form.pick.cron} onChange={(e) => setPick({ cron: e.target.value })} />
              ) : (
                <input type="time" aria-label="Time" value={form.pick.time} onChange={(e) => e.target.value && setPick({ time: e.target.value })} />
              )}
            </div>
            <span className="small muted">cron <code>{cron || '—'}</code>, local time</span>
            <span className={`small ${hint.ok ? 'muted' : 'err'}`}>{hint.text}</span>
          </div>
          <label className="field">
            Project (optional: its repos, notes and label)
            <select value={form.projectId} onChange={(e) => set({ projectId: e.target.value })}>
              <option value="">None (the workspace)</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div className="field">
            Model
            <ChoiceChip label={form.choice ? choiceLabel(agents, form.choice) : `Default · ${choiceLabel(agents, fallback)}`} title="The agent, model and effort a run uses">
              <ModelPopover agents={agents} choice={form.choice} fallback={fallback} fallbackLabel="Default" job="drafter" onChange={(c) => set({ choice: c })} />
            </ChoiceChip>
          </div>
          <label className="small"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On: runs on its schedule</label>
          <div className="routineacts">
            <button disabled={busy || !hint.ok || !form.name.trim() || !form.prompt.trim()} onClick={() => void save()}>{routine ? 'Save' : 'Create'}</button>
            {routine && <button className="link small" disabled={busy || running} onClick={remove}>Remove</button>}
            {routine && <span className="muted small">{routineNext(routine)}</span>}
          </div>
          {routine && (
            <>
              <h3>Runs</h3>
              {!runs.length && <p className="muted small">No runs yet.</p>}
              <table className="routineruns">
                <tbody>
                  {runs.map((run) => {
                    const draft = draftOf(run)
                    return (
                      <tr key={run.id}>
                        <td>{slotText(run.startedAt)}{run.slot === null ? ' · now' : ''}</td>
                        <td className={run.status === 'failed' ? 'err' : ''} title={run.error ?? undefined}>{RUN_STATUS[run.status]}{run.error ? `: ${run.error}` : ''}</td>
                        <td className="muted">{runDuration(run)}</td>
                        <td>{run.sessionId && state.sessions.some((s) => s.id === run.sessionId) && <button className="link small" onClick={() => setOpen({ kind: 'agent', sessionId: run.sessionId! })}>Log</button>}</td>
                        <td className="muted" title={run.summary ?? undefined}>{run.summary ?? ''}</td>
                        <td>{draft && <button className="link small" onClick={() => setOpen({ kind: 'deliverable', id: draft.id })}>Draft</button>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>
      </main>
      {open && <ArtifactDrawer open={open} state={state} onClose={() => setOpen(null)} onGone={() => setOpen(null)} onOpenKey={() => {}} onSelect={onSelect} />}
    </div>
  )
}
