import { useMemo } from 'react'
import type { Diagram } from '@mag/core'
import { flowItems } from '../componentDiff'
import { ComponentView, type OpenFlow } from './Component'
import { DataView } from './Data'
import { FlowchartView, StateView } from './Graph'
import { SequenceView } from './Sequence'

export const DIAGRAM_NAMES: Record<Diagram['type'], string> = { component: 'Component', sequence: 'Sequence', state: 'State', flowchart: 'Flowchart', data: 'Data' }

/** A diagram of a task with its id and title. */
export interface DiagramItem {
  id: string
  title: string
  diagram: Diagram
}

/**
 * A task diagram, drawn by the renderer of its type. `focus`: the id of a node to show (a canvas:<id>#<node> link).
 * `siblings`: the task's diagrams; with them a Component diagram opens the flows of its methods in place, or with
 * `onFlow` wherever that says. `onSelect`: told the node selected (a module, entity, participant, state or step).
 */
export function DiagramView({ diagram, focus, siblings, onSelect, onFlow }: {
  diagram: Diagram
  focus?: string
  siblings?: DiagramItem[]
  onSelect?: (id: string | null) => void
  onFlow?: OpenFlow
}) {
  const flows = useMemo(() => (siblings ? flowItems(siblings) : undefined), [siblings])
  switch (diagram.type) {
    case 'component':
      return (
        <div className="diagramview">
          <ComponentView modules={diagram.modules} diff summary={diagram.summary} focus={focus} flows={flows} onSelect={onSelect} onFlow={onFlow} />
        </div>
      )
    case 'sequence':
      return <div className="diagramview"><SequenceView diagram={diagram} focus={focus} onSelect={onSelect} /></div>
    case 'flowchart':
      return <div className="diagramview"><FlowchartView diagram={diagram} focus={focus} onSelect={onSelect} /></div>
    case 'state':
      return <div className="diagramview"><StateView diagram={diagram} focus={focus} onSelect={onSelect} /></div>
    case 'data':
      return <div className="diagramview"><DataView diagram={diagram} focus={focus} onSelect={onSelect} /></div>
  }
}
