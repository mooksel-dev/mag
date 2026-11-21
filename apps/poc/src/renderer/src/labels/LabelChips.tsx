import { useRef, useState } from 'react'
import { itemLabelIds, workspaceLabels, type ItemRef, type Label } from '@mag/core'
import type { AppState } from '../../../preload/api'
import { useDismiss } from '../Agents'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'

const mag = window.mag

export const errorText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** A label as a chip: its color dot and name. */
export function LabelChip({ label, muted }: { label: Pick<Label, 'name' | 'color'>; muted?: boolean }) {
  return (
    <Pill className={`labelchip${muted ? ' muted' : ''}`} title={label.name}>
      <span className="d" aria-hidden style={{ background: label.color }} />
      {label.name}
    </Pill>
  )
}

/**
 * An item's labels as chips, its Project first (workspaces-and-labels-project-as.2), with a picker that edits them:
 * one label per exclusive group, several per multi group. `movable`: the Project label can change (a topic): picking
 * another project or No project moves it; a work's stays.
 */
export function LabelChips({ itemRef, projectId, workspaceId, state, movable }: {
  itemRef: ItemRef
  projectId: string | null
  workspaceId: string
  state: Pick<AppState, 'labelGroups' | 'labels' | 'itemLabels' | 'projects'>
  movable: boolean
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, setOpen)
  const view = workspaceLabels(workspaceId, state)
  const ids = itemLabelIds(itemRef, projectId, state.itemLabels)
  const all = view.flatMap((v) => v.labels)
  const shown = ids.flatMap((id) => all.filter((l) => l.id === id))
  const run = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e) => setError(errorText(e)))
  }
  const toggle = (l: Label, on: boolean) => run(on ? mag.removeLabel(itemRef, l.id) : mag.setLabel(itemRef, l.id))
  return (
    <div ref={box} className="labelchips modelchip">
      {!projectId && <LabelChip label={{ name: 'No project', color: 'var(--line)' }} muted />}
      {shown.map((l) => <LabelChip key={l.id} label={l} />)}
      <button type="button" className="chip" aria-haspopup="dialog" aria-expanded={open} title="Labels" onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={12} />
      </button>
      {open && (
        <div className="chippop labelpop" role="dialog" aria-label="Labels">
          {view.map(({ group, labels }) => {
            const project = group.system === 'project'
            if (project && !movable) return null
            return (
              <fieldset key={group.id} className="labelgroup">
                <legend>{group.name}<span className="muted small"> · {group.exclusive ? 'one' : 'several'}</span></legend>
                {project && (
                  <label className="labelopt">
                    <input type="radio" name={group.id} checked={!projectId} onChange={() => projectId && run(mag.removeLabel(itemRef, projectId))} /> No project
                  </label>
                )}
                {labels.map((l) => {
                  const on = ids.includes(l.id)
                  return (
                    <label key={l.id} className="labelopt">
                      <input type={group.exclusive ? 'radio' : 'checkbox'} name={group.id} checked={on} onChange={() => toggle(l, on && !group.exclusive)} />
                      <LabelChip label={l} />
                    </label>
                  )
                })}
                {!labels.length && <span className="muted small">No labels yet: add them in Workspace settings.</span>}
              </fieldset>
            )
          })}
          {view.length < 2 && <span className="muted small">Your own label groups are made in Workspace settings.</span>}
          {error && <p className="err small" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
