import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { localCheckText, localOptions, openLocalChecks, repoNames, taskRepos, type LocalCheck, type LocalChoice, type Project, type Task } from '@mag/core'
import { popupPlace } from './popupPlace'

const mag = window.mag

/**
 * Start of a ready work (T-50): a popup lists the repositories its steps change, each with a "worktree" checkbox; an
 * unticked one works right in its main checkout. The last Start's choice is the default (project.lastLocalRepos), Enter
 * starts. A task without repositories starts at once. `onStart`: what Start does (default: develop; Approve & Start).
 * The popup is fixed to the window where it fits (popupPlace): it is rendered hidden, measured, then shown; it closes on
 * any scroll or resize rather than following the button.
 */
export function StartButton({ task, tasks, project, label = 'Start', className, disabled, title, onStart = (local) => mag.develop(task.id, local) }: {
  task: Task
  tasks: Task[]
  project?: Project
  label?: string
  className?: string
  disabled?: boolean
  title?: string
  onStart?: (localRepos?: string[]) => Promise<void>
}) {
  const repos = project ? taskRepos(task.id, tasks, project) : []
  const [open, setOpen] = useState(false)
  const [local, setLocal] = useState<string[]>([])
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open || !btn.current || !list.current) return setPlace(null)
    const b = btn.current.getBoundingClientRect()
    setPlace(popupPlace(b, { width: list.current.offsetWidth, height: list.current.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }))
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    // Fixed to the window, the popup would stay put while its button moves: close instead. A scroll inside it is its own.
    const onMove = (e: Event) => { if (!(e.target instanceof Node && list.current?.contains(e.target))) setOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'Enter') {
        e.preventDefault()
        start()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, local])
  const names = project ? repoNames(project) : []
  const start = () => {
    setOpen(false)
    void onStart(local)
  }
  const toggle = () => {
    if (!repos.length) return void onStart()
    if (!open) setLocal((project?.lastLocalRepos ?? []).filter((r) => repos.includes(r)))
    setOpen((o) => !o)
  }
  return (
    // Inside a clickable row: a click in here is not the row's.
    <span ref={box} className="startpop" onClick={(e) => e.stopPropagation()}>
      <button ref={btn} className={className} disabled={disabled} title={title} aria-expanded={open} onClick={toggle}>
        {label}
      </button>
      {open && project && (
        <div ref={list} className="startlist" role="dialog" aria-label={`Start ${task.key}`} style={place ?? { top: 0, left: 0, visibility: 'hidden' }}>
          <div className="muted small">Where the steps work. Untick a repository to work right in its main checkout.</div>
          {repos.map((r) => (
            <label key={r} className="startrepo" title={r}>
              <input type="checkbox" checked={!local.includes(r)} onChange={(e) => setLocal((l) => (e.target.checked ? l.filter((x) => x !== r) : [...l, r]))} />
              <span className="grow">{names[project.repos.indexOf(r)]}</span>
              <span className="muted small">{local.includes(r) ? 'local' : 'worktree'}</span>
            </label>
          ))}
          <button className="primary small" onClick={start}>{label}</button>
        </div>
      )}
    </span>
  )
}

const CHOICE_LABELS: Record<LocalChoice, string> = { worktree: 'Use worktree', wait: 'Wait', stash: 'Stash', ignore: 'Ignore', switch: 'Switch', discuss: 'Discuss' }

const CHOICE_TITLES: Record<LocalChoice, string> = {
  worktree: 'Work on this repository in a worktree instead, for the rest of the task',
  wait: 'Start the step once the other step is done or canceled',
  stash: 'git stash your changes ("mag: before <step>"), then switch to the step branch',
  ignore: 'Work on top of your changes; the agent never commits or reverts them',
  switch: 'Switch the checkout to the step branch; your branch stays as it is',
  discuss: 'Start the developer; it talks with you about this before touching it',
}

/** The question of a card: what is wrong with the main checkout, and what the user may do. */
function question(check: LocalCheck, base: string): string {
  if (check.busyBy) return `${localCheckText(check, base)}. Create a worktree, or wait until it's done?`
  return localCheckText(check, base)
}

/**
 * Cards of the current step's local checks (T-50), one per repository that waits for the user's choice, and the line of
 * a step that waits for another step to let a repository go.
 */
export function LocalChecks({ step, project, compact }: { step: Task; project?: Project; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = project?.baseBranch ?? 'main'
  const checks = openLocalChecks(step)
  if (!checks.length && !step.waitingFor) return null
  const choose = (repo: string, choice: LocalChoice) => (e: React.MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    setError(null)
    mag.resolveLocal(step.id, repo, choice).catch((err: Error) => setError(err.message)).finally(() => setBusy(false))
  }
  return (
    <div className={`localchecks ${compact ? 'compact' : ''}`}>
      {checks.map((c) => (
        <div key={c.repo} className="banner localcheck">
          <span className="grow">{question(c, base)}</span>
          {c.error && <span className="localerror">{c.error}</span>}
          <span className="localbtns">
            {localOptions(c).map((o, i) => (
              <button key={o} className={`small ${i === 0 ? 'primary' : ''}`} disabled={busy} title={CHOICE_TITLES[o]} onClick={choose(c.repo, o)}>
                {CHOICE_LABELS[o]}
              </button>
            ))}
          </span>
        </div>
      ))}
      {step.waitingFor && (
        <div className="banner info localcheck">
          <span className="grow">Waiting for {step.waitingFor.key} ({project ? repoNames(project)[project.repos.indexOf(step.waitingFor.repo)] ?? step.waitingFor.repo : step.waitingFor.repo})</span>
          <span className="localbtns">
            <button className="small" disabled={busy} title={CHOICE_TITLES.worktree} onClick={choose(step.waitingFor.repo, 'worktree')}>{CHOICE_LABELS.worktree}</button>
          </span>
        </div>
      )}
      {error && <div className="localerror">{error}</div>}
    </div>
  )
}
