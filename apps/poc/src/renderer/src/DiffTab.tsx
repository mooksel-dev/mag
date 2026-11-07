import type { AppState } from '../../preload/api'
import type { DiagramCanvas } from './DiffSetView'

/** Diagram canvases among `canvases`, in the order they were drawn. */
export function diagramsOf(canvases: AppState['canvases']): DiagramCanvas[] {
  return canvases.filter((c): c is DiagramCanvas => c.kind === 'diagram' && !!c.diagram)
}
