import { useEffect } from 'react'
import type { Project, Workspace } from '@mag/core'
import { Icon } from '../ui/Icon'

const mag = window.mag

/**
 * The menu of the column header "<Workspace> ▾" (slack-like-shell-rail-resizable.2): the workspaces (a click shows one
 * in this window, ⧉ opens it in a new one), Open in new window (⌘⇧N) for this one, its settings and labels, and the
 * project picker. A window filtered to a project can show its whole workspace.
 */
export function WorkspaceMenu({ current, workspaces, only, openWorkspaces, onClose, onSettings, onLabels, onPicker }: {
  current: Workspace
  workspaces: Workspace[]
  /** The project this window is filtered to. */
  only: Project | null
  /** Workspaces with a window of their own. */
  openWorkspaces: string[]
  onClose: () => void
  onSettings: () => void
  onLabels: () => void
  /** Open project… (⌘O) or New project…. */
  onPicker: (mode: 'open' | 'new') => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const act = (f: () => unknown) => () => {
    onClose()
    void f()
  }
  return (
    <>
      <div className="menuscrim" onClick={onClose} />
      <div className="menulist wsmenu" role="menu" aria-label="Workspace">
        {workspaces.map((w) => {
          const here = w.id === current.id && !only
          return (
            <div key={w.id} className="wsrow">
              <button
                role="menuitemradio"
                aria-checked={w.id === current.id}
                title={here ? 'This window' : `Show ${w.name} in this window`}
                onClick={act(() => !here && mag.switchWorkspace(w.id))}
              >
                <span className="wscheck" aria-hidden>{w.id === current.id && <Icon name="check" size={14} />}</span>
                <span className="title">{w.name}</span>
                {w.id !== current.id && openWorkspaces.includes(w.id) && <span className="ptag">open</span>}
              </button>
              <button className="wsnew" role="menuitem" aria-label={`Open ${w.name} in a new window`} title={`Open ${w.name} in a new window`} onClick={act(() => mag.openWorkspace(w.id))}>
                <Icon name="window" size={14} />
              </button>
            </div>
          )
        })}
        <hr />
        {only && <button role="menuitem" title={`This window shows ${only.name} only`} onClick={act(() => mag.switchWorkspace(current.id))}>Show all of {current.name}</button>}
        <button role="menuitem" onClick={act(() => mag.openWorkspace(current.id))}>
          <span className="title">Open in new window</span><kbd>⌘⇧N</kbd>
        </button>
        <hr />
        <button role="menuitem" onClick={act(onSettings)}>Workspace settings</button>
        <button role="menuitem" onClick={act(onLabels)}>Labels</button>
        <hr />
        <button role="menuitem" onClick={act(() => onPicker('open'))}>
          <span className="title">Open project…</span><kbd>⌘O</kbd>
        </button>
        <button role="menuitem" onClick={act(() => onPicker('new'))}>New project…</button>
      </div>
    </>
  )
}
