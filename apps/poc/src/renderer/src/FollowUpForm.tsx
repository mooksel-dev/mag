import { useState } from 'react'
import { dueAtOf } from '../../main/core/services/routines/refs.ts'
import { errorText } from './labels/LabelChips'
import { defaultDue } from './followUpView'

const mag = window.mag

/** Who, what and the day it comes back to the Inbox (routines-scheduled-drafts-and-a.3); `fromKey`: the Inbox item it is made from. */
export function FollowUpForm({ workspaceId, projectId, sourceRef, fromKey, who = '', what = '', onDone }: {
  workspaceId: string
  projectId: string | null
  sourceRef: string | null
  fromKey?: string
  who?: string
  what?: string
  onDone: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = (form: HTMLFormElement) => {
    const field = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value
    setError(null)
    let dueAt: number
    try {
      dueAt = dueAtOf(field('due'))
    } catch (e) {
      return setError(errorText(e))
    }
    setBusy(true)
    mag.addFollowUp({ workspaceId, projectId, who: field('who'), what: field('what'), dueAt, sourceRef, ...(fromKey && { fromKey }) })
      .then(onDone, (e) => setError(errorText(e)))
      .finally(() => setBusy(false))
  }
  return (
    <form className="followupform" aria-label="Follow up" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget) }}>
      <input name="who" aria-label="Who" placeholder="Who (me for yours)" defaultValue={who} required autoFocus={!who} />
      <input name="what" aria-label="What" placeholder="What" defaultValue={what} required autoFocus={!!who} />
      <label className="small">Back on <input name="due" type="date" aria-label="Due" defaultValue={defaultDue(Date.now())} required /></label>
      <div className="followupacts">
        <button className="small primary" type="submit" disabled={busy}>Follow up</button>
        <button className="small" type="button" onClick={onDone}>Cancel</button>
      </div>
      {error && <p className="err small" role="alert">{error}</p>}
    </form>
  )
}
