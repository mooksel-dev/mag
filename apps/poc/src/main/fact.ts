// The fact of a step's PRs against its plan (T-57.4): the changes of each PR from the code, compared with the step's
// plan diagrams, what of it a diagram shows, and the threshold for a merge verdict.
import { existsSync } from 'node:fs'
import { prHeads, repoWorkName, stepDiagrams, playbookOf, type Canvas, type Diagram, type Project, type Task, type TaskWork } from '@mag/core'
import { compare, coverage, isSignificant, mergeBlockers, parseSignificance, planChanges, planVocabulary, significance, withLevels, type Change, type ChangeSet, type Comparison, type Coverage, type HunkRef, type Vocabulary } from '@mag/diff'
import type { FactCanvas, FactChange, FactView } from '../preload/api'
import { diffText, hunkLines, mergeBase, revParse } from './git.ts'
import { diff } from './plan-check.ts'

export interface Fact {
  /** One per repository with a head, in the step's order. */
  facts: ChangeSet[]
  /** The repository (path) of each of `facts`. */
  repos: string[]
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
  const repos: string[] = []
  for (const r of work.repos) {
    const head = heads[r.repo]
    if (!head) continue
    const dir = repoDir(r)
    repos.push(r.repo)
    const from = await revParse(dir, `origin/${project.baseBranch}`).catch(() => revParse(dir, project.baseBranch))
    const base = await mergeBase(dir, from, head)
    facts.push(withLevels(await diff.changes({ path: dir, name: repoWorkName(work, r) }, base, head, vocabulary), rules))
  }
  const plan = plans.flatMap((c) => planChanges(c.diagram!, [], architecture).changes).map((c) => ({ ...c, level: significance(c, rules) }))
  const comparison = compare(plan, facts, architecture)
  return { facts, repos, comparison, blockers: mergeBlockers(comparison, facts), plans, vocabulary }
}

/** Where git runs for a repository of a step: a worktree is removed once merged; the main checkout shares its objects. */
const repoDir = (r: TaskWork['repos'][number]) => (!r.local && existsSync(r.worktree) ? r.worktree : r.repo)

/** The heads a step's fact is of: its open PRs, else the heads its fact was recorded at (a merged step). */
export function factHeads(step: Task): Record<string, string> {
  const open = prHeads(step.work)
  return Object.keys(open).length ? open : (step.fact?.heads ?? {})
}

const canvasRef = (c: Canvas): FactCanvas => ({ id: c.id, title: c.title, version: c.version })

/**
 * Plan ↔ fact of a step as Diff shows it (T-57.5): its fact at factHeads, compared with its plan diagrams, and what of
 * it its fact diagram (the one mag drew, else the first) shows. null when the step has no heads.
 */
export async function factView(project: Project, step: Task, canvases: Canvas[]): Promise<FactView | null> {
  const heads = factHeads(step)
  if (!Object.keys(heads).length || !step.work) return null
  const fact = await stepFact(project, step, heads, canvases)
  const repoOf = new Map<Change, string>()
  fact.facts.forEach((cs, i) => cs.changes.forEach((c) => repoOf.set(c, fact.repos[i])))
  const tag = (c: Change): FactChange => ({ ...c, repo: repoOf.get(c) ?? '' })
  const facts = stepComponents(canvases, step.id, 'fact')
  const shows = facts.find((c) => c.id === step.fact?.canvasId) ?? facts[0]
  const cover = shows && coverage(fact.facts, [shows.diagram!], project.architecture?.modules ?? [])
  return {
    heads,
    repos: fact.facts.map((cs, i) => ({ repo: fact.repos[i], name: cs.repo, baseSha: cs.baseSha, headSha: cs.headSha, deterministic: cs.deterministic, unparsed: cs.unparsed })),
    items: fact.comparison.items.map((i) => ({ ...i, fact: i.fact.map(tag) })),
    blockers: fact.blockers,
    plans: fact.plans.map(canvasRef),
    coverage: cover ? { canvas: canvasRef(shows), shown: cover.shown.map(tag), unshown: cover.unshown.map(tag) } : null,
    at: Date.now(),
  }
}

const SHA = /^[0-9a-f]{7,64}$/

/** The lines of one hunk of a step's PR in `repo` (one of the step's), between two commits of a FactView. */
export async function stepHunk(step: Task, repo: string, base: string, head: string, hunk: HunkRef): Promise<string[]> {
  const r = step.work?.repos.find((w) => w.repo === repo)
  if (!r) throw new Error(`${step.key} does not change ${repo}`)
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('base and head must be commit shas')
  return hunkLines(await diffText(repoDir(r), base, head), hunk.path, hunk)
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
