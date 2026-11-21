import { useState } from 'react'
import { DESTINATION_LABELS, workspaceLabels, type Destination, type DestinationKind, type Workspace } from '@mag/core'
import type { AppState } from '../../preload/api'
import type { Routine, RoutineRun } from '../../main/core/services/routines/types.ts'
import { DELIVERABLE_KINDS } from '../../main/core/services/deliverables/types.ts'
import { ArtifactDrawer } from './Drawer'
import type { ArtifactTarget } from './artifacts'
import { errorText } from './labels/LabelChips'
import { RUN_STATUS, routineNext, runDuration, runsOf, scheduleHint, slotText, sourcesOf, sourcesText } from './routinesView'
import type { Selection } from './WorkList'
import { Icon } from './ui/Icon'

const mag = window.mag

/** The rail's Routines section (routines-scheduled-drafts-and-a.1): the workspace's routines with their next slot and last run. */
export function RoutinesSection({ workspace, state, selectedId, onOpen }: { workspace: Workspace; state: AppState; selectedId: string | null; onOpen: (id: string) => void }) {
  const routines = (state.routines ?? []).filter((r) => r.workspaceId === workspace.id).sort((a, b) => a.title.localeCompare(b.title))
  return (
    <nav className="worklist" aria-label="Routines">
      <div className="wlhead2">
        <span className="colhead2">Routines</span>
        <div className="grow" />
        <button className="link small" onClick={() => onOpen('new')}><Icon name="plus" size={12} /> New routine</button>
      </div>
      <div className="wlscroll">
        {!routines.length && <p className="muted small pad">No routines yet. A routine drafts a deliverable on its schedule into the Inbox; nothing is published without you.</p>}
        {routines.map((r) => {
          const last = runsOf(state.routineRuns ?? [], r.id)[0]
          return (
            <button key={r.id} className={`mtgrow${selectedId === r.id ? ' on' : ''}`} aria-current={selectedId === r.id ? 'page' : undefined} onClick={() => onOpen(r.id)}>
              <span className="mtgtitle">{r.title}</span>
              <span className="wltime">{last ? `${RUN_STATUS[last.status]} · ` : ''}{routineNext(r)}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

interface Form {
  title: string
  schedule: string
  kind: string
  brief: string
  sources: string
  labels: string[]
  destKind: DestinationKind | ''
  destTarget: string
  enabled: boolean
}

const formOf = (r: Routine | null): Form => ({
  title: r?.title ?? '',
  schedule: r?.schedule ?? '0 9 * * thu',
  kind: r?.kind ?? 'report',
  brief: r?.brief ?? '',
  sources: sourcesText(r?.sources ?? []),
  labels: r?.labels ?? [],
  destKind: r?.destination?.kind ?? '',
  destTarget: r?.destination?.target ?? '',
  enabled: r?.enabled ?? true,
})

const destinationOf = (f: Form): Destination | null => {
  if (!f.destKind) return null
  const target = f.destTarget.trim()
  return { kind: f.destKind, target, label: target ? `${DESTINATION_LABELS[f.destKind]} ${target}` : DESTINATION_LABELS[f.destKind] }
}

/**
 * A routine's page: its form (schedule validated as typed, with the next slot), its pack, Run now, and its runs with
 * status, duration, the drafter's log and the draft, each opening in the drawer.
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
  if (id !== 'new' && !routine) return <main className="main empty"><p>This routine was removed.</p><button onClick={onClose}>Close</button></main>
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const hint = scheduleHint(form.schedule)
  const groups = workspaceLabels(workspace.id, state).filter((g) => g.labels.length)
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
        title: form.title,
        schedule: form.schedule,
        kind: form.kind,
        brief: form.brief,
        sources: sourcesOf(form.sources),
        labels: form.labels,
        destination: destinationOf(form),
        enabled: form.enabled,
      })
      if (!routine) onOpened(saved.id)
    })
  const remove = () => {
    if (routine && confirm(`Remove the routine ${routine.title} and its runs? Its drafts stay.`)) void act(async () => (await mag.removeRoutine(routine.id), onOpened(null)))
  }
  const draftOf = (run: RoutineRun) => (run.deliverableRef ? (state.deliverables ?? []).find((d) => `${d.folder}:dlv:${d.slug}` === run.deliverableRef) : undefined)

  return (
    <div className="routinepage">
      <main className="pagewrap">
        <div className="pagehead">
          <span>{routine ? routine.title : 'New routine'}</span>
          <div className="grow" />
          {routine && <button className="small" disabled={busy || running} title={running ? 'A run is going on' : 'Draft now, outside the schedule'} onClick={() => void act(() => mag.runRoutine(routine.id))}><Icon name="play" size={12} /> Run now</button>}
          <button className="small" onClick={onClose}><Icon name="x" size={14} /> Close</button>
        </div>
        <section className="page">
          {error && <p className="err small" role="alert">{error}</p>}
          <label className="field">Title<input value={form.title} placeholder="Ups & Downs" onChange={(e) => set({ title: e.target.value })} /></label>
          <label className="field">
            Schedule (cron, local time: minute hour day month weekday)
            <input value={form.schedule} aria-invalid={!hint.ok} onChange={(e) => set({ schedule: e.target.value })} />
            <span className={`small ${hint.ok ? 'muted' : 'err'}`}>{hint.text}</span>
          </label>
          <label className="field">
            Deliverable kind (its pack gives the prompt and rules)
            <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
              {DELIVERABLE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {routine && <button className="link small" type="button" onClick={() => void act(() => mag.revealRoutinePack(routine.id))}>Show the {routine.kind} pack and its rules in Finder</button>}
          </label>
          <label className="field">Brief (what to draft beyond the pack)<textarea rows={3} value={form.brief} onChange={(e) => set({ brief: e.target.value })} /></label>
          <label className="field">Sources, one per line (e.g. jira:PRVP, gh:org/repo, slack:#channel, meetings)<textarea rows={3} value={form.sources} onChange={(e) => set({ sources: e.target.value })} /></label>
          {groups.length > 0 && (
            <fieldset className="field">
              <legend>Labels (the draft carries them; the previous issue is the last final one with all of them)</legend>
              {groups.map(({ group, labels }) => (
                <div key={group.id} className="routinelabels">
                  <span className="muted small">{group.name}</span>
                  {labels.map((l) => (
                    <label key={l.id} className="small">
                      <input type="checkbox" checked={form.labels.includes(l.id)} onChange={(e) => set({ labels: e.target.checked ? [...form.labels, l.id] : form.labels.filter((x) => x !== l.id) })} /> {l.name}
                    </label>
                  ))}
                </div>
              ))}
            </fieldset>
          )}
          <div className="field">
            Destination (where you will publish the final version)
            <div className="routinedest">
              <select aria-label="Destination kind" value={form.destKind} onChange={(e) => set({ destKind: e.target.value as DestinationKind | '' })}>
                <option value="">None yet</option>
                {(Object.keys(DESTINATION_LABELS) as DestinationKind[]).map((k) => <option key={k} value={k}>{DESTINATION_LABELS[k]}</option>)}
              </select>
              {form.destKind && <input aria-label="Destination target" placeholder="Channel, doc, page…" value={form.destTarget} onChange={(e) => set({ destTarget: e.target.value })} />}
            </div>
          </div>
          <label className="small"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On: runs on its schedule</label>
          <div className="routineacts">
            <button disabled={busy || !hint.ok || !form.title.trim()} onClick={() => void save()}>{routine ? 'Save' : 'Create'}</button>
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
                        <td>{draft && <button className="link small" onClick={() => setOpen({ kind: 'deliverable', id: draft.id })}>Draft{run.status === 'drafted' ? '' : ' (brief)'}</button>}</td>
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
