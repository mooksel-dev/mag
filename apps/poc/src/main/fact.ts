// The fact of a step's PRs against its plan (T-57.4, reworked in T-58): a step is one caller of the fact service. Here
// a step becomes what the service reads: its repositories' changes since they left the base branch, over local git,
// against its plan; and the fact as the step records it and Diff shows it. A review of a teammate's PR
// (reviews-ahent-reviuit-pr-timeitiv.2) is the other caller: the PR's changes, without a plan to compare
// (reviews-prybraty-spysok-pr-i.1); read from GitHub when the project has no checkout of its repository
// (reviews-ahent-reviuit-pr-timeitiv.3).
import { existsSync } from 'node:fs'
import { prHeads, prRepoName, repoWorkName, stepDiagrams, type Canvas, type Project, type Task, type TaskWork } from '@mag/core'
import type { HunkRef } from '@mag/diff'
import type { FactCanvas, FactView } from '../preload/api'
import { changes, check, hunk, withoutLines, type ChangeSource, type ChangeTarget, type Changes, type Fact } from './core/services/fact/index.ts'
import { diffHunks, diffText, githubDiffHunks, githubDiffText, githubMergeBase, hunkLines, mergeBase, revParse } from './git.ts'

type DiffText = (at: string, base: string, head: string) => Promise<string>

/**
 * The diff text between two commits, fetched once for the last `max` (at, base, head): the review window opens many
 * hunks of one PR, and each would run the whole diff again. Commits never change, so a kept text never goes stale; a
 * failed fetch is not kept.
 */
export function cachedDiffText(fetch: DiffText, max = 8): DiffText {
  const kept = new Map<string, Promise<string>>()
  return (at, base, head) => {
    const key = `${at}\0${base}\0${head}`
    let text = kept.get(key)
    if (text) {
      kept.delete(key)
      kept.set(key, text)
      return text
    }
    text = fetch(at, base, head)
    kept.set(key, text)
    text.catch(() => kept.get(key) === text && kept.delete(key))
    while (kept.size > max) kept.delete(kept.keys().next().value!)
    return text
  }
}

const localDiffText = cachedDiffText(diffText)
const githubText = cachedDiffText(githubDiffText)

/** Changes as the local git checkouts of the project's repositories have them. */
export const localGit: ChangeSource = {
  diffHunks,
  hunkLines: async (at, base, head, ref) => hunkLines(await localDiffText(at, base, head), ref.path, ref),
}

/** Changes as GitHub has them, for a repository without a local checkout: `at` is its owner/repo. */
export const github: ChangeSource = {
  diffHunks: githubDiffHunks,
  hunkLines: async (at, base, head, ref) => hunkLines(await githubText(at, base, head), ref.path, ref),
}

/** Where a review reads its PR: the local checkout of a project repository, else GitHub. */
export const reviewSource = (work: Task): ChangeSource => (work.prReview?.pr.outside ? github : localGit)

/** A review's fact set: its fact diagrams of every type, in the order they were drawn (povnyi-diff-nabir-pov-iazanykh.1). */
export const reviewFacts = (canvases: Canvas[], workId: string) =>
  canvases.filter((c) => c.taskId === workId && !c.stepId && c.role === 'fact' && c.kind === 'diagram' && !!c.diagram)

/** A step's set of a role (its plan, its fact): its diagrams of every type, in the order they were drawn. */
export const stepSet = (canvases: Canvas[], stepId: string, role: 'plan' | 'fact') =>
  stepDiagrams(canvases, stepId).filter((c) => c.role === role && c.kind === 'diagram' && !!c.diagram)

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

/** The changes of a step's PRs at `heads`, in the vocabulary of its plan. */
export async function stepChanges(project: Project, step: Task, heads: Record<string, string>, canvases: Canvas[]): Promise<Changes> {
  return changes(project, await stepTargets(project, step, heads), localGit, stepSet(canvases, step.id, 'plan'))
}

/** The fact of a step's PRs at `heads`: their changes against the step's fact set and plan set. */
export async function stepFact(project: Project, step: Task, heads: Record<string, string>, canvases: Canvas[], changed?: Changes): Promise<Fact> {
  const plans = stepSet(canvases, step.id, 'plan')
  return check(project, changed ?? (await stepChanges(project, step, heads, canvases)), stepSet(canvases, step.id, 'fact'), plans)
}

/** The counts of a fact, as a step records them. */
export function factCounts(fact: Fact): NonNullable<Task['fact']>['counts'] {
  const check = fact.inventoryCheck
  const counts = { match: 0, differs: 0, missing: 0, unplanned: 0, unaccounted: check?.unaccounted.length ?? 0, ungrounded: (check?.ungrounded.length ?? 0) + (check?.otherModule.length ?? 0) + (check?.unknown.length ?? 0) }
  for (const i of fact.comparison.items) counts[i.status]++
  return counts
}

/** A step's (or a review's) fact as it records it. */
export function factRecord(fact: Fact, heads: Record<string, string>): NonNullable<Task['fact']> {
  return { heads, counts: factCounts(fact), blockers: fact.blockers, canvasId: fact.canvas?.id ?? null, at: Date.now() }
}

/** The heads a step's fact is of: its open PRs, else the heads its fact was recorded at (a merged step). */
export function factHeads(step: Task): Record<string, string> {
  const open = prHeads(step.work)
  return Object.keys(open).length ? open : (step.fact?.heads ?? {})
}

const canvasRef = (c: Canvas): FactCanvas => ({ id: c.id, title: c.title, version: c.version })

/**
 * Plan ↔ fact of a step as Diff shows it (T-57.5): its fact at factHeads, compared with its plan diagrams, and its
 * inventory against the hunks. null when the step has no heads.
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
    files: withoutLines(fact.files),
    items: fact.comparison.items,
    blockers: fact.blockers,
    plans: (fact.plan ?? []).map(canvasRef),
    fact: fact.canvas ? canvasRef(fact.canvas) : null,
    set: fact.set.map(canvasRef),
    inventory: fact.inventory ? { units: fact.inventory.units.length, summary: fact.inventory.summary } : null,
    // The blocks' lines stay in the main process, as the hunks' do.
    check: fact.inventoryCheck && { ...fact.inventoryCheck, unaccounted: fact.inventoryCheck.unaccounted.map(({ lines: _, ...b }) => b) },
    warnings: fact.warnings,
    outside: fact.outside,
    at: Date.now(),
  }
}

/**
 * The PR of a review at `head` (default: its head when mag last looked), from where it left its base branch; or, with
 * `since` (the head reviewed last), only what changed after it.
 */
export async function reviewTarget(project: Project, work: Task, head?: string, since?: string): Promise<ChangeTarget> {
  const pr = work.prReview?.pr
  if (!pr) throw new Error(`${work.key} reviews no PR`)
  const name = prRepoName(project, pr)
  const at = head ?? pr.head
  if (pr.outside) return { repo: pr.repo, name, at: pr.repo, base: await githubMergeBase(pr.repo, since ?? pr.base, at), head: at, outside: true }
  if (since) return { repo: pr.repo, name, at: pr.repo, base: since, head: at }
  const from = await revParse(pr.repo, `origin/${pr.base}`).catch(() => revParse(pr.repo, pr.base))
  return { repo: pr.repo, name, at: pr.repo, base: await mergeBase(pr.repo, from, at), head: at }
}

/** The changes of a reviewed PR at `head`. */
export async function reviewChanges(project: Project, work: Task, head?: string): Promise<Changes> {
  return changes(project, [await reviewTarget(project, work, head)], reviewSource(work))
}

/** The fact of a reviewed PR at `head`: its changes against the review's fact set; no plan to compare. */
export async function reviewFact(project: Project, work: Task, canvases: Canvas[], head?: string, changed?: Changes): Promise<Fact> {
  return check(project, changed ?? (await reviewChanges(project, work, head)), reviewFacts(canvases, work.id), null)
}

/** The fact of a review as its page shows it: at the head its fact is of, else the PR's. null before it has a PR. */
export async function reviewFactView(project: Project, work: Task, canvases: Canvas[]): Promise<FactView | null> {
  const pr = work.prReview?.pr
  if (!pr) return null
  const head = work.fact?.heads[pr.repo] ?? pr.head
  return view({ [pr.repo]: head }, await reviewFact(project, work, canvases, head))
}

/** The lines of one hunk of a reviewed PR, between two commits of a FactView. */
export async function reviewHunk(work: Task, repo: string, base: string, head: string, ref: HunkRef): Promise<string[]> {
  if (work.prReview?.pr.repo !== repo) throw new Error(`${work.key} does not review a PR of ${repo}`)
  return hunk(reviewSource(work), repo, base, head, ref)
}

/** The lines of one hunk of a step's PR in `repo` (one of the step's), between two commits of a FactView. */
export async function stepHunk(step: Task, repo: string, base: string, head: string, ref: HunkRef): Promise<string[]> {
  const r = step.work?.repos.find((w) => w.repo === repo)
  if (!r) throw new Error(`${step.key} does not change ${repo}`)
  return hunk(localGit, repoDir(r), base, head, ref)
}
