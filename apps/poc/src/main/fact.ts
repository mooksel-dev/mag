// The fact of a step's PRs against its plan (T-57.4, reworked in T-58): the reviewer draws the fact diagram from the
// diff as a revision of the plan; mag checks it against the changed files (coverage, grounding) and the plan (compare),
// and sets the threshold for a merge verdict.
import { existsSync } from 'node:fs'
import { findNode, prHeads, repoWorkName, stepDiagrams, playbookOf, walkArch, type Canvas, type ComponentDiagram, type DNode, type Project, type Task, type TaskWork } from '@mag/core'
import { compare, coverage, createDiff, describe, diagramChanges, formatComparison, formatFiles, grounding, mergeBlockers, parseSignificance, planVocabulary, withLevels, type Comparison, type Coverage, type FileChange, type Grounding, type HunkRef } from '@mag/diff'
import type { FactCanvas, FactView } from '../preload/api'
import { diffHunks, diffText, hunkLines, mergeBase, revParse } from './git.ts'

export const diff = createDiff({ diffHunks })

export interface FactRepo {
  /** The repository's path. */
  repo: string
  name: string
  baseSha: string
  headSha: string
}

export interface Fact {
  /** One per repository with a head, in the step's order. */
  repos: FactRepo[]
  /** The files the PRs change, of every repository. */
  files: FileChange[]
  /** The step's plan diagrams. */
  plans: Canvas[]
  /** The step's fact diagram; null before the review starts one. */
  canvas: Canvas | null
  comparison: Comparison
  /** null without a fact diagram. */
  coverage: Coverage | null
  grounding: Grounding | null
  blockers: string[]
}

/** A step's Component diagrams of a role, in the order they were drawn. */
export const stepComponents = (canvases: Canvas[], stepId: string, role: 'plan' | 'fact') =>
  stepDiagrams(canvases, stepId).filter((c) => c.role === role && c.diagram?.type === 'component')

/** Where git runs for a repository of a step: a worktree is removed once merged; the main checkout shares its objects. */
const repoDir = (r: TaskWork['repos'][number]) => (!r.local && existsSync(r.worktree) ? r.worktree : r.repo)

/**
 * The files a step's PRs at `heads` (repository path → head commit) change, each against where it left the base
 * branch, in the vocabulary of the architecture plus the modules the plan adds.
 */
export async function stepFiles(project: Project, step: Task, heads: Record<string, string>, plans: Canvas[]): Promise<{ repos: FactRepo[]; files: FileChange[] }> {
  const work = step.work
  if (!work) throw new Error(`${step.key} has no work`)
  const vocabulary = planVocabulary(project.architecture?.modules ?? [], plans.map((c) => c.diagram!))
  const repos: FactRepo[] = []
  const files: FileChange[] = []
  for (const r of work.repos) {
    const head = heads[r.repo]
    if (!head) continue
    const dir = repoDir(r)
    const from = await revParse(dir, `origin/${project.baseBranch}`).catch(() => revParse(dir, project.baseBranch))
    const base = await mergeBase(dir, from, head)
    const name = repoWorkName(work, r)
    repos.push({ repo: r.repo, name, baseSha: base, headSha: head })
    files.push(...(await diff.changedFiles({ path: dir, name }, base, head, vocabulary)))
  }
  return { repos, files }
}

/** The step's fact diagram: the one its fact names, else the first one placed in its fact. */
export function factCanvas(step: Task, canvases: Canvas[]): Canvas | null {
  const facts = stepComponents(canvases, step.id, 'fact')
  return facts.find((c) => c.id === step.fact?.canvasId) ?? facts[0] ?? null
}

/**
 * The fact of a step's PRs at `heads`: its changed files, its fact diagram against them (coverage, grounding) and
 * against its plan diagrams (compare), levelled by the playbook's rules, and what keeps the review from merge.
 */
export async function stepFact(project: Project, step: Task, heads: Record<string, string>, canvases: Canvas[], changed?: Pick<Fact, 'repos' | 'files'>): Promise<Fact> {
  const architecture = project.architecture?.modules ?? []
  const plans = stepComponents(canvases, step.id, 'plan')
  const canvas = factCanvas(step, canvases)
  const { repos, files } = changed ?? (await stepFiles(project, step, heads, plans))
  const rules = parseSignificance(playbookOf(project).significance)
  const plan = withLevels(plans.flatMap((c) => diagramChanges(c.diagram!)), rules)
  const fact = canvas ? withLevels(diagramChanges(canvas.diagram!), rules) : []
  const comparison = compare(plan, fact, architecture)
  // Without code to show, no fact diagram is needed.
  const nothing = !files.some((f) => f.kind === 'code')
  const cover = canvas ? coverage(files, canvas.diagram!, architecture) : nothing ? { shown: [], unshown: [] } : null
  const ground = canvas ? grounding(canvas.diagram!, files, architecture) : nothing ? { grounded: [], unverified: [] } : null
  return { repos, files, plans, canvas, comparison, coverage: cover, grounding: ground, blockers: mergeBlockers(comparison, cover, ground) }
}

/**
 * Where the reviewer starts the fact diagram (Decision 9): a copy of the step's plan diagram (several: their modules
 * together, each id once). Without a plan: the modules that own the changed code, unmarked, to draw the fact from
 * scratch. null when there is nothing to draw.
 */
export function factSeed(step: Task, plans: Canvas[], files: FileChange[], architecture: Project['architecture']): ComponentDiagram | null {
  const modules: DNode[] = []
  const ids = new Set<string>()
  const take = (n: DNode) => {
    const inner: string[] = []
    walkArch([n], (m) => inner.push(m.id))
    if (inner.some((id) => ids.has(id))) return
    inner.forEach((id) => ids.add(id))
    modules.push(structuredClone(n))
  }
  for (const c of plans) for (const n of (c.diagram as ComponentDiagram).modules) take(n)
  if (plans.length) {
    const titles = plans.map((c) => `"${c.title}"`).join(', ')
    return { type: 'component', summary: `Fact of ${step.key}, started as a copy of its plan ${titles}: the reviewer revises it under the diff.`, modules }
  }
  for (const id of new Set(files.filter((f) => f.kind === 'code' && f.module).map((f) => f.module!))) {
    const arch = findNode(architecture?.modules ?? [], id)
    take({ id, name: arch?.name ?? id, description: arch?.description ?? '', uses: [] })
  }
  if (!modules.length) return null
  return { type: 'component', summary: `Fact of ${step.key}: no plan diagram, the reviewer draws the fact from the diff over these modules.`, modules }
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

const link = (c: Canvas) => `[${c.title}](canvas:${c.id})`

/** What the reviewer reads of a fact: the changed files, what the fact diagram does not show or ground, plan ↔ fact. */
export function factReport(fact: Fact, started: number | null): string {
  const plans = fact.plans.length ? fact.plans.map(link).join(', ') : 'none: the step has no plan diagram, so nothing it changes is planned'
  const c = fact.canvas
  const diagram = !c
    ? 'Fact diagram: none, the PRs change no code.'
    : c.version === started
      ? `Fact diagram: ${link(c)} (v${c.version}), mag's copy of the plan: nothing on it rests on the PR yet.`
      : `Fact diagram: ${link(c)} (v${c.version}), revised.`
  const out = [`## Plan ↔ fact (mag)`, `Plan diagrams: ${plans}.`, diagram, '', '### Changed files', ...fact.repos.map((r) => formatFiles(r.name, r.baseSha, r.headSha, fact.files.filter((f) => f.repo === r.name)))]
  const unshown = fact.coverage?.unshown ?? []
  if (unshown.length) out.push('', `### Changed code the fact diagram does not show (${unshown.length})`, ...unshown.map((f) => `- ${f.repo}:${f.path} (${f.module ?? 'no module'})`))
  const unverified = fact.grounding?.unverified ?? []
  if (unverified.length) out.push('', `### Lines of the fact that do not rest on the PR (${unverified.length})`, ...unverified.map((u) => `- ${describe(u.change)}: ${u.reason}${u.files.length ? ` (${u.files.join(', ')})` : ''}`))
  out.push('', '### Plan ↔ fact', formatComparison(fact.comparison, fact.blockers))
  return out.join('\n')
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
  const fact = await stepFact(project, step, heads, canvases)
  return {
    heads,
    repos: fact.repos,
    files: fact.files,
    items: fact.comparison.items,
    blockers: fact.blockers,
    plans: fact.plans.map(canvasRef),
    fact: fact.canvas ? canvasRef(fact.canvas) : null,
    coverage: fact.coverage,
    unverified: fact.grounding?.unverified ?? [],
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
