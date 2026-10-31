import type { Diagram } from '@mag/core'
import { ComponentView } from './Component'
import { DataView } from './Data'
import { FlowchartView, StateView } from './Graph'
import { SequenceView } from './Sequence'

export const DIAGRAM_NAMES: Record<Diagram['type'], string> = { component: 'Component', sequence: 'Sequence', state: 'State', flowchart: 'Flowchart', data: 'Data' }

/** A task diagram, drawn by the renderer of its type. `focus`: the id of a node to show (a canvas:<id>#<node> link). */
export function DiagramView({ diagram, focus }: { diagram: Diagram; focus?: string }) {
  switch (diagram.type) {
    case 'component':
      return <div className="diagramview"><ComponentView modules={diagram.modules} diff focus={focus} /></div>
    case 'sequence':
      return <div className="diagramview"><SequenceView diagram={diagram} focus={focus} /></div>
    case 'flowchart':
      return <div className="diagramview"><FlowchartView diagram={diagram} focus={focus} /></div>
    case 'state':
      return <div className="diagramview"><StateView diagram={diagram} focus={focus} /></div>
    case 'data':
      return <div className="diagramview"><DataView diagram={diagram} focus={focus} /></div>
  }
}
