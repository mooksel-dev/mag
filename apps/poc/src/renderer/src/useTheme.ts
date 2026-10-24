import { useEffect, useLayoutEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

const KEY = 'mag.theme'
const MODES: readonly string[] = ['light', 'dark', 'system'] satisfies ThemeMode[]
const DARK = '(prefers-color-scheme: dark)'

const loadMode = (): ThemeMode => {
  try {
    const v = localStorage.getItem(KEY)
    return v !== null && MODES.includes(v) ? (v as ThemeMode) : 'system'
  } catch {
    return 'system'
  }
}

/** Theme preference (light / dark / follow the OS), applied as `<html data-theme>`. */
export function useTheme(): [mode: ThemeMode, setMode: (m: ThemeMode) => void] {
  const [mode, setModeState] = useState(loadMode)
  const [systemDark, setSystemDark] = useState(() => matchMedia(DARK).matches)

  useEffect(() => {
    const mq = matchMedia(DARK)
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const theme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const setMode = (m: ThemeMode) => {
    setModeState(m)
    try { localStorage.setItem(KEY, m) } catch { /* ignore */ }
  }
  return [mode, setMode]
}
