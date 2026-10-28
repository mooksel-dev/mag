import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary, reportWindowErrors } from './ErrorBoundary'
import { Popout, popoutTarget } from './Popout'
import './styles.css'

const target = popoutTarget(location.hash)
reportWindowErrors(target ? `Pop-out (${target.kind})` : 'Main window')
createRoot(document.getElementById('root')!).render(
  target ? <ErrorBoundary screen={`Pop-out (${target.kind})`}><Popout target={target} /></ErrorBoundary> : <App />,
)
