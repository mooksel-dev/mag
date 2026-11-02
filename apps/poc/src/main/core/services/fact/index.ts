// The fact of code changes (T-57.4, T-58; one service since reviews-ahent-reviuit-pr-timeitiv.1): the files some
// commits change, the fact set a reviewer draws of them (povnyi-diff-nabir-pov-iazanykh.1: linked diagrams, not one),
// and mag's check of it against the files (coverage, grounding), the changed methods, models, logic and dependencies
// (completeness) and, when there is one, the plan (compare). It knows no step: a step's PRs (against its plan) and a
// teammate's PR (no plan: reviews-prybraty-spysok-pr-i.1) are two callers of the same diff.
import { findNode, playbookOf, setRoot, validateLinks, walkArch, type Canvas, type ComponentDiagram, type DNode, type Diagram, type Project } from '@mag/core'
import { changedUnits, compare, completeness, coverage, createDiff, describe, diagramChanges, folderVocabulary, formatComparison, formatCompleteness, formatFiles, grounding, mergeBlockers, parseSignificance, planVocabulary, withLevels, type ChangedUnit, type Comparison, type Completeness, type Coverage, type FileChange, type FileDiff, type Grounding, type HunkRef, type Vocabulary } from '@mag/diff'

/** Where the changes are read from: a local git checkout, later a PR's diff on GitHub. `at` is where it reads a repository. */
export interface ChangeSource {
  /** The files changed between two commits, renames detected, each with its hunks. */
  diffHunks(at: string, base: string, head: string): Promise<FileDiff[]>
  /** The lines of one hunk of a file between two commits. */
  hunkLines(at: string, base: string, head: string, hunk: HunkRef): Promise<string[]>
}

/** One repository's changes: from `base` to `head`, read by the source at `at`. */
export interface ChangeTarget {
  /** The repository's path in the project. */
  repo: string
  name: string
  at: string
  base: string
  head: string
  /**
   * A repository the project has no architecture of (a teammate's PR outside the project, reviews-ahent-reviuit-pr-timeitiv.3):
   * its modules are its folders.
   */
  outside?: boolean
}

export interface FactRepo {
  /** The repository's path. */
  repo: string
  name: string
  baseSha: string
  headSha: string
}

export interface Changes {
  /** One per target, in their order. */
  repos: FactRepo[]
  /** The files changed, of every repository, with their hunks (without their lines). */
  files: FileChange[]
  /** The public methods, models and dependencies the files change (povnyi-diff-nabir-pov-iazanykh.1). */
  units: ChangedUnit[]
  /** Read without the project's architecture: modules by folder (a target outside the project). */
  outside: boolean
}

export interface Fact extends Changes {
  /** The plan set the fact is compared with; null when there is no plan to compare (a teammate's PR). */
  plan: Canvas[] | null
  /** The fact set: its diagrams in the order they were drawn; [] before the review starts one. */
  set: Canvas[]
  /** The root of the fact set; null before the review starts one. */
  canvas: Canvas | null
  /** Plan ↔ fact; empty without a plan. */
  comparison: Comparison
  /** null without a fact set. */
  coverage: Coverage | null
  grounding: Grounding | null
  completeness: Completeness | null
  /** Where the fact set does not hang together: root, links, orphans (validateLinks). */
  warnings: string[]
  blockers: string[]
}

/** A repository outside the project in the plan's modules first, then by its folders. */
function outsideVocabulary(plan: Diagram[], diffs: FileDiff[]): Vocabulary {
  const own = planVocabulary([], plan).modules
  const folders = folderVocabulary(diffs.map((d) => d.path)).modules.filter((m) => !own.some((o) => o.id === m.id))
  return { modules: [...own, ...folders] }
}

/**
 * The files the targets change, each from its base to its head, in the vocabulary of the project's architecture plus
 * the modules the plan adds. A target outside the project: the plan's modules, then its folders.
 */
export async function changes(project: Project, targets: ChangeTarget[], source: ChangeSource, plan: Canvas[] = []): Promise<Changes> {
  const diagrams = plan.map((c) => c.diagram!)
  const architecture = project.architecture?.modules ?? []
  const vocabulary = planVocabulary(architecture, diagrams)
  const repos: FactRepo[] = []
  const files: FileChange[] = []
  const units: ChangedUnit[] = []
  for (const t of targets) {
    repos.push({ repo: t.repo, name: t.name, baseSha: t.base, headSha: t.head })
    const diffs = await source.diffHunks(t.at, t.base, t.head)
    const words = t.outside ? outsideVocabulary(diagrams, diffs) : vocabulary
    const read = await createDiff({ diffHunks: async () => diffs }).changedFiles({ path: t.at, name: t.name }, t.base, t.head, words)
    units.push(...changedUnits(read, t.outside ? [] : architecture, words))
    // The lines served changedUnits; the files go on without them.
    files.push(...read.map((f) => ({ ...f, hunks: f.hunks.map(({ lines: _, ...h }) => h) })))
  }
  return { repos, files, units, outside: targets.some((t) => t.outside) }
}

/** A diagram mag starts a fact set with: `from` is the plan diagram it copies (its links lead to plan ids till saved). */
export interface SeedDiagram {
  from: string | null
  title: string
  diagram: Diagram
  root: boolean
}

/**
 * Where the reviewer starts the fact set (Decision 5): a copy of the whole plan set with its links, its root the
 * plan's root (else its first Component diagram). Without a plan: one Component diagram of the modules that own the
 * changed code, unmarked, to draw the fact from scratch; code no module owns by its folders, so a teammate's PR always
 * has a fact to start from. `of` names what the fact is of (a step's key, a PR). [] when there is nothing to draw.
 */
export function seed(of: string, plan: Canvas[], files: FileChange[], architecture: Project['architecture']): SeedDiagram[] {
  if (plan.length) {
    const root = setRoot(plan) ?? plan.find((c) => c.diagram!.type === 'component') ?? plan[0]
    return plan.map((c) => {
      const diagram = structuredClone(c.diagram!)
      if (diagram.type === 'component') diagram.summary = `Fact of ${of}, started as a copy of its plan "${c.title}": the reviewer revises it under the diff.`
      return { from: c.id, title: c === root ? `${of}: fact` : `${of}: fact — ${c.title}`, diagram, root: c === root }
    })
  }
  const modules: DNode[] = []
  const ids = new Set<string>()
  const take = (n: DNode) => {
    const inner: string[] = []
    walkArch([n], (m) => inner.push(m.id))
    if (inner.some((id) => ids.has(id))) return
    inner.forEach((id) => ids.add(id))
    modules.push(structuredClone(n))
  }
  const code = files.filter((f) => f.kind === 'code')
  for (const id of new Set(code.filter((f) => f.module).map((f) => f.module!))) {
    const arch = findNode(architecture?.modules ?? [], id)
    take({ id, name: arch?.name ?? id, description: arch?.description ?? '', uses: [] })
  }
  for (const m of folderVocabulary(code.filter((f) => !f.module).map((f) => f.path)).modules)
    if (!ids.has(m.id)) take({ id: m.id, name: m.paths[0], description: 'No module of the architecture owns this code.', uses: [], path: m.paths[0] })
  if (!modules.length) return []
  const diagram: ComponentDiagram = { type: 'component', summary: `Fact of ${of}: no plan diagram, the reviewer draws the fact from the diff over these modules.`, modules }
  return [{ from: null, title: `${of}: fact`, diagram, root: true }]
}

/**
 * The fact set against the changed files (coverage, grounding), the changed methods, models, logic and dependencies
 * (completeness) and the plan set (compare), levelled by the playbook's rules, and what keeps the review from merge.
 * `plan` null: nothing to compare with (a teammate's PR), so only the code counts; [] is a step without a plan, where
 * everything on the fact is unplanned.
 */
export function check(project: Project, changed: Changes, set: Canvas[], plan: Canvas[] | null): Fact {
  // The project's architecture says nothing of a repository outside it.
  const architecture = changed.outside ? [] : (project.architecture?.modules ?? [])
  const { repos, files, units } = changed
  const rules = parseSignificance(playbookOf(project).significance)
  const planned = withLevels((plan ?? []).flatMap((c) => diagramChanges(c.diagram!)), rules)
  const diagrams = set.map((c) => c.diagram!)
  const fact = withLevels(diagrams.flatMap(diagramChanges), rules)
  const comparison = plan ? compare(planned, fact, architecture) : { items: [] }
  // Without code to show, no fact set is needed.
  const nothing = !files.some((f) => f.kind === 'code')
  const drawn = set.length > 0
  const cover = drawn ? coverage(files, diagrams) : nothing ? { shown: [], unshown: [] } : null
  const ground = drawn ? grounding(diagrams, files, architecture) : nothing ? { grounded: [], unverified: [] } : null
  const complete = drawn ? completeness(set.map((c) => ({ id: c.id, diagram: c.diagram!, notes: c.notes })), units, architecture) : nothing ? { missing: [] } : null
  const canvas = setRoot(set) ?? set.find((c) => c.diagram!.type === 'component') ?? set[0] ?? null
  return {
    repos, files, units, outside: changed.outside, plan, set, canvas, comparison, coverage: cover, grounding: ground, completeness: complete,
    warnings: drawn ? validateLinks(set) : [],
    blockers: mergeBlockers(comparison, cover, ground, complete),
  }
}

const link = (c: Canvas) => `[${c.title}](canvas:${c.id})`

/**
 * What the reviewer reads of a fact: the changed files, what the fact set does not show, ground or explain, where it
 * does not hang together, and plan ↔ fact when there is a plan to compare with.
 */
export function factReport(fact: Fact, started: number | null): string {
  const plan = fact.plan
  const c = fact.canvas
  const others = fact.set.filter((x) => x !== c)
  const rest = others.length ? ` Other diagrams of the set: ${others.map((x) => `${link(x)} (${x.diagram!.type}, v${x.version})`).join(', ')}.` : ''
  const diagram = !c
    ? fact.files.some((f) => f.kind === 'code') ? 'Fact set: none yet.' : 'Fact set: none, the PRs change no code.'
    : (c.version === started
        ? `Fact set: root ${link(c)} (v${c.version}), ${plan?.length ? "mag's copy of the plan" : 'started by mag'}: nothing on it rests on the PR yet.`
        : `Fact set: root ${link(c)} (v${c.version}), revised.`) + rest
  const outside = fact.outside ? ['Without the project architecture: the repository is outside the project, its modules are its folders (packages).'] : []
  const plans = plan && (plan.length ? plan.map(link).join(', ') : 'none: the step has no plan diagram, so nothing it changes is planned')
  const head = plan ? ['## Plan ↔ fact (mag)', `Plan diagrams: ${plans}.`] : ['## Fact (mag)']
  const out = [...head, diagram, ...outside, '', '### Changed files', ...fact.repos.map((r) => formatFiles(r.name, r.baseSha, r.headSha, fact.files.filter((f) => f.repo === r.name)))]
  const unshown = fact.coverage?.unshown ?? []
  if (unshown.length) out.push('', `### Changed code the fact diagram does not show (${unshown.length})`, ...unshown.map((f) => `- ${f.repo}:${f.path} (${f.module ?? 'no module'})`))
  const unverified = fact.grounding?.unverified ?? []
  if (unverified.length) out.push('', `### Lines of the fact that do not rest on the PR (${unverified.length})`, ...unverified.map((u) => `- ${describe(u.change)}: ${u.reason}${u.files.length ? ` (${u.files.join(', ')})` : ''}`))
  const missing = fact.completeness ? formatCompleteness(fact.completeness) : ''
  if (missing) out.push('', '### Changed methods, models, logic and dependencies', missing)
  if (fact.warnings.length) out.push('', `### The fact set does not hang together (${fact.warnings.length})`, ...fact.warnings.map((w) => `- ${w}`))
  if (plan) out.push('', '### Plan ↔ fact', formatComparison(fact.comparison, fact.blockers))
  else out.push('', fact.blockers.length ? `### The fact is not complete yet\n${fact.blockers.map((b) => `  - ${b}`).join('\n')}` : '### The fact is complete: it shows every changed code file, method, model, logic and dependency and rests on the PR.')
  return out.join('\n')
}

const SHA = /^[0-9a-f]{7,64}$/

/** The lines of one hunk between two commits of a repository the source reads at `at`. */
export async function hunk(source: ChangeSource, at: string, base: string, head: string, ref: HunkRef): Promise<string[]> {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('base and head must be commit shas')
  return source.hunkLines(at, base, head, ref)
}
