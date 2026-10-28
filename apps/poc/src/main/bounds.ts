/** Window bounds, as Electron's Rectangle. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Height of the strip at the top of a window that must be on screen, so the window can still be dragged. */
const GRAB = 40

/**
 * Whether saved bounds can be reused: the window's title strip overlaps some display's work area by enough to grab
 * it. False when the display it was on is gone.
 */
export function onSomeDisplay(b: Bounds, workAreas: Bounds[]): boolean {
  return workAreas.some((a) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
    const h = Math.min(b.y + GRAB, a.y + a.height) - Math.max(b.y, a.y)
    return w >= 100 && h >= GRAB / 2
  })
}
