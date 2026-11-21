/**
 * The widths of the screen's sidebars (topic-screen-one-new-compact.1): the topics column at the left, the artifacts
 * list or the drawer at the right. A width is the window's view state, so it lives in the renderer's localStorage, one
 * per side and, for the topics column, per window (slack-like-shell-rail-resizable.1); none stored means the pane's
 * default from the stylesheet.
 */

export type PaneSide = 'left' | 'right'

export interface PaneLimits {
  /** The localStorage key of the side's width; a window's own width is under `<key>.<window>`. */
  key: string
  min: number
  max: number
}

export const PANES: Record<PaneSide, PaneLimits> = {
  left: { key: 'mag.pane.left', min: 220, max: 480 },
  right: { key: 'mag.pane.right', min: 240, max: 640 },
}

/** The key a width is stored under: the side's, or one window's (`scope`) of it. */
export const paneKey = (side: PaneSide, scope?: string): string => (scope ? `${PANES[side].key}.${scope}` : PANES[side].key)

/** `w` within the side's limits, in whole pixels. */
export const clampWidth = (w: number, side: PaneSide): number => Math.round(Math.min(PANES[side].max, Math.max(PANES[side].min, w)))

/** A stored width, clamped; null when nothing (or nothing numeric) is stored: the default width. */
export function parseWidth(raw: string | null, side: PaneSide): number | null {
  if (raw === null || raw.trim() === '') return null
  const w = Number(raw)
  return Number.isFinite(w) ? clampWidth(w, side) : null
}

/** The width a window restores: its own, else the one stored before widths were per window, else null (the default). */
export function storedWidth(get: (key: string) => string | null, side: PaneSide, scope?: string): number | null {
  const own = scope ? get(paneKey(side, scope)) : null
  return parseWidth(own ?? get(paneKey(side)), side)
}

/**
 * The width a drag gives: `start` (the pane's width when the drag began) moved by `dx` (pointer x now minus at start).
 * The left pane grows to the right, the right one to the left.
 */
export const dragWidth = (side: PaneSide, start: number, dx: number): number => clampWidth(side === 'left' ? start + dx : start - dx, side)
