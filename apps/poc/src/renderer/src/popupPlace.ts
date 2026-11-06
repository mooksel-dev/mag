/** Gap between the button and its popup, and the least margin kept from the window's edges, in CSS px. */
const GAP = 4
const MARGIN = 8

/**
 * Where a popup opens (fixed, in viewport px) for a button at `button` (its getBoundingClientRect): below the button if
 * it fits there, else above if it fits there, else on the side with more room. Right-aligned to the button, its left
 * edge clamped to stay `MARGIN` inside the window (a window narrower than the popup keeps the left edge). `maxHeight`:
 * the room on the chosen side, so a popup taller than both sides scrolls inside the window instead of leaving it.
 */
export function popupPlace(
  button: { top: number; bottom: number; right: number },
  popup: { width: number; height: number },
  view: { width: number; height: number },
): { top: number; left: number; maxHeight: number } {
  const below = view.height - MARGIN - (button.bottom + GAP)
  const above = button.top - GAP - MARGIN
  const down = popup.height <= below || (popup.height > above && below >= above)
  const room = Math.max(0, down ? below : above)
  const top = down ? button.bottom + GAP : button.top - GAP - Math.min(popup.height, room)
  const left = Math.max(MARGIN, Math.min(button.right - popup.width, view.width - popup.width - MARGIN))
  return { top, left, maxHeight: room }
}
