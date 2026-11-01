// The fact of a step's PRs against its plan (T-57.4): the changes of each PR from the code, compared with the step's
// plan diagrams, what of it a diagram shows, and the threshold for a merge verdict.
import { existsSync } from 'node:fs'
import { repoWorkName, stepDiagrams, playbookOf, type Canvas, type Diagram, type Project, type Task } from '@mag/core'
import { compare, coverage, isSignificant, mergeBlockers, parseSignificance, planChanges, planVocabulary, significance, withLevels, type ChangeSet, type Comparison, type Coverage, type Vocabulary } from '@mag/diff'
import { mergeBase, revParse } from './git.ts'
import { diff } from './plan-check.ts'

export interface Fact {
  /** One per repository with a head, in the step's order. */
  facts: ChangeSet[]
  comparison: Comparison
  blockers: string[]
  /** The step's plan diagrams it was compared with. */
  plans: Canvas[]
  vocabulary: Vocabulary
}

/** A step's Component diagrams of a role, in the order they were drawn. */
export const stepComponents = (canvases: Canvas[], stepId: string, role: 'plan' | 'fact') =>
  stepDiagrams(canvases, stepId).filter((c) => c.role === role && c.diagram?.type === 'component')

/**
 * The fact of a step's PRs at `heads` (repository path → head commit): each against where it left the base branch,
 * in the vocabulary of the architecture plus the modules the plan adds, levelled by the playbook's rules.
 */
export async function stepFact(project: Project, step: Task, heads: Record<string, string>, canvases: Canvas[]): Promise<Fact> {
  const work = step.work
  if (!work) throw new Error(`${step.key} has no work`)
  const architecture = project.architecture?.modules ?? []
  const plans = stepComponents(canvases, step.id, 'plan')
  const vocabulary = planVocabulary(architecture, plans.map((c) => c.diagram!))
  const rules = parseSignificance(playbookOf(project).significance)
  const facts: ChangeSet[] = []
  for (const r of work.repos) {
    const head = heads[r.repo]
    if (!head) continue
    // A worktree is removed once merged; the main checkout shares its objects.
    const dir = !r.local && existsSync(r.worktree) ? r.worktree : r.repo
    const from = await revParse(dir, `origin/${project.baseBranch}`).catch(() => revParse(dir, project.baseBranch))
    const base = await mergeBase(dir, from, head)
    facts.push(withLevels(await diff.changes({ path: dir, name: repoWorkName(work, r) }, base, head, vocabulary), rules))
  }
  const plan = plans.flatMap((c) => planChanges(c.diagram!, [], architecture).changes).map((c) => ({ ...c, level: significance(c, rules) }))
  const comparison = compare(plan, facts, architecture)
  return { facts, comparison, blockers: mergeBlockers(comparison, facts), plans, vocabulary }
}

/** The significant changes of the fact a fact diagram does not show: it may say what they mean, never drop them. */
export function unshown(fact: Fact, diagram: Diagram, architecture: Project['architecture']): Coverage['unshown'] {
  return coverage(fact.facts, [diagram], architecture?.modules ?? []).unshown.filter(isSignificant)
}

/** The counts of a comparison, as a step records them. */
export function factCounts(c: Comparison): NonNullable<Task['fact']>['counts'] {
  const counts = { match: 0, differs: 0, missing: 0, unplanned: 0, unchecked: 0 }
  for (const i of c.items) counts[i.status]++
  return counts
}
