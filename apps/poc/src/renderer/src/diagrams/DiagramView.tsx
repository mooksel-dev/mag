import type { Diagram, DiffMark } from '@mag/core'
import { ComponentView } from './Component'
import { FlowchartView, StateView } from './Graph'

export const DIAGRAM_NAMES: Record<Diagram['type'], string> = { component: 'Component', sequence: 'Sequence', state: 'State', flowchart: 'Flowchart' }

/** A task diagram, drawn by the renderer of its type. `focus`: the id of a node to show (a canvas:<id>#<node> link). */
export function DiagramView({ diagram, focus }: { diagram: Diagram; focus?: string }) {
  switch (diagram.type) {
    case 'component':
      return <div className="diagramview"><ComponentView modules={diagram.modules} diff focus={focus} /></div>
    case 'flowchart':
      return <div className="diagramview"><FlowchartView diagram={diagram} focus={focus} /></div>
    case 'state':
      return <div className="diagramview"><StateView diagram={diagram} focus={focus} /></div>
    default:
      return <DiagramList diagram={diagram} focus={focus} />
  }
}

const SIGN: Record<DiffMark, string> = { add: '+', mod: '~', del: '−' }

interface Item {
  id?: string
  text: string
  diff?: DiffMark
}

/** Types without a renderer yet: their elements as lists with the diff marks. */
function DiagramList({ diagram, focus }: { diagram: Exclude<Diagram, { type: 'component' }>; focus?: string }) {
  const groups: [string, Item[]][] =
    diagram.type === 'sequence'
      ? [
          ['Participants', diagram.participants.map((p) => ({ id: p.id, text: p.kind ? `${p.label} (${p.kind})` : p.label, diff: p.diff }))],
          ['Messages', diagram.messages.map((m) => ({ text: `${m.from} ${m.kind === 'reply' ? '⇠' : m.kind === 'async' ? '→>' : '→'} ${m.to}: ${m.text}`, diff: m.diff }))],
        ]
      : diagram.type === 'state'
        ? [
            [`States of ${diagram.entity}`, diagram.states.map((s) => ({ id: s.id, text: `${s.label}${s.initial ? ' (initial)' : ''}${s.final ? ' (final)' : ''}`, diff: s.diff }))],
            ['Transitions', diagram.transitions.map((t) => ({ text: `${t.from} → ${t.to}: ${t.event}${t.guard ? ` [${t.guard}]` : ''}`, diff: t.diff }))],
          ]
        : [
            ['Steps', diagram.nodes.map((n) => ({ id: n.id, text: `${n.label} (${n.shape})`, diff: n.diff }))],
            ['Arrows', diagram.edges.map((e) => ({ text: `${e.from} → ${e.to}${e.label ? `: ${e.label}` : ''}`, diff: e.diff }))],
          ]
  return (
    <div className="diagramview difflist">
      <p className="muted small">The {DIAGRAM_NAMES[diagram.type]} renderer is not ready yet; the diagram as a list.</p>
      {groups.map(([label, items]) => (
        <div key={label}>
          <div className="label">{label}</div>
          <ul>
            {items.map((it, i) => (
              <li key={i} className={`diff-${it.diff ?? 'none'}${it.id && it.id === focus ? ' on' : ''}`}>
                <span className="sign">{it.diff ? SIGN[it.diff] : ' '}</span>
                {it.text}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
