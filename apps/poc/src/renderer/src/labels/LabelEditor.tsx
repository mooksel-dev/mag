import { useState } from 'react'
import { MATCH_RULE_KINDS, workspaceLabels, type Label, type LabelGroup, type MatchRule } from '@mag/core'
import type { AppState } from '../../../preload/api'
import { errorText } from './LabelChips'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'

const mag = window.mag

const RULE_HINTS: Record<MatchRule['kind'], string> = { repo: 'duff-brewery', jiraKey: 'PRVP', channel: '#data-removal', openedFrom: 'a project name' }

/**
 * A workspace's label groups and labels (workspaces-and-labels-project-as.2): groups exclusive or multi, labels with
 * colors and match rules. The Project group is the system one: its labels are the projects, only their color and rules
 * change here.
 */
export function LabelEditor({ workspaceId, state }: { workspaceId: string; state: Pick<AppState, 'labelGroups' | 'labels' | 'projects'> }) {
  const [error, setError] = useState<string | null>(null)
  const run = (p: Promise<unknown>) => {
    setError(null)
    return p.catch((e) => { setError(errorText(e)); throw e })
  }
  const view = workspaceLabels(workspaceId, state)
  const [groupName, setGroupName] = useState('')
  const [exclusive, setExclusive] = useState(false)
  return (
    <div className="field labeleditor">
      Labels
      {view.map(({ group, labels }) => (
        <GroupEditor key={group.id} group={group} labels={labels} run={run} />
      ))}
      <form className="repo" onSubmit={(e) => { e.preventDefault(); run(mag.upsertLabelGroup({ workspaceId, name: groupName, exclusive })).then(() => setGroupName(''), () => {}) }}>
        <input value={groupName} placeholder="New label group, e.g. Area" aria-label="New label group" onChange={(e) => setGroupName(e.target.value)} />
        <label className="muted small"><input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} /> one label per item</label>
        <button className="small" disabled={!groupName.trim()}>Add group</button>
      </form>
      <span className="muted small">Rules label a topic or a work from its own repository, ticket key, channel or the project it was opened from; they never replace a label you set.</span>
      {error && <p className="err small" role="alert">{error}</p>}
    </div>
  )
}

function GroupEditor({ group, labels, run }: { group: LabelGroup; labels: Label[]; run: (p: Promise<unknown>) => Promise<unknown> }) {
  const [name, setName] = useState('')
  const system = !!group.system
  return (
    <fieldset className="labelgroup">
      <legend className="repo">
        {system ? <strong>{group.name}</strong> : <input key={group.name} defaultValue={group.name} aria-label="Group name" onBlur={(e) => { if (e.target.value.trim() !== group.name) void run(mag.upsertLabelGroup({ id: group.id, workspaceId: group.workspaceId, name: e.target.value, exclusive: group.exclusive })).catch(() => {}) }} />}
        <label className="muted small">
          <input type="checkbox" checked={group.exclusive} disabled={system} onChange={(e) => void run(mag.upsertLabelGroup({ id: group.id, workspaceId: group.workspaceId, name: group.name, exclusive: e.target.checked })).catch(() => {})} /> one label per item
        </label>
        {system ? <span className="muted small">system: its labels are the projects</span> : <button type="button" className="link" onClick={() => void run(mag.deleteLabelGroup(group.id)).catch(() => {})}>remove group</button>}
      </legend>
      {labels.map((l) => <LabelRow key={l.id} label={l} system={system} run={run} />)}
      {!system && (
        <form className="repo" onSubmit={(e) => { e.preventDefault(); void run(mag.upsertLabel({ groupId: group.id, name })).then(() => setName(''), () => {}) }}>
          <input value={name} placeholder="New label" aria-label={`New label of ${group.name}`} onChange={(e) => setName(e.target.value)} />
          <button className="small" disabled={!name.trim()}>Add label</button>
        </form>
      )}
    </fieldset>
  )
}

function LabelRow({ label, system, run }: { label: Label; system: boolean; run: (p: Promise<unknown>) => Promise<unknown> }) {
  const [kind, setKind] = useState<MatchRule['kind']>('repo')
  const [value, setValue] = useState('')
  const save = (patch: Partial<Pick<Label, 'name' | 'color' | 'rules'>>) => run(mag.upsertLabel({ id: label.id, groupId: label.groupId, name: label.name, ...patch })).catch(() => {})
  return (
    <div className="labelrow">
      <div className="repo">
        <input type="color" value={label.color} aria-label={`Color of ${label.name}`} onChange={(e) => void save({ color: e.target.value })} />
        {system ? <span>{label.name}</span> : <input key={label.name} defaultValue={label.name} aria-label="Label name" onBlur={(e) => { if (e.target.value.trim() !== label.name) void save({ name: e.target.value }) }} />}
        {!system && <button type="button" className="link" onClick={() => void run(mag.deleteLabel(label.id)).catch(() => {})}>remove</button>}
      </div>
      <div className="chips">
        {label.rules.map((r, i) => (
          <Pill key={`${i}:${r.kind}:${r.value}`}>
            {r.kind}: {r.value}
            <button type="button" className="link" aria-label={`Remove rule ${r.kind} ${r.value}`} onClick={() => void save({ rules: label.rules.filter((_, j) => j !== i) })}><Icon name="x" size={10} /></button>
          </Pill>
        ))}
        <form className="repo" onSubmit={(e) => { e.preventDefault(); void save({ rules: [...label.rules, { kind, value }] }).then(() => setValue('')) }}>
          <select value={kind} aria-label="Rule kind" onChange={(e) => setKind(e.target.value as MatchRule['kind'])}>
            {MATCH_RULE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input value={value} placeholder={RULE_HINTS[kind]} aria-label="Rule value" onChange={(e) => setValue(e.target.value)} />
          <button className="small" disabled={!value.trim()}>Add rule</button>
        </form>
      </div>
    </div>
  )
}
