import { Component, type ErrorInfo, type ReactNode } from 'react'
import { crashMarkdown } from './format'

const mag = window.mag

interface Props {
  /** Shown in the card and the report: "Plan", "Task T-12", "Project chat". */
  screen: string
  appVersion?: string
  /** Leave the broken screen; without it there is no Back button. */
  onHome?: () => void
  children: ReactNode
}

interface Crash {
  message: string
  stack?: string
  componentStack?: string
  time: number
}

/** Catches a render error of one screen: an error card in its place instead of a blank window, and a crash report on disk. */
export class ErrorBoundary extends Component<Props, { crash: Crash | null; copied: boolean }> {
  state = { crash: null as Crash | null, copied: false }

  static getDerivedStateFromError(e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e))
    return { crash: { message: err.message, stack: err.stack, time: Date.now() }, copied: false }
  }

  componentDidCatch(e: unknown, info: ErrorInfo) {
    const err = e instanceof Error ? e : new Error(String(e))
    const crash = { message: err.message, stack: err.stack, componentStack: info.componentStack ?? undefined }
    this.setState((s) => ({ crash: { time: Date.now(), ...s.crash, ...crash } }))
    mag.reportCrash({ ...crash, screen: this.props.screen }).catch(() => {})
  }

  render() {
    const { crash, copied } = this.state
    if (!crash) return this.props.children
    const { screen, appVersion, onHome } = this.props
    const copy = () =>
      navigator.clipboard.writeText(crashMarkdown({ ...crash, screen, appVersion, kind: 'renderer' })).then(() => this.setState({ copied: true }))
    return (
      <section className="page">
        <div className="card crashcard" role="alert">
          <h2>{screen} crashed</h2>
          <div className="crashmsg">{crash.message}</div>
          <p className="muted small">The report is saved in the logs folder. The rest of mag keeps working.</p>
          <div className="crashactions">
            <button className="primary" onClick={copy}>{copied ? 'Copied' : 'Copy report'}</button>
            <button onClick={() => location.reload()}>Reload</button>
            {onHome && <button onClick={() => { this.setState({ crash: null }); onHome() }}>Back</button>}
            <button className="link small" onClick={() => mag.openLogs()}>Open logs folder</button>
          </div>
        </div>
      </section>
    )
  }
}

/** Errors outside React rendering (event handlers, timers, promises) go to the crash reports too. */
export function reportWindowErrors(screen: string) {
  window.addEventListener('error', (e) => {
    const err = e.error instanceof Error ? e.error : null
    mag.reportCrash({ screen, message: err?.message ?? e.message, stack: err?.stack }).catch(() => {})
  })
  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason instanceof Error ? e.reason : null
    mag.reportCrash({ screen, message: `Unhandled rejection: ${err?.message ?? String(e.reason)}`, stack: err?.stack }).catch(() => {})
  })
}
