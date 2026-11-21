import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { archToDNodes, type Project } from '@mag/core'
import { ComponentView } from './diagrams/Component'
import { Icon } from './ui/Icon'

const mag = window.mag

/** `inWindow`: shown in its own pop-out window, so there is no button to open one. */
export function Architecture({ project, inWindow = false }: { project: Project; inWindow?: boolean }) {
  const arch = project.architecture
  const run = project.archRun
  const running = run?.status === 'running'
  const modules = useMemo(() => (arch ? archToDNodes(arch.modules) : []), [arch])

  const start = () => mag.runArchitect(project.id).catch((e: Error) => alert(e.message))

  return (
    <section className="page arch">
      <div className="archhead">
        <h1>Architecture</h1>
        <button className={arch ? '' : 'primary'} onClick={start} disabled={running || !project.repos.length}>
          {running ? 'Analyzing…' : arch ? 'Re-analyze' : 'Analyze with AI'}
        </button>
        {arch && <span className="muted small">updated {new Date(arch.updatedAt).toLocaleString()}</span>}
        {run && run.status !== 'done' && (
          <span className={`small ${run.status === 'error' ? 'err' : 'muted'}`}>
            <Icon name={run.status === 'running' ? 'dot' : 'x'} size={12} />{' '}
            {run.note ?? ''}
          </span>
        )}
        {!inWindow && (
          <button className="link popbtn" title="Open in a separate window" onClick={() => mag.openWindow({ kind: 'architecture', projectId: project.id })}>
            <Icon name="window" size={14} /> Open in window
          </button>
        )}
      </div>
      {!project.repos.length && <p className="muted">Attach a repository in Settings.</p>}
      {!arch && !running && project.repos.length > 0 && (
        <p className="muted">
          An agent reads the code and describes it in your layers: app, services, clients, lib, with the interfaces of
          services and clients. It refreshes after each merged PR.
        </p>
      )}
      {arch && (
        <>
          <Summary text={arch.summary} />
          <ComponentView key={project.id} modules={modules} />
        </>
      )}
    </section>
  )
}

function Summary({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, open])

  return (
    <div className={`archsummary${open ? ' open' : ''}`}>
      <p ref={ref}>{text}</p>
      {(long || open) && (
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'less' : 'more'}</button>
      )}
    </div>
  )
}
