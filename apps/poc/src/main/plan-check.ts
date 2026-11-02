// Plan diagrams against the vocabulary (T-58 Decision 8): show_diagram says where a Component diagram's module ids are
// not the architecture's. Warnings, not errors: the diagram is saved either way.
import type { Diagram, Project } from '@mag/core'
import { formatPlanWarnings, planWarnings } from '@mag/diff'

/** What show_diagram adds to its answer for a Component diagram; empty when there is nothing to check or to say. */
export function planCheck(project: Project, diagram: Diagram): string {
  if (diagram.type !== 'component' || !project.architecture) return ''
  const warnings = planWarnings(diagram, project.architecture.modules)
  if (!warnings.length) return ' Its modules are those of the architecture.'
  return `\nSaved, but its modules disagree with the architecture (get_architecture). Fix the diagram and revise it by id, or say in the doc why it is right:\n${formatPlanWarnings(warnings)}`
}
