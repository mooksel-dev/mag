import { useEffect, useState } from 'react'
import type { PeopleList, PersonView } from '../../main/core/services/people/types.ts'
import { filterPeople, handleLabels, syncReportText } from './peopleText'
import { Caret } from './ui/Icon'

const mag = window.mag

const message = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function usePeople(workspaceId: string): [PeopleList | null, () => void] {
  const [list, setList] = useState<PeopleList | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => mag.onPeopleChanged(() => setVersion((v) => v + 1)), [])
  useEffect(() => {
    let live = true
    void mag.listPeople(workspaceId).then((l) => live && setList(l), () => live && setList(null))
    return () => {
      live = false
    }
  }, [workspaceId, version])
  return [list, () => setVersion((v) => v + 1)]
}

function PersonRow({ person, workspaceId, onError }: { person: PersonView; workspaceId: string; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="pplrow">
      <button className="mtgrow" aria-expanded={open} title={person.email ?? person.name} onClick={() => setOpen(!open)}>
        <span className="mtgtitle">{person.name}{person.external ? ' · external' : ''}</span>
        <span className="wltime">{person.title ?? ''}</span>
      </button>
      {open && (
        <div className="pplmore">
          {person.email && <span className="muted small">{person.email}</span>}
          <span className="pplhandles">{handleLabels(person).map((h) => <code key={h}>{h}</code>)}</span>
          <button className="link small" title="A bot or a shared account: its handles stop counting as anyone" onClick={() => mag.notPerson(workspaceId, person.id).catch((e) => onError(message(e)))}>Not a person</button>
        </div>
      )}
    </div>
  )
}

/**
 * People of the workspace (who-is-who-people-from.1): its persons with their handles, open "is X = Y?" suggestions to
 * confirm or reject, unmatched handles to mark as not a person, and Sync now.
 */
export function PeopleSection({ workspaceId }: { workspaceId: string }) {
  const [list, reload] = usePeople(workspaceId)
  const [open, setOpen] = useState(() => localStorage.getItem('mag.people.open') !== '0')
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const toggle = () => {
    localStorage.setItem('mag.people.open', open ? '0' : '1')
    setOpen(!open)
  }
  const act = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e) => setError(message(e))).finally(reload)
  }
  const persons = filterPeople(list?.persons ?? [], q)
  const pending = list?.suggestions.length ?? 0
  return (
    <section className="meetings people" aria-label="People">
      <div className="mtghead">
        <button className="wlfold" aria-expanded={open} onClick={toggle}>
          <Caret open={open} /> People{list?.persons.length ? ` · ${list.persons.length}` : ''}{pending ? ` · ${pending} to confirm` : ''}
        </button>
        {open && (
          <button className="link small" disabled={list?.syncing} title="Pull the workspace's directories now (read-only)" onClick={() => act(mag.syncPeople(workspaceId))}>
            {list?.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>
      {open && list && (
        <>
          {list.lastSync && <span className="muted small pad">{syncReportText(list.lastSync)}</span>}
          {error && <p className="err small pad" role="alert">{error}</p>}
          {!list.persons.length && !list.syncing && <p className="muted small pad">No people yet. Choose the workspace's directories in Workspace settings, then Sync now.</p>}
          {list.suggestions.map((s) => (
            <div key={`${s.system}:${s.handle}`} className="pplsug" role="group" aria-label={`Is ${s.handle} ${s.person.name}?`}>
              <span className="small">Is <code>{s.system}:{s.handle}</code>{s.name !== s.handle ? ` (${s.name})` : ''} = {s.person.name}?</span>
              <span>
                <button className="small" onClick={() => act(mag.overridePerson({ workspaceId, system: s.system, handle: s.handle, personId: s.person.id }))}>Confirm</button>
                <button className="small" onClick={() => act(mag.rejectPerson(workspaceId, s.system, s.handle, s.person.id))}>Reject</button>
              </span>
            </div>
          ))}
          {list.persons.length > 0 && <input className="mtgsearch" type="search" value={q} placeholder="Find a person" aria-label="Find a person" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />}
          <div className="mtglist" role="list">
            {persons.map((p) => <PersonRow key={p.id} person={p} workspaceId={workspaceId} onError={setError} />)}
            {list.unmatched.length > 0 && (
              <details className="pplunmatched">
                <summary className="muted small">Unmatched · {list.unmatched.length}</summary>
                {list.unmatched.map((i) => (
                  <div key={i.id} className="pplsug">
                    <span className="small"><code>{i.system}:{i.handle}</code>{i.name && i.name !== i.handle ? ` ${i.name}` : ''}</span>
                    <button className="link small" onClick={() => act(mag.overridePerson({ workspaceId, system: i.system, handle: i.handle, personId: null }))}>Not a person</button>
                  </div>
                ))}
              </details>
            )}
          </div>
        </>
      )}
    </section>
  )
}
