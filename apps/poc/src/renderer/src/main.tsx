import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { TOKENS_CSS } from '@mag/core'
import { App } from './App'
import { ErrorBoundary, reportWindowErrors } from './ErrorBoundary'
import { Popout, popoutTarget } from './Popout'
import { Welcome } from './Picker'
import './styles.css'

// Dev only (Develop → UI fixtures); its own chunk, so the app's windows never load it.
const UiFixtures = lazy(() => import('./UiFixtures'))

// mag's tokens, first: styles.css and every canvas build on them (prompts-use-the-models-to.7).
const tokens = document.createElement('style')
tokens.dataset.magTokens = ''
tokens.textContent = TOKENS_CSS
document.head.prepend(tokens)

// Main and Welcome windows have the macOS traffic lights over the page; the title bar leaves room for them.
if (navigator.userAgent.includes('Macintosh')) document.documentElement.classList.add('mac')
const fixtures = location.hash === '#ui-fixtures'
const target = popoutTarget(location.hash)
const view = window.mag.windowView()
reportWindowErrors(fixtures ? 'UI fixtures' : target ? `Pop-out (${target.kind})` : view ? 'Workspace window' : 'Welcome')
createRoot(document.getElementById('root')!).render(
  fixtures ? <ErrorBoundary screen="UI fixtures"><Suspense fallback={null}><UiFixtures /></Suspense></ErrorBoundary>
  : target ? <ErrorBoundary screen={`Pop-out (${target.kind})`}><Popout target={target} /></ErrorBoundary>
  : view ? <App view={view} />
  : <ErrorBoundary screen="Welcome"><Welcome /></ErrorBoundary>,
)
