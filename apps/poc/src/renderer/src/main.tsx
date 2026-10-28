import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Popout, popoutTarget } from './Popout'
import './styles.css'

const target = popoutTarget(location.hash)
createRoot(document.getElementById('root')!).render(target ? <Popout target={target} /> : <App />)
