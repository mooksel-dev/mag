// The fact of a step's PRs against its plan (T-57.4, reworked in T-58): a step is one caller of the fact service. Here
// a step becomes what the service reads: its repositories' changes since they left the base branch, over local git,
// with its plan as the intent; and the fact as the step records it and Diff shows it. A review of a teammate's PR
// (reviews-ahent-reviuit-pr-timeitiv.2) is the other caller: the PR's changes, with its intent diagrams as the intent.
import { existsSync } from 'node:fs'
import { prHeads, repoNames, repoWorkName, stepDiagrams, type Canvas, type Project, type Task, type TaskWork } from '@mag/core'
import type { HunkRef } from '@mag/diff'
import type { FactCanvas, FactView } from '../preload/api'
import { changes, check, hunk, type ChangeSource, type ChangeTarget, type Fact } from './core/services/fact/index.ts'
import { diffHunks, diffText, hunkLines, mergeBase, revParse } from './git.ts'

/** Changes as the local git checkouts of the project's repositories have them. */
export const localGit: ChangeSource = {
  diffHunks,
  hunkLines: async (at, base, head, ref) => hunkLines(await diffText(at, base, head), ref.path, ref),
}

/** A review's Component diagrams of a role (intent, fact), in the order they were drawn. */
export const reviewComponents = (canvases: Canvas[], workId: string, role: 'intent' | 'fact') =>
  canvases.filter((c) => c.taskId === workId && c.role === role && c.kind === 'diagram' && c.diagram?.type === 'component')

/** A step's Component diagrams of a role, in the order they were drawn. */
export const stepComponents = (canvases: Canvas[], stepId: string, role: 'plan' | 'fact') =>
  stepDiagrams(canvases, stepId).filter((c) => c.role === role && c.diagram?.type === 'component')

/** Where git runs for a repository of a step: a worktree is removed once merged; the main checkout shares its objects. */
const repoDir = (r: TaskWork['repos'][number]) => (!r.local && existsSync(r.worktree) ? r.worktree : r.repo)

/** A repository's changes from where `head` left the project's base branch. */
export async function branchTarget(project: Project, repo: string, name: string, at: string, head: string): Promise<ChangeTarget> {
  const from = await revParse(at, `origin/${project.baseBranch}`).catch(() => revParse(at, project.baseBranch))
  return { repo, name, at, base: await mergeBase(at, from, head), head }
}

/** The changes of a step's PRs at `heads` (repository path → head commit), in the step's order of repositories. */
export async function stepTargets(project: Project, step: Task, heads: Record<string, string>): Promise<ChangeTarget[]> {
  const work = step.work
  if (!work) throw new Error(`${step.key} has no work`)
  const out: ChangeTarget[] = []
  for (const r of work.repos) if (heads[r.repo]) out.push(await branchTarget(project, r.repo, repoWorkName(work, r), repoDir(r), heads[r.repo]))
  return out
}

/** The step's fact diagram: the one its fact names, else the first one placed in its fact. */
export function factCanvas(step: Task, canvases: Canvas[]): Canvas | null {
  const facts = stepComponents(canvases, step.id, 'fact')
  return facts.find((c) => c.id === step.fact?.canvasId) ?? facts[0] ?? null
}

/** The fact of a step's PRs at `heads`: their changes against the step's fact diagram and plan. */
export async function stepFact(project: Project, step: Task, heads: Record<string, string>, canvases: Canvas[]): Promise<Fact> {
  const plans = stepComponents(canvases, step.id, 'plan')
  const changed = await changes(project, await stepTargets(project, step, heads), localGit, plans)
  return check(project, changed, factCanvas(step, canvases), plans)
}

/** The counts of a fact, as a step records them. */
export function factCounts(fact: Fact): NonNullable<Task['fact']>['counts'] {
  const counts = { match: 0, differs: 0, missing: 0, unplanned: 0, unshown: fact.coverage?.unshown.length ?? 0, unverified: fact.grounding?.unverified.length ?? 0 }
  for (const i of fact.comparison.items) counts[i.status]++
  return counts
}

/** A step's fact as it records it: `started` is the version of the fact diagram mag started (a copy of the plan). */
export function factRecord(fact: Fact, heads: Record<string, string>, started: number | null): NonNullable<Task['fact']> {
  return { heads, counts: factCounts(fact), blockers: fact.blockers, canvasId: fact.canvas?.id ?? null, canvasVersion: started, at: Date.now() }
}

/** The heads a step's fact is of: its open PRs, else the heads its fact was recorded at (a merged step). */
export function factHeads(step: Task): Record<string, string> {
  const open = prHeads(step.work)
  return Object.keys(open).length ? open : (step.fact?.heads ?? {})
}

const canvasRef = (c: Canvas): FactCanvas => ({ id: c.id, title: c.title, version: c.version })

/**
 * Plan ↔ fact of a step as Diff shows it (T-57.5): its fact at factHeads, compared with its plan diagrams, which
 * changed files its fact diagram shows and which of its lines do not rest on the PR. null when the step has no heads.
 */
export async function factView(project: Project, step: Task, canvases: Canvas[]): Promise<FactView | null> {
  const heads = factHeads(step)
  if (!Object.keys(heads).length || !step.work) return null
  return view(heads, await stepFact(project, step, heads, canvases))
}

/** A fact as Diff and the Reviews page show it. */
function view(heads: Record<string, string>, fact: Fact): FactView {
  return {
    heads,
    repos: fact.repos,
    files: fact.files,
    items: fact.comparison.items,
    blockers: fact.blockers,
    plans: fact.intent.map(canvasRef),
    fact: fact.canvas ? canvasRef(fact.canvas) : null,
    coverage: fact.coverage,
    unverified: fact.grounding?.unverified ?? [],
    at: Date.now(),
  }
}

/** The PR of a review at `head` (default: its head when mag last looked), from where it left its base branch. */
export async function reviewTarget(project: Project, work: Task, head?: string): Promise<ChangeTarget> {
  const pr = work.prReview?.pr
  if (!pr) throw new Error(`${work.key} reviews no PR`)
  const name = repoNames(project)[project.repos.indexOf(pr.repo)] ?? pr.repo
  const at = head ?? pr.head
  const from = await revParse(pr.repo, `origin/${pr.base}`).catch(() => revParse(pr.repo, pr.base))
  return { repo: pr.repo, name, at: pr.repo, base: await mergeBase(pr.repo, from, at), head: at }
}

/** The review's fact diagram: the one its fact names, else the first one it has. */
export function reviewFactCanvas(work: Task, canvases: Canvas[]): Canvas | null {
  const facts = reviewComponents(canvases, work.id, 'fact')
  return facts.find((c) => c.id === work.fact?.canvasId) ?? facts[0] ?? null
}

/** The fact of a reviewed PR at `head`: its changes against the review's fact diagram and intent. */
export async function reviewFact(project: Project, work: Task, canvases: Canvas[], head?: string): Promise<Fact> {
  const intent = reviewComponents(canvases, work.id, 'intent')
  const changed = await changes(project, [await reviewTarget(project, work, head)], localGit, intent)
  return check(project, changed, reviewFactCanvas(work, canvases), intent)
}

/** Intent ↔ fact of a review as its page shows it: at the head its fact is of, else the PR's. null before it has a PR. */
export async function reviewFactView(project: Project, work: Task, canvases: Canvas[]): Promise<FactView | null> {
  const pr = work.prReview?.pr
  if (!pr) return null
  const head = work.fact?.heads[pr.repo] ?? pr.head
  return view({ [pr.repo]: head }, await reviewFact(project, work, canvases, head))
}

/** The lines of one hunk of a reviewed PR, between two commits of a FactView. */
export async function reviewHunk(work: Task, repo: string, base: string, head: string, ref: HunkRef): Promise<string[]> {
  if (work.prReview?.pr.repo !== repo) throw new Error(`${work.key} does not review a PR of ${repo}`)
  return hunk(localGit, repo, base, head, ref)
}

/** The lines of one hunk of a step's PR in `repo` (one of the step's), between two commits of a FactView. */
export async function stepHunk(step: Task, repo: string, base: string, head: string, ref: HunkRef): Promise<string[]> {
  const r = step.work?.repos.find((w) => w.repo === repo)
  if (!r) throw new Error(`${step.key} does not change ${repo}`)
  return hunk(localGit, repoDir(r), base, head, ref)
}
