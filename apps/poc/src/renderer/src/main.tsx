import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary, reportWindowErrors } from './ErrorBoundary'
import { Popout, popoutTarget } from './Popout'
import { Welcome } from './Picker'
import './styles.css'

// Project and Welcome windows have the macOS traffic lights over the page; the title bar leaves room for them.
if (navigator.userAgent.includes('Macintosh')) document.documentElement.classList.add('mac')
const target = popoutTarget(location.hash)
const projectId = window.mag.windowProjectId()
reportWindowErrors(target ? `Pop-out (${target.kind})` : projectId ? 'Project window' : 'Welcome')
createRoot(document.getElementById('root')!).render(
  target ? <ErrorBoundary screen={`Pop-out (${target.kind})`}><Popout target={target} /></ErrorBoundary>
  : projectId ? <App projectId={projectId} />
  : <ErrorBoundary screen="Welcome"><Welcome /></ErrorBoundary>,
)
