// Plan diagrams against base (T-57.3): show_diagram checks a diagram against the fresh base of its repositories, and a
// step's start checks its plan again when base has moved since.
import { repoNames, stepRepos, type Canvas, type Diagram, type Project, type Task } from '@mag/core'
import { createDiff, formatPlanWarnings, planChanges, planDrift, vocabularyOf, type PlanCheck, type PlanWarning } from '@mag/diff'
import { blobs, diffHunks, revParse, treeAt } from './git.ts'

export const diff = createDiff({ treeAt, blobs, diffHunks })

/** The repositories a diagram is about: its own, else its step's, else every one of the project. */
export function diagramRepos(project: Project, canvas: Pick<Canvas, 'repo'>, step?: Task): string[] {
  if (canvas.repo) return project.repos.includes(canvas.repo) ? [canvas.repo] : []
  return step ? stepRepos(step, project) : project.repos
}

/** The fresh base commit of each repository: origin/<base>, else the local branch; one without either is left out. */
export async function baseShas(project: Project, repos: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const repo of repos) {
    const sha = await revParse(repo, `origin/${project.baseBranch}`).catch(() => revParse(repo, project.baseBranch).catch(() => null))
    if (sha) out[repo] = sha
  }
  return out
}

/** A diagram against the given commits (repository path → sha); null when there is nothing to check it against. */
export async function checkPlan(project: Project, diagram: Diagram, shas: Record<string, string>): Promise<PlanCheck | null> {
  const repos = Object.keys(shas)
  if (diagram.type !== 'component' || !project.architecture || !repos.length) return null
  const vocabulary = vocabularyOf(project.architecture.modules)
  const names = repoNames(project)
  const skeletons = await Promise.all(repos.map((r) => diff.skeleton({ path: r, name: names[project.repos.indexOf(r)] ?? r }, shas[r], vocabulary)))
  return planChanges(diagram, skeletons, project.architecture.modules)
}

/** What a plan diagram no longer agrees on since it was checked: warnings at fresh base it did not have at its own. */
export async function diagramDrift(project: Project, canvas: Canvas): Promise<PlanWarning[]> {
  if (!canvas.diagram || !canvas.baseSha) return []
  const fresh = await baseShas(project, Object.keys(canvas.baseSha))
  if (Object.entries(fresh).every(([r, sha]) => canvas.baseSha![r] === sha)) return []
  const [before, now] = await Promise.all([checkPlan(project, canvas.diagram, canvas.baseSha), checkPlan(project, canvas.diagram, fresh)])
  return before && now ? planDrift(before, now) : []
}

/** The drift of a step's plan diagrams as the developer's first message says it; empty when none. */
export function driftText(drift: { canvas: Canvas; warnings: PlanWarning[] }[]): string {
  return drift.map((d) => `[${d.canvas.title}](canvas:${d.canvas.id}):\n${formatPlanWarnings(d.warnings)}`).join('\n')
}
