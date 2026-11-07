import { useState, type CSSProperties, type PointerEvent } from 'react'
import { PANES, dragWidth, parseWidth, type PaneSide } from './paneWidth'

const load = (side: PaneSide): number | null => {
  try {
    return parseWidth(localStorage.getItem(PANES[side].key), side)
  } catch {
    return null
  }
}

const save = (side: PaneSide, w: number | null) => {
  try {
    if (w === null) localStorage.removeItem(PANES[side].key)
    else localStorage.setItem(PANES[side].key, String(w))
  } catch { /* ignore */ }
}

/**
 * A sidebar's width, restored from localStorage (null: the stylesheet's default), as the CSS variable the pane reads
 * (--left-w, --right-w); `set` keeps it, null resets it.
 */
export function usePaneWidth(side: PaneSide): { width: number | null; style: CSSProperties; set: (w: number | null) => void } {
  const [width, setWidth] = useState(() => load(side))
  const set = (w: number | null) => {
    setWidth(w)
    save(side, w)
  }
  return { width, style: (width === null ? {} : { [`--${side}-w`]: `${width}px` }) as CSSProperties, set }
}

/**
 * The drag handle on a sidebar's inner edge: a zero-width item between the pane and the main column (the left pane
 * before it, the right one after it). A drag resizes the pane within its limits and keeps the width; a double-click
 * goes back to the default.
 */
export function PaneHandle({ side, onResize }: { side: PaneSide; onResize: (w: number | null) => void }) {
  const [dragging, setDragging] = useState(false)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const handle = e.currentTarget
    const pane = side === 'left' ? handle.previousElementSibling : handle.nextElementSibling
    if (!pane) return
    e.preventDefault()
    const x0 = e.clientX
    const w0 = pane.getBoundingClientRect().width
    let last: number | null = null
    handle.setPointerCapture(e.pointerId)
    setDragging(true)
    document.body.classList.add('resizing')
    const move = (m: globalThis.PointerEvent) => {
      const w = dragWidth(side, w0, m.clientX - x0)
      if (w === last) return
      last = w
      onResize(w)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setDragging(false)
      document.body.classList.remove('resizing')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  return (
    <div
      className={`panehandle${dragging ? ' on' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize the sidebar' : 'Resize the artifacts pane'}
      title="Drag to resize; double-click for the default width"
      onPointerDown={down}
      onDoubleClick={() => onResize(null)}
    />
  )
}
